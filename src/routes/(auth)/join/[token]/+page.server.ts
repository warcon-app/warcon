// Invite link landing page. Anyone with the link sees the org name; joining needs a signed-in
// account, and "Sign in with Discord" here is the one place a Discord account may be created.
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { discordEnabled, getEnv, turnstileSiteKey } from '$lib/server/env';
import { normalizeError } from '$lib/server/http';
import { findInvite, inviteProblem, isMember, joinOrg, suspendedProblem } from '$lib/server/orgs';
import { registerFromForm } from '$lib/server/signup';

export const load: PageServerLoad = async ({ locals, params }) => {
	const env = getEnv();
	const found = await findInvite(env, params.token);
	if (!found) {
		return { valid: false as const, problem: 'This invite link is not valid.', discord: false };
	}
	const { invite, org } = found;
	const problem = inviteProblem(invite) ?? suspendedProblem(org);
	// The stored membership, not orgRoleFor: the site owner counts as owner everywhere but may
	// still join (or already have joined) an org as a listed member.
	const alreadyMember = locals.user ? await isMember(env, org.id, locals.user.id) : false;
	return {
		valid: !problem,
		problem,
		org: { id: org.id, name: org.name },
		orgRole: invite.orgRole,
		serverRole: invite.serverRole,
		alreadyMember,
		discord: discordEnabled(env),
		turnstileSiteKey: turnstileSiteKey(env)
	};
};

export const actions: Actions = {
	/** Sign in with Discord, creating the account if this Discord user is new, then come back here. */
	discord: async ({ request, locals, params }) => {
		const env = getEnv();
		if (!discordEnabled(env)) return fail(404, { error: 'Discord sign-in is not configured.' });
		const found = await findInvite(env, params.token);
		if (!found || inviteProblem(found.invite) || suspendedProblem(found.org))
			return fail(410, { error: 'This invite link can no longer be used.' });
		const here = `/join/${encodeURIComponent(params.token)}`;
		const res = await locals.auth!.api.signInSocial({
			body: {
				provider: 'discord',
				callbackURL: here,
				errorCallbackURL: `${here}?error=discord`,
				requestSignUp: true
			},
			headers: request.headers
		});
		if (!res.url) return fail(500, { error: 'Discord did not return an authorization URL.' });
		redirect(303, res.url);
	},

	/** Create a username-and-password account (for people without Discord), then come back here. */
	register: async (event) => {
		const env = getEnv();
		const found = await findInvite(env, event.params.token);
		if (!found || inviteProblem(found.invite) || suspendedProblem(found.org))
			return fail(410, { error: 'This invite link can no longer be used.' });
		return registerFromForm(event, env, `/join/${encodeURIComponent(event.params.token)}`);
	},

	join: async ({ request, locals, params }) => {
		const env = getEnv();
		if (!locals.user) redirect(303, `/sign-in?next=${encodeURIComponent(`/join/${params.token}`)}`);
		const found = await findInvite(env, params.token);
		if (!found) return fail(404, { error: 'This invite link is not valid.' });
		try {
			await joinOrg(env, request, locals.user, found.invite, found.org);
		} catch (err) {
			const known = normalizeError(err);
			if (!known) throw err;
			return fail(known.status, { error: known.message });
		}
		redirect(303, '/');
	}
};
