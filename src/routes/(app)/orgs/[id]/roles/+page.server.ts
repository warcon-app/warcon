import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { requireOrgRole } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { listRoles } from '$lib/server/roles';

/** The role editor: what each of the org's server roles may do. Owners (and the site owner) only. */
export const load: PageServerLoad = async ({ locals, params }) => {
	const env = getEnv();
	try {
		const { org } = await requireOrgRole(env, locals, params.id, 'owner');
		return { roles: await listRoles(env, org.id) };
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		error(known.status, known.message);
	}
};
