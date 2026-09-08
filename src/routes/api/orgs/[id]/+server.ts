import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole, requireOwner } from '$lib/server/access';
import { deleteOrg, setOrgControls, updateOrg } from '$lib/server/orgs';

/** {name} for org owners; {serverLimit, suspended, reason} for the site owner only. */
export const PATCH = route(async (event) => {
	const env = getEnv();
	const body = await readJson(event.request);
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	if (body.serverLimit !== undefined || body.suspended !== undefined) {
		requireOwner(event.locals);
		await setOrgControls(env, event.request, user, org, body);
	} else {
		await updateOrg(env, event.request, user, org, body);
	}
	return apiJson({ ok: true });
});

export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await deleteOrg(env, event.request, user, org);
	return apiJson({ ok: true });
});
