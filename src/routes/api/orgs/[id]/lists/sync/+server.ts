import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireListsRole } from '$lib/server/access';
import { fanOut } from '$lib/server/lists';

/** Push the org's lists to every one of its servers right now. */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org } = await requireListsRole(env, event.locals, param(event, 'id'));
	return apiJson({ ok: true, sync: await fanOut(env, org) });
});
