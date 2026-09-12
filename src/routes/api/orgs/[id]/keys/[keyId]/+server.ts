import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { revokeKey } from '$lib/server/apikeys';

/** Revokes the key at once; the row stays for the audit trail. */
export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await revokeKey(env, event.request, user, org, param(event, 'keyId'));
	return apiJson({ ok: true });
});
