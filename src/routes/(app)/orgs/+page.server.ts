import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { requireUser } from '$lib/server/access';
import { listOrgs } from '$lib/server/orgs';

/** The orgs the user belongs to (userOrgs already returns every org for the site owner). */
export const load: PageServerLoad = async ({ locals, parent }) => {
	const env = getEnv();
	requireUser(locals);
	const { orgs } = await parent();
	const views = await listOrgs(
		env,
		orgs.map((o) => o.id)
	);
	const summary = new Map(orgs.map((o) => [o.id, o]));
	return {
		orgViews: views.map((o) => ({
			...o,
			role: summary.get(o.id)!.role,
			/** may open the org's ban and reserved lists (owner, or admin on one of its servers) */
			lists: summary.get(o.id)!.lists
		}))
	};
};
