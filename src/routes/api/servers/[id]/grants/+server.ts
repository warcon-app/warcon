import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOwner, requireServerRole } from '$lib/server/access';
import { serverGrantsFor, setServerGrants } from '$lib/server/servers';

export const GET = route(async (event) => {
	const env = getEnv();
	requireOwner(event.locals);
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'admin');
	return apiJson({ ok: true, grants: await serverGrantsFor(env, server.id) });
});

export const PUT = route(async (event) => {
	const env = getEnv();
	const actor = requireOwner(event.locals);
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'admin');
	const body = await readJson(event.request);
	return apiJson({
		ok: true,
		grants: await setServerGrants(env, event.request, actor, server, body.grants)
	});
});
