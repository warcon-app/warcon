import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { getOrg, requireServerCap } from '$lib/server/access';
import { ApiError } from '$lib/server/http';
import { gateway } from '$lib/server/gateway';

/** Pushes the organisation's lists to this server now (through the worker). */
export const POST = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerCap(env, event.locals, param(event, 'id'), 'lists.edit');
	const org = await getOrg(env, server.orgId);
	if (!org) throw new ApiError(404, 'Organisation not found.');
	const sync = await gateway().syncServer(env, server, org, 15_000);
	return apiJson({ ok: true, sync });
});
