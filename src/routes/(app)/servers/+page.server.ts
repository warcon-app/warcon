import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/** Servers the user runs: everything for the site owner, else the servers of orgs they own. */
export const load: PageServerLoad = async ({ parent }) => {
	const { canManage, servers, orgs } = await parent();
	if (!canManage) error(403, 'You need to own an organisation to manage servers.');
	return {
		managed: servers.filter((s) => s.manager),
		ownedOrgs: orgs.filter((o) => o.role === 'owner' && !o.suspended)
	};
};
