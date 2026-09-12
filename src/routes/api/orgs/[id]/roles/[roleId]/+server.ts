import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { deleteRole, updateRole } from '$lib/server/roles';

/** {name?, capabilities?[]}: applies at once to everyone holding the role. */
export const PATCH = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const role = await updateRole(
		env,
		event.request,
		user,
		org,
		param(event, 'roleId'),
		await readJson(event.request)
	);
	return apiJson({ ok: true, role });
});

/** Custom roles only, and only while no grant or invite link uses them (409 otherwise). */
export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await deleteRole(env, event.request, user, org, param(event, 'roleId'));
	return apiJson({ ok: true });
});
