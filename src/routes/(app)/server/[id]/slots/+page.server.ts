import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { getOrg, getServer, listsRoleFor, requireUser } from '$lib/server/access';
import { orgListsView, serverListsState } from '$lib/server/lists';

/** The server layout already refused anyone without access; viewers see the slots read-only. */
export const load: PageServerLoad = async ({ locals, params }) => {
	const env = getEnv();
	const user = requireUser(locals);
	const server = await getServer(env, params.id);
	if (!server) return { listState: null, orgLists: null };
	const [listState, org, role] = await Promise.all([
		serverListsState(env, server, user),
		getOrg(env, server.orgId),
		listsRoleFor(env, user, server.orgId)
	]);
	return {
		listState,
		/** the org's lists with counts, for people who may open them */
		orgLists: org && role ? await orgListsView(env, org, role) : null
	};
};
