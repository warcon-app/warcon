// The public leaderboard: 404 unless leaderboards are on for the server. The org scope covers
// only the organisation's servers whose leaderboards are public too.
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import {
	publicHeading,
	publicLoad,
	publicOrgServers,
	requirePublicServer
} from '$lib/server/public';
import { loadBoard } from '$lib/server/leaderboards';
import { parseBoardQuery, PUBLIC_MAX_PAGE } from '$lib/leaderboard';

export const load: PageServerLoad = (event) =>
	publicLoad(event, async () => {
		const env = getEnv();
		const ps = await requirePublicServer(env, event.params.id, 'leaderboards');
		const q = parseBoardQuery(event.url.searchParams, PUBLIC_MAX_PAGE);
		const orgServers = await publicOrgServers(env, ps.org, 'leaderboards');
		const ids = q.scope === 'org' ? orgServers.map((s) => s.id) : [ps.server.id];
		return {
			board: { ...(await loadBoard(env, ids, q, { public: true })), maxPage: PUBLIC_MAX_PAGE },
			orgScope: orgServers.length > 1,
			heading: publicHeading(ps)
		};
	});
