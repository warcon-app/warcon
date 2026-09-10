// Server-sent events: every observation of the requested servers as it happens, plus trigger
// deliveries. While a browser holds this stream open the servers count as watched, which moves
// them to the fastest observation tier. Streams live a few minutes at most: the browser
// reconnects on its own, and every reconnection is authenticated and access-checked afresh, so a
// revoked user or grant loses the stream promptly.
import { getEnv } from '$lib/server/env';
import { ApiError } from '$lib/server/http';
import { accessibleServers, requireUser } from '$lib/server/access';
import { gateway } from '$lib/server/gateway';

const INTEREST_MS = 5000;
const PING_MS = 15_000;
const LIFETIME_MS = 5 * 60_000;
/** Close a consumer that has this many events buffered and unread (a stalled tab, a broken proxy). */
const MAX_BACKLOG = 64;

export const GET = async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const mine = new Set((await accessibleServers(env, user)).map((s) => s.id));
	const asked = (event.url.searchParams.get('ids') || '').split(',').filter(Boolean);
	const ids = (asked.length ? asked : [...mine]).filter((id) => mine.has(id));
	if (!ids.length) throw new ApiError(400, 'No servers to watch.');
	const wanted = new Set(ids);
	const encoder = new TextEncoder();
	let closed = false;
	let unsubscribe = () => {};
	const timers: ReturnType<typeof setInterval | typeof setTimeout>[] = [];
	let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null;
	const cleanup = () => {
		if (closed) return;
		closed = true;
		unsubscribe();
		for (const t of timers) clearTimeout(t);
		try {
			controllerRef?.close();
		} catch {
			/* already closed */
		}
	};
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			controllerRef = controller;
			const send = (name: string, data: unknown) => {
				if (closed) return;
				if ((controller.desiredSize ?? 1) < -MAX_BACKLOG) return cleanup();
				try {
					controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					cleanup();
				}
			};
			gateway().interest(ids);
			const initial = await gateway().live(env, ids);
			if (closed) return; // cancelled while the first read was pending
			for (const v of initial.values()) send('live', v);
			unsubscribe = gateway().subscribe((e) => {
				if (e.type === 'live' && wanted.has(e.live.serverId)) send('live', e.live);
				else if (e.type === 'outbox' && wanted.has(e.serverId)) send('outbox', e);
			});
			timers.push(setInterval(() => gateway().interest(ids), INTEREST_MS));
			timers.push(
				setInterval(() => {
					if (closed) return;
					try {
						controller.enqueue(encoder.encode(': ping\n\n'));
					} catch {
						cleanup();
					}
				}, PING_MS)
			);
			timers.push(setTimeout(cleanup, LIFETIME_MS));
		},
		cancel() {
			cleanup();
		}
	});
	event.setHeaders({ 'x-accel-buffering': 'no' });
	return new Response(stream, {
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive'
		}
	});
};
