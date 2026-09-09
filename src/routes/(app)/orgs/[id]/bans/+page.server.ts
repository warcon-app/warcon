import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { requireListsRole } from '$lib/server/access';
import { normalizeError } from '$lib/server/http';
import { entriesView } from '$lib/server/lists';

export const load: PageServerLoad = async ({ locals, params }) => {
	const env = getEnv();
	try {
		const { org } = await requireListsRole(env, locals, params.id);
		return { entries: await entriesView(env, org, 'ban') };
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		error(known.status, known.message);
	}
};
