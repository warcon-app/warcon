import { getEnv } from '$lib/server/env';
import { apiJson, readJson, route } from '$lib/server/http';
import { accessibleServers, requireOwner, requireUser } from '$lib/server/access';
import { createServer } from '$lib/server/servers';

export const GET = route(async ({ locals }) => {
	const env = getEnv();
	const user = requireUser(locals);
	return apiJson({ ok: true, servers: await accessibleServers(env, user) });
});

export const POST = route(async ({ locals, request }) => {
	const env = getEnv();
	const actor = requireOwner(locals);
	const id = await createServer(env, request, actor, await readJson(request));
	return apiJson({ ok: true, id }, 201);
});
