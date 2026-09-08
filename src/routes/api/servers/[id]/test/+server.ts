import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerRole, requireUser } from '$lib/server/access';
import { testServer } from '$lib/server/servers';

export const POST = route(async (event) => {
	const env = getEnv();
	const actor = requireUser(event.locals);
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'admin');
	return apiJson(await testServer(env, event.request, actor, server));
});
