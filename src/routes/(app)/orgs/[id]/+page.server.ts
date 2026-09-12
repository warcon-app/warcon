import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { discordEnabled, getEnv } from '$lib/server/env';
import { requireOrgRole, type OrgRow } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { listInvites, listMembers } from '$lib/server/orgs';
import { listWebhooks, WEBHOOK_EVENT_LABELS } from '$lib/server/webhooks';
import { listRoles } from '$lib/server/roles';
import { listKeys } from '$lib/server/apikeys';

/** Org management: owners of the org (and the site owner) only. Same rule as the API routes. */
export const load: PageServerLoad = async ({ locals, params }) => {
	const env = getEnv();
	let org: OrgRow;
	try {
		({ org } = await requireOrgRole(env, locals, params.id, 'owner'));
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		error(known.status, known.message);
	}
	const [members, invites, webhooks, roles, keys] = await Promise.all([
		listMembers(env, org.id),
		listInvites(env, org.id),
		listWebhooks(env, org.id),
		listRoles(env, org.id),
		listKeys(env, org.id)
	]);
	return {
		members,
		invites,
		webhooks,
		roles,
		keys,
		webhookEvents: Object.entries(WEBHOOK_EVENT_LABELS).map(([key, label]) => ({ key, label })),
		discord: discordEnabled(env)
	};
};
