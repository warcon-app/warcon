import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { flag, getEnv } from '$lib/server/env';
import { accessibleServers } from '$lib/server/access';
import { userCount } from '$lib/server/users';

export const load: LayoutServerLoad = async ({ locals }) => {
	const env = getEnv();
	if (!locals.user) {
		redirect(303, (await userCount(env)) === 0 ? '/setup' : '/sign-in');
	}
	return {
		user: locals.user,
		servers: await accessibleServers(env, locals.user),
		demoAllowed: flag(env.ALLOW_DEMO_SERVER, false),
		steamLookup: !!env.STEAM_API_KEY
	};
};
