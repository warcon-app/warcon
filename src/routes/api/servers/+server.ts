import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, readJson, route, str } from '$lib/server/http';
import { accessibleServers, requireOrgRole, requireUser } from '$lib/server/access';
import { createServer } from '$lib/server/servers';

export const GET = route(async ({ locals }) => {
	const env = getEnv();
	const user = requireUser(locals);
	return apiJson({ ok: true, servers: await accessibleServers(env, user) });
});

/** Adds a server to an org the caller owns. */
export const POST = route(async ({ locals, request }) => {
	const env = getEnv();
	const body = await readJson(request);
	const orgId = str(body.orgId, 64);
	if (!orgId)
		throw new ApiError(400, 'orgId (the organisation that runs this server) is required.');
	const { org, user } = await requireOrgRole(env, locals, orgId, 'owner');
	const id = await createServer(env, request, user, org, body);
	return apiJson({ ok: true, id }, 201);
});
