// Steam sends the user back here (see steam-auth.ts). Signs in the linked account, links Steam to
// the signed-in account, or creates an account when the flow that started it allows sign-up.
import { redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import type { RequestHandler } from './$types';
import { getEnv } from '$lib/server/env';
import { freeUsername } from '$lib/server/auth';
import { account, user } from '$lib/server/db/schema';
import { writeAudit } from '$lib/server/audit';
import { ApiError, forLog, normalizeError } from '$lib/server/http';
import { verifySteamAssertion } from '$lib/server/steam-openid';
import { takeSteamState, steamCallbackUrl } from '$lib/server/steam-auth';
import { fetchSteam, steamEnabled } from '$lib/server/steam';
import { createSsoUser, setSteamId } from '$lib/server/users';
import { refreshAuthComplete } from '$lib/server/enrolment';

const withError = (back: string, code: string) =>
	`${back}${back.includes('?') ? '&' : '?'}error=${encodeURIComponent(code)}`;

export const GET: RequestHandler = async (event) => {
	const env = getEnv();
	const auth = event.locals.auth!;
	const { url, cookies, request, locals } = event;
	const state = takeSteamState(cookies, env, url.searchParams.get('state'));
	if (!state) redirect(303, withError('/sign-in', 'steam_state'));

	let steamId: string;
	try {
		steamId = await verifySteamAssertion(url.searchParams, steamCallbackUrl(env, state.nonce));
	} catch (err) {
		const known = normalizeError(err);
		await writeAudit(env, request, {
			actor: locals.user ?? undefined,
			category: 'auth',
			action: state.mode === 'link' ? 'account.link' : 'login',
			outcome: 'denied',
			target: 'steam',
			message: known?.message ?? 'Steam verification failed'
		});
		redirect(303, withError(state.back, known?.code || 'steam'));
	}

	const [linked] = await env.db
		.select({ userId: account.userId })
		.from(account)
		.where(and(eq(account.providerId, 'steam'), eq(account.accountId, steamId)))
		.limit(1);

	if (state.mode === 'link') {
		const me = locals.user;
		if (!me) redirect(303, withError('/sign-in', 'steam_session'));
		if (linked && linked.userId !== me.id) {
			await writeAudit(env, request, {
				actor: me,
				category: 'auth',
				action: 'account.link',
				outcome: 'denied',
				target: 'steam',
				message: 'That Steam account is linked to another user'
			});
			redirect(303, withError(state.back, 'steam_taken'));
		}
		if (!linked) {
			const ctx = await auth.$context;
			await ctx.internalAdapter.linkAccount({
				userId: me.id,
				providerId: 'steam',
				accountId: steamId
			});
			// The verified id also serves reserved slots; leave it if someone else declared it first.
			await setSteamId(env, me.id, steamId).catch(() => {});
			await refreshAuthComplete(env, me.id);
			await writeAudit(env, request, {
				actor: me,
				category: 'auth',
				action: 'account.link',
				outcome: 'ok',
				target: 'steam',
				message: `Linked Steam ${steamId}`
			});
		}
		redirect(303, state.next);
	}

	// Sign in.
	let userId = linked?.userId ?? null;
	if (!userId) {
		if (!state.signup) redirect(303, withError(state.back, 'steam_unknown'));
		let persona = '';
		let image: string | null = null;
		if (steamEnabled(env)) {
			const [profile] = await fetchSteam(env, [steamId]).catch(() => []);
			persona = profile?.persona ?? '';
			image = profile?.avatar ?? null;
		}
		const username = await freeUsername(env, persona || `steam${steamId.slice(-6)}`);
		try {
			userId = await createSsoUser(auth, env, {
				username,
				name: persona || username,
				image,
				provider: 'steam',
				accountId: steamId
			});
		} catch (err) {
			const known = normalizeError(err);
			console.error('steam sign-up', forLog(err));
			redirect(303, withError(state.back, known?.code || 'steam_signup'));
		}
		await setSteamId(env, userId, steamId).catch(() => {});
		await writeAudit(env, request, {
			actor: { id: userId, username },
			category: 'auth',
			action: 'signup',
			outcome: 'ok',
			target: username,
			message: 'Account created with Steam'
		});
	}
	const [row] = await env.db
		.select({ banned: user.banned })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);
	if (row?.banned) redirect(303, withError(state.back, 'steam_disabled'));
	try {
		await auth.api.signInUser({ body: { userId }, headers: request.headers });
	} catch (err) {
		if (err instanceof ApiError) throw err;
		console.error('steam sign-in', forLog(err));
		redirect(303, withError(state.back, 'steam'));
	}
	redirect(303, state.next);
};
