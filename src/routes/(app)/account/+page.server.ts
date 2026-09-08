import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { discordEnabled, getEnv } from '$lib/server/env';
import { normalizeError, str } from '$lib/server/http';
import { writeAudit } from '$lib/server/audit';
import { requireUser } from '$lib/server/access';
import { auditSelfDelete } from '$lib/server/erasure';
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
	const [sessions, providers] = await Promise.all([
		listSessions(env, user.id, locals.session?.id ?? null),
		linkedProviders(env, user.id)
	]);
	return {
		sessions,
		discord: discordEnabled(env),
		providers,
		/** false for accounts created through Discord: they set a password rather than change one */
		hasPassword: providers.includes('credential')
	};
};

export const actions: Actions = {
	/** Change the password, or set a first one for an account that signed up through Discord. */
	password: async ({ request, locals, url }) => {
		const env = getEnv();
		const user = requireUser(locals);
		const form = await request.formData();
		const current = String(form.get('current') || '');
		const next = String(form.get('next') || '');
		if (next !== String(form.get('again') || ''))
			return fail(400, { error: 'New passwords do not match.' });
		const hasPassword = (await linkedProviders(env, user.id)).includes('credential');
		try {
			validatePassword(next);
			if (hasPassword) {
				await locals.auth!.api.changePassword({
					body: { currentPassword: current, newPassword: next, revokeOtherSessions: true },
					headers: request.headers
				});
			} else {
				await locals.auth!.api.setPassword({
					body: { newPassword: next },
					headers: request.headers
				});
			}
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
			action: hasPassword ? 'password.change' : 'password.set',
			outcome: 'ok'
		});
		if (url.searchParams.get('force')) redirect(303, '/');
		return hasPassword ? { changed: true } : { set: true };
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
		if (!discordEnabled(env)) return fail(404, { error: 'Discord is not configured.' });
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
	},

	/**
	 * Delete your own account. Password accounts confirm with the password; Discord-only accounts
	 * type their username and must have signed in recently (Better Auth's session freshness check).
	 * The guards and the audit-trail scrub live in erasure.ts, on Better Auth's delete hooks.
	 */
	deleteAccount: async ({ request, locals }) => {
		const env = getEnv();
		const user = requireUser(locals);
		const form = await request.formData();
		const hasPassword = (await linkedProviders(env, user.id)).includes('credential');
		const password = String(form.get('password') || '');
		const confirm = str(form.get('confirm'), 32);
		if (hasPassword && !password) return fail(400, { error: 'Enter your password to confirm.' });
		if (!hasPassword && confirm.toLowerCase() !== user.username.toLowerCase())
			return fail(400, { error: 'Type your username to confirm.' });
		try {
			await locals.auth!.api.deleteUser({
				body: hasPassword ? { password } : {},
				headers: request.headers
			});
		} catch (err) {
			const known = normalizeError(err);
			if (!known) throw err;
			await writeAudit(env, request, {
				actor: user,
				category: 'user',
				action: 'account.delete',
				outcome: 'denied',
				message: known.message
			});
			if (/INVALID_PASSWORD|invalid password/i.test(known.message))
				return fail(403, { error: 'Password is wrong.' });
			if (/SESSION_EXPIRED|session expired/i.test(known.message))
				return fail(403, { error: 'Sign out, sign in again, then delete your account.' });
			return fail(known.status, { error: known.message });
		}
		await auditSelfDelete(env, request, user);
		redirect(303, '/sign-in?deleted=1');
	}
};
