// The gateway for a web process whose worker runs elsewhere: every call is an HTTP request to
// the worker's relay, and one long-lived event stream from it is re-emitted into this process's
// event bus so the SSE route and pages work exactly as in the single-process role.
import type { Env } from './env';
import type { OrgRow, ServerRow } from './access';
import { ApiError } from './http';
import { GameError } from './rcon';
import { emit, subscribe, type WarconEvent } from './events';
import type { Gateway } from './gateway';
import type { Priority } from './dispatcher';
import type { LiveView, ListSyncSummary } from '$lib/types';
import type { SyncResult } from './lists-sync';
import type { PollerStats } from './poller';
import { RELAY_PREFIX, type RelayError } from './relay';

const TIMEOUT_MS = 30_000;

function rethrow(e: RelayError): never {
	if (e.kind === 'game') throw new GameError(e.status, e.message, e.code, e.body ?? null);
	if (e.kind === 'api') throw new ApiError(e.status, e.message, e.code);
	throw new ApiError(502, `Worker: ${e.message}`, 'worker_error');
}

async function call<T>(env: Env, path: string, body?: unknown, method = 'POST'): Promise<T> {
	const url = `${env.RELAY_URL!.replace(/\/$/, '')}${RELAY_PREFIX}${path}`;
	let res: Response;
	try {
		res = await fetch(url, {
			method,
			headers: {
				authorization: `Bearer ${env.RELAY_SECRET}`,
				'content-type': 'application/json'
			},
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(TIMEOUT_MS)
		});
	} catch (err) {
		throw new ApiError(
			503,
			`The worker is not reachable (${err instanceof Error ? err.message : String(err)}).`,
			'worker_unavailable'
		);
	}
	const data = (await res.json().catch(() => null)) as {
		ok?: boolean;
		error?: RelayError;
		result?: T;
	} | null;
	if (!res.ok || !data?.ok)
		rethrow(
			data?.error ?? {
				kind: 'other',
				status: res.status,
				message: `Worker answered ${res.status}.`
			}
		);
	return data.result as T;
}

/** Keeps one event stream from the worker open, re-emitting everything locally. */
function consumeEvents(env: Env): void {
	let backoff = 1000;
	const loop = async () => {
		for (;;) {
			try {
				const res = await fetch(`${env.RELAY_URL!.replace(/\/$/, '')}${RELAY_PREFIX}/events`, {
					headers: { authorization: `Bearer ${env.RELAY_SECRET}`, accept: 'text/event-stream' }
				});
				if (!res.ok || !res.body) throw new Error(`worker answered ${res.status}`);
				backoff = 1000;
				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buf = '';
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					let i: number;
					while ((i = buf.indexOf('\n\n')) >= 0) {
						const frame = buf.slice(0, i);
						buf = buf.slice(i + 2);
						const data = frame
							.split('\n')
							.filter((l) => l.startsWith('data:'))
							.map((l) => l.slice(5).trim())
							.join('\n');
						if (data) {
							try {
								emit(JSON.parse(data) as WarconEvent);
							} catch {
								/* malformed frame */
							}
						}
					}
				}
			} catch (err) {
				console.warn('[warcon] worker event stream:', err instanceof Error ? err.message : err);
			}
			await new Promise((r) => setTimeout(r, backoff));
			backoff = Math.min(backoff * 2, 15_000);
		}
	};
	void loop();
}

export function connectRemoteGateway(env: Env): Gateway {
	consumeEvents(env);
	return {
		run(env, server, action, params, priority?: Priority) {
			return call<unknown>(env, '/run', { serverId: server.id, action, params, priority });
		},
		async live(env, ids) {
			const r = await call<Record<string, LiveView>>(
				env,
				`/live?ids=${encodeURIComponent(ids.join(','))}`,
				undefined,
				'GET'
			);
			return new Map(Object.entries(r));
		},
		interest(ids) {
			void call(env, '/interest', { ids }).catch(() => {});
		},
		observeSoon(serverId) {
			void call(env, '/observe-soon', { serverId }).catch(() => {});
		},
		observeNow(env, serverId) {
			return call<LiveView | null>(env, '/observe-now', { serverId });
		},
		syncOrg(env, org: OrgRow) {
			return call<ListSyncSummary>(env, '/sync-org', { orgId: org.id });
		},
		syncServer(env, server: ServerRow, org: OrgRow, waitMs) {
			return call<SyncResult>(env, '/sync-server', { serverId: server.id, waitMs });
		},
		async settingsChanged(env) {
			await call(env, '/settings-changed', {});
		},
		subscribe,
		health(env) {
			return call<PollerStats>(env, '/health', undefined, 'GET');
		}
	};
}
