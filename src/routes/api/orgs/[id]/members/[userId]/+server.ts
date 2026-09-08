import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { removeMember, setMemberRole } from '$lib/server/orgs';

export const PATCH = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const body = await readJson(event.request);
	await setMemberRole(env, event.request, user, org, param(event, 'userId'), body.role);
	return apiJson({ ok: true });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await removeMember(env, event.request, user, org, param(event, 'userId'));
	return apiJson({ ok: true });
});
