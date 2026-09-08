// First run: create the owner account. Only works while there are zero users.
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { normalizeError, str } from '$lib/server/http';
import { timingSafeEqualStr } from '$lib/server/crypto';
import { writeAudit } from '$lib/server/audit';
import { createUser, userCount, validatePassword, validateUsername } from '$lib/server/users';

export const load: PageServerLoad = async () => {
	const env = getEnv();
	if ((await userCount(env)) > 0) redirect(303, '/sign-in');
	return { tokenRequired: !!env.SETUP_TOKEN };
};

export const actions: Actions = {
	default: async ({ request, locals }) => {
		const env = getEnv();
		const auth = locals.auth!;
		const form = await request.formData();
		const values = {
			username: str(form.get('username'), 32),
			displayName: str(form.get('displayName'), 80)
		};
		if ((await userCount(env)) > 0)
			return fail(409, { error: 'Setup already completed.', ...values });
		try {
			if (env.SETUP_TOKEN && !timingSafeEqualStr(str(form.get('token'), 500), env.SETUP_TOKEN)) {
				await writeAudit(env, request, {
					category: 'auth',
					action: 'setup',
					outcome: 'denied',
					message: 'Bad setup token'
				});
				return fail(403, { error: 'Setup token is wrong.', ...values });
			}
			const username = validateUsername(values.username);
			const password = validatePassword(form.get('password'));
			const id = await createUser(auth, env, undefined, {
				username,
				password,
				displayName: values.displayName,
				role: 'owner',
				mustChangePassword: false
			});
			await writeAudit(env, request, {
				actor: { id, username },
				category: 'auth',
				action: 'setup',
				outcome: 'ok',
				target: username,
				message: 'Owner account created'
			});
			await auth.api.signInUsername({ body: { username, password }, headers: request.headers });
		} catch (err) {
			const known = normalizeError(err);
			if (!known) throw err;
			return fail(known.status, { error: known.message, ...values });
		}
		redirect(303, '/');
	}
};
