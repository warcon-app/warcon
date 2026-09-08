import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getEnv } from '$lib/server/env';
import { normalizeError, str } from '$lib/server/http';
import { writeAudit } from '$lib/server/audit';
import { requireUser } from '$lib/server/access';
import {
	linkedProviders,
	listSessions,
	revokeSession,
	setMustChangePassword,
	unlinkDiscord,
	validatePassword
} from '$lib/server/users';

export const load: PageServerLoad = async ({ locals }) => {
	const env = getEnv();
	const user = requireUser(locals);
	return {
		sessions: await listSessions(env, user.id, locals.session?.id ?? null),
		discord: Boolean(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET),
		providers: await linkedProviders(env, user.id)
	};
};

export const actions: Actions = {
	password: async ({ request, locals, url }) => {
		const env = getEnv();
		const user = requireUser(locals);
		const form = await request.formData();
		const current = String(form.get('current') || '');
		const next = String(form.get('next') || '');
		if (next !== String(form.get('again') || ''))
			return fail(400, { error: 'New passwords do not match.' });
		try {
			validatePassword(next);
			await locals.auth!.api.changePassword({
				body: { currentPassword: current, newPassword: next, revokeOtherSessions: true },
				headers: request.headers
			});
		} catch (err) {
			const known = normalizeError(err);
			if (!known) throw err;
			await writeAudit(env, request, {
				actor: user,
				category: 'auth',
				action: 'password.change',
				outcome: 'denied',
				message: known.message
			});
			const wrongCurrent = /INVALID_PASSWORD|invalid password/i.test(known.message);
			return fail(wrongCurrent ? 403 : known.status, {
				error: wrongCurrent ? 'Current password is wrong.' : known.message
			});
		}
		await setMustChangePassword(env, user.id, false);
		await writeAudit(env, request, {
			actor: user,
			category: 'auth',
			action: 'password.change',
			outcome: 'ok'
		});
		if (url.searchParams.get('force')) redirect(303, '/');
		return { changed: true };
	},

	revoke: async ({ request, locals }) => {
		const env = getEnv();
		const user = requireUser(locals);
		const id = str((await request.formData()).get('id'), 64);
		if (!id || id === locals.session?.id) return fail(400, { error: 'Bad session id.' });
		await revokeSession(env, user.id, id);
		await writeAudit(env, request, {
			actor: user,
			category: 'auth',
			action: 'session.revoke',
			outcome: 'ok',
			target: id.slice(0, 12)
		});
		return { revoked: true };
	},

	linkDiscord: async ({ request, locals }) => {
		const env = getEnv();
		requireUser(locals);
		if (!(env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET))
			return fail(404, { error: 'Discord is not configured.' });
		const res = await locals.auth!.api.linkSocialAccount({
			body: { provider: 'discord', callbackURL: '/account' },
			headers: request.headers
		});
		if (!res.url) return fail(500, { error: 'Discord did not return an authorization URL.' });
		redirect(303, res.url);
	},

	unlinkDiscord: async ({ request, locals }) => {
		const env = getEnv();
		const user = requireUser(locals);
		try {
			await unlinkDiscord(env, user.id);
		} catch (err) {
			const known = normalizeError(err);
			if (!known) throw err;
			return fail(known.status, { error: known.message });
		}
		await writeAudit(env, request, {
			actor: user,
			category: 'auth',
			action: 'account.unlink',
			outcome: 'ok',
			target: 'discord'
		});
		return { unlinked: true };
	}
};
