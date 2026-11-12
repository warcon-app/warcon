// Public match page JSON: the match, its lines, timeline and awards, and one page of its kills
// as the public live page shows them (names and factions, never a SteamID), newest first, paged
// by `before` and `beforeTime`. A player who played the match in the game's anonymous mode is in
// all of it under their hidden name, their line's `steamId` a stand-in (publicMatch). 404 unless
// leaderboards are on; rate limited per address.
import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, int, param, route } from '$lib/server/http';
import {
	limitPublicReads,
	publicHeaders,
	publicKill,
	publicMatch,
	requirePublicServer
} from '$lib/server/public';
import { loadMatch, MATCH_KILLS_PAGE, matchWindow, parseMatchId } from '$lib/server/matches';
import { recentKills } from '$lib/server/feed';
import { EMPTY_FILTER } from '$lib/kills';

export const GET = route(async (event) => {
	const env = getEnv();
	limitPublicReads(event.request);
	const ps = await requirePublicServer(env, param(event, 'id'), 'leaderboards');
	const id = parseMatchId(param(event, 'matchId'));
	const found = id === null ? null : await loadMatch(env, ps.server.id, id);
	if (!found || id === null) throw new ApiError(404, 'No such match here.', 'not_found');
	const { view, hidden } = publicMatch(found);
	const raw = event.url.searchParams.get('before');
	const ts = raw ? new Date(raw) : null;
	if (ts && Number.isNaN(ts.getTime())) throw new ApiError(400, 'before must be an ISO timestamp.');
	const rawTime = event.url.searchParams.get('beforeTime');
	const eventTime = rawTime !== null && rawTime !== '' ? Number(rawTime) : null;
	if (eventTime !== null && !Number.isFinite(eventTime))
		throw new ApiError(400, 'beforeTime must be a number.');
	const limit = int(event.url.searchParams.get('limit'), MATCH_KILLS_PAGE, 1, 200);
	const window = await matchWindow(env, ps.server.id, id);
	const kills = window
		? await recentKills(
				env,
				ps.server.id,
				ts ? { ts, eventTime } : null,
				limit,
				EMPTY_FILTER,
				window
			)
		: [];
	return apiJson(
		{
			ok: true,
			...view,
			feed: kills.map((k) => publicKill(k, hidden)),
			more: kills.length === limit
		},
		200,
		publicHeaders(30)
	);
});
