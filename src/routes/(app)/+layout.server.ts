import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { flag, getEnv } from '$lib/server/env';
import { accessibleServers, canManage, userOrgs } from '$lib/server/access';
import { userCount } from '$lib/server/users';
import { orgsRemaining } from '$lib/server/signup';
import { resolveScope } from '$lib/server/scope';

export const load: LayoutServerLoad = async ({ locals, cookies }) => {
	const env = getEnv();
	if (!locals.user) {
		redirect(303, (await userCount(env)) === 0 ? '/setup' : '/sign-in');
	}
	const [orgs, orgsLeft] = await Promise.all([
		userOrgs(env, locals.user),
		orgsRemaining(env, locals.user)
	]);
	// The scope narrows the dashboard, the switcher and the Servers page to one organisation.
	// Server pages, org pages and the Users page load what they need themselves, so a deep link
	// into another org still works.
	const scope = resolveScope(cookies, locals.user, orgs);
	const servers = await accessibleServers(env, locals.user, scope?.id ?? null);
	return {
		user: locals.user,
		orgs,
		/** organisation the server list is narrowed to, or null for every org the user can see */
		scope,
		/** site owner or owner of at least one org: sees Servers and Orgs management */
		canManage: canManage(locals.user, orgs),
		/** may create another org: site owner always, others when ALLOW_ORG_SIGNUP is on and under the cap */
		canCreateOrg: orgsLeft === null || orgsLeft > 0,
		servers,
		demoAllowed: flag(env.ALLOW_DEMO_SERVER, false),
		steamLookup: !!env.STEAM_API_KEY
	};
};
