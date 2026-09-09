import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { requireListsRole } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { listOrgs } from '$lib/server/orgs';
import { orgListsView } from '$lib/server/lists';

/**
 * The org section: owners see everything; admins of one of its servers may open the ban and
 * reserved-slot lists (the overview page applies its own owner-only check on top).
 */
export const load: LayoutServerLoad = async ({ locals, params, parent }) => {
	const env = getEnv();
	try {
		const { org, role } = await requireListsRole(env, locals, params.id);
		const [{ servers }, [view], lists] = await Promise.all([
			parent(),
			listOrgs(env, [org.id]),
			orgListsView(env, org, role)
		]);
		return {
			org: view,
			orgServers: servers.filter((s) => s.orgId === org.id),
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
