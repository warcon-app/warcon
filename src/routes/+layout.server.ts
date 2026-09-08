import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { authConfigured } from '$lib/server/auth';
import { getEnv } from '$lib/server/env';

export const load: LayoutServerLoad = async ({ locals }) => {
	const env = getEnv();
	if (!authConfigured(env)) {
		error(503, {
			message: 'BETTER_AUTH_SECRET is not set. Add it to .env (see .env.example) and restart.',
			code: 'config'
		});
	}
	return { user: locals.user, appName: env.APP_NAME || 'Warcon' };
};
