import { getEnv } from '$lib/server/env';
import { apiJson, param, route } from '$lib/server/http';
import { requireOrgRole } from '$lib/server/access';
import { revokeInvite } from '$lib/server/orgs';

/** Revokes the link. Rows are kept so the audit trail and "joined via" stay meaningful. */
export const DELETE = route(async (event) => {
	const env = getEnv();
	const { org, user } = await requireOrgRole(env, event.locals, param(event, 'id'), 'owner');
	await revokeInvite(env, event.request, user, org, param(event, 'inviteId'));
	return apiJson({ ok: true });
});
