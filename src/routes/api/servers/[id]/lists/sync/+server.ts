import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, param, route } from '$lib/server/http';
import { getOrg, requireServerRole } from '$lib/server/access';
import { reconcileServer } from '$lib/server/lists';

/** Push the org lists to this server right now. */
export const POST = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'admin');
	const org = await getOrg(env, server.orgId);
	if (!org) throw new ApiError(404, 'Organisation not found.', 'not_found');
	const sync = await reconcileServer(env, server, org, { reason: 'api', waitMs: 15_000 });
	return apiJson({ ok: true, sync });
});
