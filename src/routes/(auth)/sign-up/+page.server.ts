// Self-service organisation sign-up (ALLOW_ORG_SIGNUP): create an account if needed, then an org
// with yourself as its first owner.
import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { discordEnabled, getEnv, turnstileSiteKey } from '$lib/server/env';
import { normalizeError } from '$lib/server/http';
import { requireUser } from '$lib/server/access';
import { createOrg } from '$lib/server/orgs';
import {
	assertMayCreateOrg,
	orgSignupEnabled,
	orgsRemaining,
	registerFromForm
} from '$lib/server/signup';

const HERE = '/sign-up';

export const load: PageServerLoad = async ({ locals }) => {
	const env = getEnv();
	if (!orgSignupEnabled(env)) error(404, 'Organisation sign-up is not enabled on this panel.');
	return {
		discord: discordEnabled(env),
		turnstileSiteKey: turnstileSiteKey(env),
		remaining: locals.user ? await orgsRemaining(env, locals.user) : null
	};
};

export const actions: Actions = {
	/** Sign in with Discord, creating the account if this Discord user is new, then come back here. */
	discord: async ({ request, locals }) => {
		const env = getEnv();
		if (!orgSignupEnabled(env)) return fail(404, { error: 'Sign-up is not enabled.' });
		if (!discordEnabled(env)) return fail(404, { error: 'Discord sign-in is not configured.' });
		const res = await locals.auth!.api.signInSocial({
			body: {
				provider: 'discord',
				callbackURL: HERE,
				errorCallbackURL: `${HERE}?error=discord`,
				requestSignUp: true
			},
			headers: request.headers
		});
		if (!res.url) return fail(500, { error: 'Discord did not return an authorization URL.' });
		redirect(303, res.url);
	},

	register: async (event) => {
		const env = getEnv();
		if (!orgSignupEnabled(env)) return fail(404, { error: 'Sign-up is not enabled.' });
		return registerFromForm(event, env, HERE);
	},

	create: async ({ request, locals }) => {
		const env = getEnv();
		if (!orgSignupEnabled(env)) return fail(404, { error: 'Sign-up is not enabled.' });
		if (!locals.user) redirect(303, `/sign-in?next=${encodeURIComponent(HERE)}`);
		const user = requireUser(locals);
		const form = await request.formData();
		const orgName = String(form.get('orgName') || '').trim();
		let id: string;
		try {
			await assertMayCreateOrg(env, user);
			id = await createOrg(env, request, user, { name: orgName });
		} catch (err) {
			const known = normalizeError(err);
			if (!known) throw err;
			return fail(known.status, { error: known.message, orgName });
		}
		redirect(303, `/orgs/${encodeURIComponent(id)}`);
	}
};
