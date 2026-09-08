import { getEnv } from '$lib/server/env';
import { apiJson, param, readJson, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { setMemberGrants } from '$lib/server/orgs';

export const PUT = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	const body = await readJson(event.request);
	return apiJson({
		ok: true,
		grants: await setMemberGrants(
			env,
			event.request,
			user,
			org,
			param(event, 'userId'),
			body.grants
		)
	});
});
