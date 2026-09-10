import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { settingsView } from '$lib/server/settings';
import { gateway } from '$lib/server/gateway';

export const load: PageServerLoad = async ({ locals }) => {
	const env = getEnv();
	if (locals.user?.role !== 'owner') error(403, 'Owner access required.');
	return { settings: await settingsView(env), worker: await gateway().health(env) };
};
