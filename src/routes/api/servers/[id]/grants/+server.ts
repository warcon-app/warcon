import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireServerManager } from '$lib/server/access';
import { serverGrantsFor, setServerGrants } from '$lib/server/servers';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerManager(env, event.locals, param(event, 'id'));
	return apiJson({ ok: true, grants: await serverGrantsFor(env, server.id) });
});

export const PUT = route(async (event) => {
	const env = getEnv();
	const { server, user } = await requireServerManager(env, event.locals, param(event, 'id'));
	const body = await readJson(event.request);
	return apiJson({
		ok: true,
		grants: await setServerGrants(env, event.request, user, server, body.grants)
	});
});
