// The worker process: owns every game request (observation, trigger delivery, commands relayed
// from the web), and serves the relay on WORKER_PORT. Framework-free: bundled by
// scripts/build-worker.ts with $env and $app shims, never through SvelteKit.
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { getOrg, getServer } from '$lib/server/access';
import { ApiError } from '$lib/server/http';
import { setGateway } from '$lib/server/gateway';
import { localGateway } from '$lib/server/gateway-local';
import { loadSettings } from '$lib/server/settings';
import { pollerStats, startPoller, stopPoller } from '$lib/server/poller';
import { subscribe } from '$lib/server/events';
import { organizations } from '$lib/server/db/schema';
import { RELAY_PREFIX, serializeError } from '$lib/server/relay';
import type { Priority } from '$lib/server/dispatcher';

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
const ok = (result: unknown) => json({ ok: true, result });
const fail = (err: unknown) => {
	const e = serializeError(err);
	return json({ ok: false, error: e }, e.kind === 'other' ? 500 : 200);
};

export function startWorker(env: Env, label = 'worker'): ReturnType<typeof Bun.serve> {
	setGateway(localGateway);
	startPoller(env, label);
	const port = Number(env.WORKER_PORT) || 7700;
	const server = Bun.serve({
		port,
		hostname: '0.0.0.0',
		idleTimeout: 0,
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === '/health' && req.method === 'GET')
				return json({ ok: true, service: 'warcon-worker', worker: await pollerStats() });
			if (!url.pathname.startsWith(RELAY_PREFIX + '/')) return json({ ok: false }, 404);
			if (req.headers.get('authorization') !== `Bearer ${env.RELAY_SECRET}`)
				return json(
					{ ok: false, error: { kind: 'api', status: 401, message: 'Bad relay secret.' } },
					401
				);
			try {
				return await relay(env, url.pathname.slice(RELAY_PREFIX.length), url, req);
			} catch (err) {
				return fail(err);
			}
		}
	});
	console.log(`[warcon] worker relay on :${port}`);
	return server;
}

async function relay(env: Env, path: string, url: URL, req: Request): Promise<Response> {
	const body =
		req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
	const serverOf = async (id: unknown) => {
		const row = await getServer(env, String(id ?? ''));
		if (!row) throw new ApiError(404, 'Server not found.', 'not_found');
		return row;
	};
	switch (path) {
		case '/health':
			return ok(await pollerStats());
		case '/run': {
			const server = await serverOf(body.serverId);
			const priority = (typeof body.priority === 'number' ? body.priority : 0) as Priority;
			return ok(
				await localGateway.run(
					env,
					server,
					String(body.action),
					(body.params as Record<string, unknown>) ?? {},
					priority
				)
			);
		}
		case '/live': {
			const ids = (url.searchParams.get('ids') || '').split(',').filter(Boolean);
			return ok(Object.fromEntries(await localGateway.live(env, ids)));
		}
		case '/interest':
			localGateway.interest(Array.isArray(body.ids) ? body.ids.map(String) : []);
			return ok(null);
		case '/observe-soon':
			localGateway.observeSoon(String(body.serverId));
			return ok(null);
		case '/observe-now':
			return ok(await localGateway.observeNow(env, String(body.serverId)));
		case '/sync-org': {
			const org = await getOrg(env, String(body.orgId));
			if (!org) throw new ApiError(404, 'Organisation not found.', 'not_found');
			return ok(await localGateway.syncOrg(env, org));
		}
		case '/sync-server': {
			const server = await serverOf(body.serverId);
			const [org] = await env.db
				.select()
				.from(organizations)
				.where(eq(organizations.id, server.orgId))
				.limit(1);
			if (!org) throw new ApiError(404, 'Organisation not found.', 'not_found');
			return ok(await localGateway.syncServer(env, server, org, Number(body.waitMs) || 0));
		}
		case '/settings-changed':
			await loadSettings(env);
			return ok(null);
		case '/triggers-changed':
			localGateway.triggersChanged(String(body.serverId));
			return ok(null);
		case '/boards-changed':
			localGateway.boardsChanged();
			return ok(null);
		case '/events': {
			const encoder = new TextEncoder();
			let unsubscribe = () => {};
			let ping: ReturnType<typeof setInterval> | undefined;
			const stream = new ReadableStream<Uint8Array>({
				start(controller) {
					const send = (s: string) => {
						// A web process that stopped reading is cut off rather than buffered without end.
						if ((controller.desiredSize ?? 1) < -4096) {
							unsubscribe();
							clearInterval(ping);
							try {
								controller.close();
							} catch {
								/* closed */
							}
							return;
						}
						try {
							controller.enqueue(encoder.encode(s));
						} catch {
							/* closed */
						}
					};
					unsubscribe = subscribe((e) => send(`data: ${JSON.stringify(e)}\n\n`));
					ping = setInterval(() => send(': ping\n\n'), 15_000);
				},
				cancel() {
					unsubscribe();
					clearInterval(ping);
				}
			});
			return new Response(stream, {
				headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }
			});
		}
		default:
			throw new ApiError(404, `Unknown relay route ${path}.`, 'not_found');
	}
}

export async function stopWorker(): Promise<void> {
	await stopPoller();
}
