import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerCap, requireUser } from '$lib/server/access';
import { testServer } from '$lib/server/servers';
import { assertRate } from '$lib/server/ratelimit';

export const POST = route(async (event) => {
	const env = getEnv();
	const actor = requireUser(event.locals);
	const { server } = await requireServerCap(env, event.locals, param(event, 'id'), 'config.apply');
	assertRate(`test:${actor.id}`, 20, 60_000);
	return apiJson(await testServer(env, event.request, actor, server));
});
