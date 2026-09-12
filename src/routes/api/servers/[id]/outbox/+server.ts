// The last trigger actions on this server and what became of them.
import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerCap } from '$lib/server/access';
import { recentOutbox } from '$lib/server/outbox';

export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerCap(env, event.locals, param(event, 'id'), 'server.view');
	return apiJson({ ok: true, items: await recentOutbox(env, server.id, 40) });
});
