import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireServerRole, requireUser } from '$lib/server/access';
import { createTrigger, listTriggers } from '$lib/server/triggers';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'viewer');
	return apiJson({ ok: true, triggers: await listTriggers(env, server.id) });
});

/** {kind, name, enabled, config}: admins create triggers. */
export const POST = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'admin');
	const body = await readJson(event.request);
	const trigger = await createTrigger(env, event.request, user, server, body);
	return apiJson({ ok: true, trigger }, 201);
});
