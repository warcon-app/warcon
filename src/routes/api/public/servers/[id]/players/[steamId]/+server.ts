// Public career JSON for one player, over the organisation's servers with public leaderboards.
// Its last matches leave out the ones the player played in the game's anonymous mode.
import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, param, route } from '$lib/server/http';
import {
	limitPublicReads,
	publicHeaders,
	publicOrgServers,
	requirePublicServer
} from '$lib/server/public';
import { lastNameOf, loadCareer } from '$lib/server/leaderboards';

export const GET = route(async (event) => {
	const env = getEnv();
	limitPublicReads(event.request);
	const ps = await requirePublicServer(env, param(event, 'id'), 'leaderboards');
	const steamId = param(event, 'steamId');
	if (!/^\d{17}$/.test(steamId)) throw new ApiError(404, 'Not found.', 'not_found');
	const orgServers = await publicOrgServers(env, ps.org, 'leaderboards');
	const ids = orgServers.map((s) => s.id);
	// Never seen here: a 404 before the career, which reads the boards, is started.
	const name = await lastNameOf(env, ids, steamId);
	if (!name) throw new ApiError(404, 'Not found.', 'not_found');
	const career = await loadCareer(env, {
		serverId: ps.server.id,
		orgId: ps.org.id,
		ids,
		nameOf: new Map(orgServers.map((s) => [s.id, s.name])),
		steamId,
		publicView: true
	});
	return apiJson({ ok: true, player: { steamId, name }, career }, 200, publicHeaders(30));
});
