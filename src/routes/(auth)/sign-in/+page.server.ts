import { fail, redirect } from '@sveltejs/kit';
import { isAPIError } from 'better-auth/api';
import type { Actions, PageServerLoad } from './$types';
import { getEnv, type Env } from '$lib/server/env';
import { clientIp, str } from '$lib/server/http';
import { writeAudit } from '$lib/server/audit';
import { clearLoginFailures, loginLockSeconds, noteLoginFailure } from '$lib/server/access';
import { userCount } from '$lib/server/users';

const discordEnabled = (env: Env) => Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET);

export const load: PageServerLoad = async ({ locals }) => {
	const env = getEnv();
	if (locals.user) redirect(303, '/');
	if ((await userCount(env)) === 0) redirect(303, '/setup');
	return { discord: discordEnabled(env) };
};

export const actions: Actions = {
	password: async ({ request, locals }) => {
		const env = getEnv();
		const auth = locals.auth!;
		const form = await request.formData();
		const username = str(form.get('username'), 32);
		const password = String(form.get('password') || '');
		if (!username || !password)
			return fail(400, { error: 'Username and password are required.', username });

		const keys = [`u:${username.toLowerCase()}`, `ip:${clientIp(request) || 'unknown'}`];
		const lock = await loginLockSeconds(env, keys);
		if (lock > 0) {
			await writeAudit(env, request, {
				category: 'auth',
				action: 'login',
				outcome: 'denied',
				target: username,
				message: `Locked out for ${lock}s`
			});
			return fail(429, {
				error: `Too many failed attempts. Try again in ${Math.ceil(lock / 60)} minute(s).`,
				username
			});
		}

		try {
			// The session-create hook in auth.ts writes the "login ok" audit row; cookies are set by the SvelteKit plugin.
			await auth.api.signInUsername({ body: { username, password }, headers: request.headers });
		} catch (err) {
			if (!isAPIError(err)) throw err;
			const code = (err as { body?: { code?: string } }).body?.code || '';
			if (code === 'BANNED_USER') {
				await writeAudit(env, request, {
					category: 'auth',
					action: 'login',
					outcome: 'denied',
					target: username,
					message: 'Account disabled'
				});
				return fail(403, { error: 'This account is disabled.', username });
			}
			await noteLoginFailure(env, keys);
			await writeAudit(env, request, {
				category: 'auth',
				action: 'login',
				outcome: 'denied',
				target: username,
				message: 'Bad username or password'
			});
			return fail(401, { error: 'Bad username or password.', username });
		}
		await clearLoginFailures(env, keys);
		redirect(303, '/');
	},

	discord: async ({ request, locals }) => {
		const env = getEnv();
		if (!discordEnabled(env)) return fail(404, { error: 'Discord sign-in is not configured.' });
		const res = await locals.auth!.api.signInSocial({
			body: { provider: 'discord', callbackURL: '/', errorCallbackURL: '/sign-in?error=discord' },
			headers: request.headers
		});
		if (!res.url) return fail(500, { error: 'Discord did not return an authorization URL.' });
		redirect(303, res.url);
	}
};
