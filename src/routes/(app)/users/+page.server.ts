import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { accessibleServers } from '$lib/server/access';
import { listUsers } from '$lib/server/users';
import { rolesByOrg } from '$lib/server/roles';

export const load: PageServerLoad = async ({ locals }) => {
	const env = getEnv();
	if (locals.user?.role !== 'owner') error(403, 'Owner access required.');
	// Every server, not the header scope's: a user's grants are replaced as a whole when saved.
	const [users, servers] = await Promise.all([listUsers(env), accessibleServers(env, locals.user)]);
	const rolesByOrgId = await rolesByOrg(env, [...new Set(servers.map((s) => s.orgId))]);
	return { users, servers, rolesByOrgId };
};
