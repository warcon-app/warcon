import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerCap, requireUser } from '$lib/server/access';
import { serverListsState } from '$lib/server/lists';

/** Which bans and reserved slots on this server come from the org lists (for the players page). */
export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerCap(env, event.locals, param(event, 'id'), 'server.view');
	return apiJson({ ok: true, ...(await serverListsState(env, server, requireUser(event.locals))) });
});
