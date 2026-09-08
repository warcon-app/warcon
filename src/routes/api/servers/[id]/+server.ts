import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOwner, requireServerRole } from '$lib/server/access';
import { deleteServer, updateServer } from '$lib/server/servers';

export const PATCH = route(async (event) => {
	const env = getEnv();
	const actor = requireOwner(event.locals);
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'admin');
	await updateServer(env, event.request, actor, server, await readJson(event.request));
	return apiJson({ ok: true });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const actor = requireOwner(event.locals);
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'admin');
	await deleteServer(env, event.request, actor, server);
	return apiJson({ ok: true });
});
