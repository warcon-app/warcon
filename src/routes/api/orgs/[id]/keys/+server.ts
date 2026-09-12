import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { createKey, listKeys } from '$lib/server/apikeys';

export const GET = route(async (event) => {
	const env = getEnv();
	const { org } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	return apiJson({ ok: true, keys: await listKeys(env, org.id) });
});

/** {label, capabilities[], serverIds[]|null, expiresDays}: the response carries the token, once. */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const { key, token } = await createKey(
		env,
		event.request,
		user,
		org,
		await readJson(event.request)
	);
	return apiJson({ ok: true, key, token }, 201);
});
