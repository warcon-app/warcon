// The public match history: 404 unless leaderboards are on for the server. One page at a time,
// from the address's `page`, so a page can be linked.
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { publicHeading, publicLoad, requirePublicServer } from '$lib/server/public';
import { matchListView, PUBLIC_MATCHES_PAGE } from '$lib/server/matches';
import { parsePage } from '$lib/matches';

export const load: PageServerLoad = (event) =>
	publicLoad(event, async () => {
		const env = getEnv();
		const ps = await requirePublicServer(env, event.params.id, 'matches');
		const page = parsePage(event.url.searchParams.get('page'));
		return {
			list: await matchListView(env, ps.server.id, page, PUBLIC_MATCHES_PAGE),
			heading: publicHeading(ps)
		};
	});
