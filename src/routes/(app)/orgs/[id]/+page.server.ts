import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { discordEnabled, getEnv } from '$lib/server/env';
import { requireOrgRole, type OrgRow } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { listInvites, listMembers, listOrgs } from '$lib/server/orgs';

/** Org management: owners of the org (and the site owner) only. Same rule as the API routes. */
export const load: PageServerLoad = async ({ locals, params, parent }) => {
	const env = getEnv();
	let org: OrgRow;
	try {
		({ org } = await requireOrgRole(env, locals, params.id, 'owner'));
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		error(known.status, known.message);
	}
	const [{ servers }, members, invites, [view]] = await Promise.all([
		parent(),
		listMembers(env, org.id),
		listInvites(env, org.id),
		listOrgs(env, [org.id])
	]);
	return {
		org: view,
		orgServers: servers.filter((s) => s.orgId === org.id),
		members,
		invites,
		discord: discordEnabled(env)
	};
};
