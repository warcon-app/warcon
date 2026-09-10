// Server-sent events: every observation of the requested servers as it happens, plus trigger
// deliveries. While a browser holds this stream open the servers count as watched, which moves
// them to the fastest observation tier.
import { getEnv } from '$lib/server/env';
import { ApiError } from '$lib/server/http';
import { accessibleServers, requireUser } from '$lib/server/access';
import { gateway } from '$lib/server/gateway';

const INTEREST_MS = 5000;
const PING_MS = 15_000;

export const GET = async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const mine = new Set((await accessibleServers(env, user)).map((s) => s.id));
	const asked = (event.url.searchParams.get('ids') || '').split(',').filter(Boolean);
	const ids = (asked.length ? asked : [...mine]).filter((id) => mine.has(id));
	if (!ids.length) throw new ApiError(400, 'No servers to watch.');
	const wanted = new Set(ids);
	const encoder = new TextEncoder();
	let unsubscribe = () => {};
	let interestTimer: ReturnType<typeof setInterval> | undefined;
	let pingTimer: ReturnType<typeof setInterval> | undefined;
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const send = (name: string, data: unknown) => {
				try {
					controller.enqueue(encoder.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
				} catch {
					/* closed */
				}
			};
			gateway().interest(ids);
			for (const v of (await gateway().live(env, ids)).values()) send('live', v);
			unsubscribe = gateway().subscribe((e) => {
				if (e.type === 'live' && wanted.has(e.live.serverId)) send('live', e.live);
				else if (e.type === 'outbox' && wanted.has(e.serverId)) send('outbox', e);
			});
			interestTimer = setInterval(() => gateway().interest(ids), INTEREST_MS);
			pingTimer = setInterval(() => {
				try {
					controller.enqueue(encoder.encode(': ping\n\n'));
				} catch {
					/* closed */
				}
			}, PING_MS);
		},
		cancel() {
			unsubscribe();
			clearInterval(interestTimer);
			clearInterval(pingTimer);
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
