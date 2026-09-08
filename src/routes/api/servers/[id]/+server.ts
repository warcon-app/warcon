import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireServerManager } from '$lib/server/access';
import { deleteServer, updateServer } from '$lib/server/servers';

export const PATCH = route(async (event) => {
	const env = getEnv();
	const { server, user } = await requireServerManager(env, event.locals, param(event, 'id'));
	await updateServer(env, event.request, user, server, await readJson(event.request));
	return apiJson({ ok: true });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const { server, user } = await requireServerManager(env, event.locals, param(event, 'id'));
	await deleteServer(env, event.request, user, server);
	return apiJson({ ok: true });
});
