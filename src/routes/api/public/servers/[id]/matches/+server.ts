// Public match history JSON: the same pages as /s/<id>/matches, twenty a page, by `page`. 404
// unless leaderboards are on; rate limited per address.
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { limitPublicReads, publicHeaders, requirePublicServer } from '$lib/server/public';
import { matchListView, PUBLIC_MATCHES_PAGE } from '$lib/server/matches';
import { parsePage } from '$lib/matches';

export const GET = route(async (event) => {
	const env = getEnv();
	limitPublicReads(event.request);
	const ps = await requirePublicServer(env, param(event, 'id'), 'matches');
	const page = parsePage(event.url.searchParams.get('page'));
	return apiJson(
		{ ok: true, ...(await matchListView(env, ps.server.id, page, PUBLIC_MATCHES_PAGE)) },
		200,
		publicHeaders(30)
	);
});
