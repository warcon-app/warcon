// A public career page: 404 unless leaderboards are on for the server. Steam personas come from
// the cache only, so viewers can never spend the site's Steam quota. Its last matches leave out
// the ones the player played in the game's anonymous mode (loadCareer's publicView), and its most
// killed and nemeses whoever is in that mode (publicCombat).
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import {
	publicCombat,
	publicHeading,
	publicLoad,
	publicOrgServers,
	requirePublicServer
} from '$lib/server/public';
import { loadCareer, lastNameOf } from '$lib/server/leaderboards';
import { combatSummary } from '$lib/server/players';
import { cachedProfiles } from '$lib/server/steam';
import { ApiError } from '$lib/server/http';

export const load: PageServerLoad = (event) =>
	publicLoad(event, async () => {
		const env = getEnv();
		const ps = await requirePublicServer(env, event.params.id, 'leaderboards');
		const steamId = event.params.steamId;
		if (!/^\d{17}$/.test(steamId)) throw new ApiError(404, 'Not found.', 'not_found');
		const orgServers = await publicOrgServers(env, ps.org, 'leaderboards');
		const ids = orgServers.map((s) => s.id);
		// A player these servers never saw is a 404 before the career reads anything: any 17
		// digits reach this page, and the career reads the boards.
		const name = await lastNameOf(env, ids, steamId);
		if (!name) throw new ApiError(404, 'Not found.', 'not_found');
		const [career, profiles, combat] = await Promise.all([
			loadCareer(env, {
				serverId: ps.server.id,
				orgId: ps.org.id,
				ids,
				nameOf: new Map(orgServers.map((s) => [s.id, s.name])),
				steamId,
				publicView: true
			}),
			cachedProfiles(env, [steamId]),
			combatSummary(env, ids, steamId).then((combat) => publicCombat(env, ids, combat))
		]);
		const steam = profiles.get(steamId);
		return {
			career,
			combat,
			player: { steamId, name, avatar: steam?.avatar ?? '' },
			multiServer: orgServers.length > 1,
			heading: publicHeading(ps)
		};
	});
