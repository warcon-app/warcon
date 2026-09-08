import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { listUsers } from '$lib/server/users';

export const load: PageServerLoad = async ({ locals }) => {
	const env = getEnv();
	if (locals.user?.role !== 'owner') error(403, 'Owner access required.');
	return { users: await listUsers(env) };
};
