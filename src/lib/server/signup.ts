// Self-service: creating your own account (from an invite link or the sign-up page) and, when
// ALLOW_ORG_SIGNUP is on, your own organisation.
import { fail, redirect, type RequestEvent } from '@sveltejs/kit';
import { count, eq } from 'drizzle-orm';
import { flag, maxOrgsPerUser, turnstileSiteKey, type Env } from './env';
import { ApiError, clientIp, normalizeError, str } from './http';
import { writeAudit } from './audit';
import { loginLockSeconds, noteLoginFailure, type SessionUser } from './access';
import { createUser, validatePassword, validateUsername } from './users';
import { organizations } from './db/schema';

export const orgSignupEnabled = (env: Pick<Env, 'ALLOW_ORG_SIGNUP'>) =>
	flag(env.ALLOW_ORG_SIGNUP, false);

/** How many more orgs this user may create; null means unlimited. */
export async function orgsRemaining(env: Env, user: SessionUser): Promise<number | null> {
	if (user.role === 'owner') return null;
	if (!orgSignupEnabled(env)) return 0;
	const [row] = await env.db
		.select({ n: count() })
		.from(organizations)
		.where(eq(organizations.createdBy, user.id));
	return Math.max(0, maxOrgsPerUser(env) - (row?.n ?? 0));
}

export async function assertMayCreateOrg(env: Env, user: SessionUser): Promise<void> {
	const left = await orgsRemaining(env, user);
	if (left === null || left > 0) return;
	if (!orgSignupEnabled(env))
		throw new ApiError(403, 'Only the site owner can create organisations here.', 'forbidden');
	throw new ApiError(
		403,
		`You have already created ${maxOrgsPerUser(env)} organisations; ask the site owner if you need more.`,
		'forbidden'
	);
}

// --- Cloudflare Turnstile (optional): the password sign-up forms carry a challenge token -------

const SITEVERIFY = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/**
 * Checks the widget token with Cloudflare. Returns a message to show the visitor when the token
 * is missing, bad, or Cloudflare cannot be reached (fail closed), or null when it passed.
 */
export async function verifyTurnstile(env: Env, token: string, ip: string): Promise<string | null> {
	if (!turnstileSiteKey(env)) return null;
	if (!token) return 'Please complete the verification challenge.';
	try {
		const body = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY!, response: token });
		if (ip) body.set('remoteip', ip);
		const res = await fetch(SITEVERIFY, {
			method: 'POST',
			body,
			signal: AbortSignal.timeout(8000)
		});
		const data = (await res.json()) as { success?: boolean; 'error-codes'?: string[] };
		if (data.success) return null;
		console.warn('turnstile rejected', data['error-codes']);
		return 'Verification failed. Reload the page and try again.';
	} catch (err) {
		console.error('turnstile siteverify', err instanceof Error ? err.message : err);
		return 'Could not verify the challenge right now. Try again in a moment.';
	}
}

// Self-registration shares the login throttle table: 8 attempts per IP in 30 minutes, then a
// 15-minute lock. Successful sign-ups count too, so one address cannot mint accounts in bulk.
const signupKeys = (req: Request) => [`signup:${clientIp(req) || 'unknown'}`];

/**
 * Form action body for "create a username and password" on the join and sign-up pages: makes the
 * account, signs it in, and returns to `here`. Returns a `fail()` with the form values on error.
 */
export async function registerFromForm(event: RequestEvent, env: Env, here: string) {
	const { request, locals } = event;
	if (locals.user) redirect(303, here);
	const form = await request.formData();
	const values = {
		username: str(form.get('username'), 32),
		displayName: str(form.get('displayName'), 80)
	};
	const keys = signupKeys(request);
	const lock = await loginLockSeconds(env, keys);
	if (lock > 0) {
		await writeAudit(env, request, {
			category: 'auth',
			action: 'signup',
			outcome: 'denied',
			target: values.username,
			message: `Locked out for ${lock}s`
		});
		return fail(429, {
			error: `Too many sign-ups from your address. Try again in ${Math.ceil(lock / 60)} minute(s).`,
			...values
		});
	}
	await noteLoginFailure(env, keys);
	const challenge = await verifyTurnstile(
		env,
		str(form.get('cf-turnstile-response'), 4000),
		clientIp(request)
	);
	if (challenge) {
		await writeAudit(env, request, {
			category: 'auth',
			action: 'signup',
			outcome: 'denied',
			target: values.username,
			message: `Turnstile: ${challenge}`
		});
		return fail(403, { error: challenge, ...values });
	}
	try {
		const username = validateUsername(values.username);
		const password = validatePassword(form.get('password'));
		const id = await createUser(locals.auth!, env, undefined, {
			username,
			password,
			displayName: values.displayName,
			role: 'member',
			mustChangePassword: false
		});
		await writeAudit(env, request, {
			actor: { id, username },
			category: 'auth',
			action: 'signup',
			outcome: 'ok',
			target: username
		});
		// Sets the session cookie through the SvelteKit cookie plugin, like first-run setup does.
		await locals.auth!.api.signInUsername({
			body: { username, password },
			headers: request.headers
		});
	} catch (err) {
		const known = normalizeError(err);
		if (!known) throw err;
		await writeAudit(env, request, {
			category: 'auth',
			action: 'signup',
			outcome: 'denied',
			target: values.username,
			message: known.message
		});
		return fail(known.status, { error: known.message, ...values });
	}
	redirect(303, here);
}
