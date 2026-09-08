import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { createInvite, listInvites } from '$lib/server/orgs';

export const GET = route(async (event) => {
	const env = getEnv();
	const { org } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	return apiJson({ ok: true, invites: await listInvites(env, org.id) });
});

export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const invite = await createInvite(env, event.request, user, org, await readJson(event.request));
	return apiJson({ ok: true, invite }, 201);
});
