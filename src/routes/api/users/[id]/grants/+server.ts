import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOwner } from '$lib/server/access';
import { setUserGrants } from '$lib/server/users';

export const PUT = route(async (event) => {
	const env = getEnv();
	const actor = requireOwner(event.locals);
	const body = await readJson(event.request);
	return apiJson({
		ok: true,
		grants: await setUserGrants(env, event.request, actor, param(event, 'id'), body.grants)
	});
});
