import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { resetRole } from '$lib/server/roles';

/** Puts a built-in role back to its shipped name and capabilities. */
export const POST = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const role = await resetRole(env, event.request, user, org, param(event, 'roleId'));
	return apiJson({ ok: true, role });
});
