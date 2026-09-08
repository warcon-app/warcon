import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { deleteOrg, updateOrg } from '$lib/server/orgs';

export const PATCH = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await updateOrg(env, event.request, user, org, await readJson(event.request));
	return apiJson({ ok: true });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await deleteOrg(env, event.request, user, org);
	return apiJson({ ok: true });
});
