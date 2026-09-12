import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { createRole, listRoles } from '$lib/server/roles';

export const GET = route(async (event) => {
	const env = getEnv();
	const { org } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	return apiJson({ ok: true, roles: await listRoles(env, org.id) });
});

/** {name, capabilities[]} */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const role = await createRole(env, event.request, user, org, await readJson(event.request));
	return apiJson({ ok: true, role }, 201);
});
