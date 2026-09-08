import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { flag, getEnv } from '$lib/server/env';
import { accessibleServers, canManage, userOrgs } from '$lib/server/access';
import { userCount } from '$lib/server/users';

export const load: LayoutServerLoad = async ({ locals }) => {
	const env = getEnv();
	if (!locals.user) {
		redirect(303, (await userCount(env)) === 0 ? '/setup' : '/sign-in');
	}
	const [orgs, servers] = await Promise.all([
		userOrgs(env, locals.user),
		accessibleServers(env, locals.user)
	]);
	return {
		user: locals.user,
		orgs,
		/** site owner or owner of at least one org: sees Servers and Orgs management */
		canManage: canManage(locals.user, orgs),
		servers,
		demoAllowed: flag(env.ALLOW_DEMO_SERVER, false),
		steamLookup: !!env.STEAM_API_KEY
	};
};
