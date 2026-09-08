import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/env';
import { writeAudit } from '$lib/server/audit';

export const POST: RequestHandler = async ({ request, locals }) => {
	const env = getEnv();
	if (locals.user && locals.auth) {
		try {
			await locals.auth.api.signOut({ headers: request.headers });
		} catch (err) {
			console.warn('sign-out', err);
		}
		await writeAudit(env, request, {
			actor: locals.user,
			category: 'auth',
			action: 'logout',
			outcome: 'ok'
		});
	}
	redirect(303, '/sign-in');
};

export const GET: RequestHandler = () => redirect(303, '/');
