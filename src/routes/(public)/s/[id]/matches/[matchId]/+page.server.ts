// A public match page: 404 unless leaderboards are on for the server and the match is one of
// its that ended. The first page of its kills is rendered here; older ones come from the JSON.
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { ApiError } from '$lib/server/http';
import { publicHeading, publicKill, publicLoad, requirePublicServer } from '$lib/server/public';
import { loadMatch, MATCH_KILLS_PAGE, matchWindow, parseMatchId } from '$lib/server/matches';
import { recentKills } from '$lib/server/feed';
import { EMPTY_FILTER } from '$lib/kills';

export const load: PageServerLoad = (event) =>
	publicLoad(event, async () => {
		const env = getEnv();
		const ps = await requirePublicServer(env, event.params.id, 'matches');
		const id = parseMatchId(event.params.matchId);
		const view = id === null ? null : await loadMatch(env, ps.server.id, id);
		if (!view || id === null) throw new ApiError(404, 'Not found.', 'not_found');
		const window = await matchWindow(env, ps.server.id, id);
		const kills = window
			? await recentKills(env, ps.server.id, null, MATCH_KILLS_PAGE, EMPTY_FILTER, window)
			: [];
		return {
			match: view,
			feed: kills.map(publicKill),
			more: kills.length === MATCH_KILLS_PAGE,
			heading: publicHeading(ps)
		};
	});
