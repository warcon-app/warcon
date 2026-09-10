import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { accessibleServers, requireListsRole } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { listOrgs } from '$lib/server/orgs';
import { orgListsView } from '$lib/server/lists';

/**
 * The org section: owners see everything; admins of one of its servers may open the ban and
 * reserved-slot lists (the overview page applies its own owner-only check on top).
 */
export const load: LayoutServerLoad = async ({ locals, params }) => {
	const env = getEnv();
	try {
		const { org, role, user } = await requireListsRole(env, locals, params.id);
		// This org's servers regardless of the header scope: managing an org must not depend on it.
		const [servers, [view], lists] = await Promise.all([
			accessibleServers(env, user, org.id),
			listOrgs(env, [org.id]),
			orgListsView(env, org, role)
		]);
		return {
			org: view,
			orgServers: servers,
			/** owner: runs the org; editor: admin on one of its servers, lists only */
			listsRole: role,
			lists
		};
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		error(known.status, known.message);
	}
};
