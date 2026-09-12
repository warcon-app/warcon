// Cash-in-play samples since a moment (default: the last hour), for the dashboard's live chart
// to start from instead of an empty axis after every page load.
import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, param, route } from '$lib/server/http';
import { requireServerCap } from '$lib/server/access';
import { loadCashSince } from '$lib/server/analytics';

const MAX_LOOKBACK_MS = 24 * 3600000;

export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerCap(env, event.locals, param(event, 'id'), 'server.view');
	const raw = event.url.searchParams.get('since');
	let since = raw ? new Date(raw) : new Date(Date.now() - 3600000);
	if (Number.isNaN(since.getTime())) throw new ApiError(400, 'since must be an ISO timestamp.');
	if (Date.now() - since.getTime() > MAX_LOOKBACK_MS)
		since = new Date(Date.now() - MAX_LOOKBACK_MS);
	return apiJson({
		ok: true,
		since: since.toISOString(),
		points: await loadCashSince(env, server.id, since)
	});
});
