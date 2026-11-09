import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { deleteMapSet, updateMapSet } from '$lib/server/map-sets';

/** {name?, entries?}: a new name, new entries (the whole list), or both. */
export const PATCH = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const mapSet = await updateMapSet(
		env,
		event.request,
		user,
		org,
		param(event, 'setId'),
		await readJson(event.request)
	);
	return apiJson({ ok: true, mapSet });
});

/** The set goes; a server it was loaded on keeps its rotation. */
export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await deleteMapSet(env, event.request, user, org, param(event, 'setId'));
	return apiJson({ ok: true });
});
