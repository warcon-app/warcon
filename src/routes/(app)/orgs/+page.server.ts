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
	const roleOf = new Map(orgs.map((o) => [o.id, o.role]));
	return {
		orgViews: views.map((o) => ({ ...o, role: roleOf.get(o.id)! }))
	};
};
