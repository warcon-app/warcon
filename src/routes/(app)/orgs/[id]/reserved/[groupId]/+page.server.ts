import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { requireListsRole } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { groupEntriesView, groupOf, groupsView } from '$lib/server/slot-groups';

/** One of the org's reserved-slot groups: for those who edit its reserved slots, found within it. */
export const load: PageServerLoad = async ({ locals, params }) => {
	const env = getEnv();
	try {
		const { org } = await requireListsRole(env, locals, params.id, 'reserve');
		const group = await groupOf(env, org, params.groupId);
		const [entries, groups] = await Promise.all([
			groupEntriesView(env, org, group),
			groupsView(env, org)
		]);
		return { entries, group: groups.find((g) => g.id === group.id)! };
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		error(known.status, known.message);
	}
};
