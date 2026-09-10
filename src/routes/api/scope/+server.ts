// Browser-level organisation scope: PUT {orgId} narrows the panel to one org for this browser,
// PUT {orgId: null} shows every org, DELETE returns to the account default.
import { getEnv } from '$lib/server/env';
import { apiJson, ApiError, readJson, route, str } from '$lib/server/http';
import { requireUser, userOrgs } from '$lib/server/access';
import { clearScopeCookie, setScopeCookie } from '$lib/server/scope';

export const PUT = route(async (event) => {
	const env = getEnv();
	const user = requireUser(event.locals);
	const body = await readJson(event.request);
	const orgId = body.orgId === null || body.orgId === undefined ? null : str(body.orgId, 64);
	if (orgId) {
		const orgs = await userOrgs(env, user);
		if (!orgs.some((o) => o.id === orgId))
			throw new ApiError(404, 'Organisation not found.', 'not_found');
	}
	setScopeCookie(event.cookies, orgId);
	return apiJson({ ok: true, orgId });
});

export const DELETE = route(async (event) => {
	requireUser(event.locals);
	clearScopeCookie(event.cookies);
	return apiJson({ ok: true });
});
