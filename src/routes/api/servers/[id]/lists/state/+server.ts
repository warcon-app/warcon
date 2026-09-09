import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireServerRole, requireUser } from '$lib/server/access';
import { serverListsState } from '$lib/server/lists';

/** Which bans and reserved slots on this server come from the org lists (for the players page). */
export const GET = route(async (event) => {
	const env = getEnv();
	const { server } = await requireServerRole(env, event.locals, param(event, 'id'), 'viewer');
	return apiJson({ ok: true, ...(await serverListsState(env, server, requireUser(event.locals))) });
});
