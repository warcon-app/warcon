// Every event accepted by the game feed, newest first. Unlike /kills this includes unknown event
// types and incomplete killed events, with the original JSON exactly as it was received.
import { getEnv } from '$lib/server/env';
import { requireServerCap } from '$lib/server/access';
import { countFeedEvents, feedSetup, recentFeedEvents } from '$lib/server/feed';
import { ApiError, apiJson, int, param, route, str } from '$lib/server/http';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerCap(env, event.locals, param(event, 'id'), 'server.view');
	const raw = event.url.searchParams.get('before');
	const ts = raw ? new Date(raw) : null;
	if (ts && Number.isNaN(ts.getTime())) throw new ApiError(400, 'before must be an ISO timestamp.');
	const beforeId = str(event.url.searchParams.get('beforeId'), 64);
	if (ts && !beforeId) throw new ApiError(400, 'beforeId is required with before.');
	const before = ts ? { ts, eventId: beforeId } : null;
	const eventType = str(event.url.searchParams.get('type'), 64);
	const limit = int(event.url.searchParams.get('limit'), 50, 1, 200);
	const [setup, events, total] = await Promise.all([
		feedSetup(env, server, false),
		recentFeedEvents(env, server.id, before, limit, eventType),
		event.url.searchParams.get('count') === '1' ? countFeedEvents(env, server.id, eventType) : null
	]);
	return apiJson({
		ok: true,
		configured: setup.configured,
		feedAt: setup.feedAt,
		events,
		total
	});
});
