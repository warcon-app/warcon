import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit';
import { building } from '$app/environment';
import { json, redirect } from '@sveltejs/kit';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { authConfigured, getAuth, initAuth } from '$lib/server/auth';
import { keyUser, toSessionUser } from '$lib/server/access';
import { resolveBearer } from '$lib/server/apikeys';
import { looksLikeOurToken, parseBearer } from '$lib/server/apikeys-core';
import { assertRate } from '$lib/server/ratelimit';
import { getEnv, initEnv } from '$lib/server/env';
import { encryptionKey } from '$lib/server/crypto';
import {
	ApiError,
	apiError,
	CLIENT_IP_HEADER,
	clientIp,
	normalizeError,
	resolveClientIp
} from '$lib/server/http';
import { startPoller, stopPoller } from '$lib/server/poller';
import { setGateway } from '$lib/server/gateway';
import { localGateway } from '$lib/server/gateway-local';
import { connectRemoteGateway } from '$lib/server/gateway-remote';
import { loadSettings } from '$lib/server/settings';
import { beginShutdown } from '$lib/server/shutdown';

const SECURITY_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	// Not no-referrer: browsers then send `Origin: null` on form posts, which SvelteKit rejects as cross-site.
	'referrer-policy': 'same-origin',
	'x-robots-tag': 'noindex, nofollow'
};

// Routes a user who must change their password may still reach.
const PASSWORD_GATE_EXEMPT = /^\/(account|sign-out|join|api\/auth)(\/|$)/;
// The only Better Auth routes a browser must reach: the OAuth callback and its error page.
const AUTH_PUBLIC = /^\/api\/auth\/(callback\/[^/]+|error|ok)$/;
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Reads config, opens the database, applies migrations, builds Better Auth and starts the poller once per process. */
export const init: ServerInit = async () => {
	if (building) return;
	const env = await initEnv(); // also refuses a placeholder or short BETTER_AUTH_SECRET
	if (authConfigured(env)) initAuth(env);
	else
		console.warn('[warcon] BETTER_AUTH_SECRET is not set; the panel will refuse to serve pages.');
	if (env.ENCRYPTION_KEY)
		encryptionKey(env); // fail at startup, not on the first server add
	else console.warn('[warcon] ENCRYPTION_KEY is not set; servers cannot be added.');
	await loadSettings(env);
	if (env.WARCON_ROLE === 'web') {
		// The worker runs elsewhere: every game request, live read and lease goes over the relay.
		setGateway(connectRemoteGateway(env));
		// Settings saved on another web process reach this one within a few seconds.
		setInterval(() => void loadSettings(env).catch(() => {}), 10_000);
		console.log(`[warcon] web role; worker relay at ${env.RELAY_URL}`);
	} else {
		if (env.WARCON_ROLE === 'worker')
			throw new Error(
				'WARCON_ROLE=worker runs the worker binary (bun run worker), not the web server.'
			);
		setGateway(localGateway);
		startPoller(env, 'all');
	}
	installShutdown(env);
};

/**
 * Lets `docker stop` (a deploy) end the process promptly. adapter-node already closes the HTTP
 * server on SIGTERM and waits for in-flight requests; we end the long-lived event streams so that
 * wait is short, and once it reports the server closed we release the poller and the database
 * pool and exit, since either would otherwise keep the process alive until it is killed.
 */
function installShutdown(env: Awaited<ReturnType<typeof initEnv>>): void {
	let exiting = false;
	const onSignal = (signal: string) => {
		console.log(`[warcon] ${signal}: web stopping, finishing in-flight requests`);
		beginShutdown();
	};
	process.on('SIGTERM', () => onSignal('SIGTERM'));
	process.on('SIGINT', () => onSignal('SIGINT'));
	// Emitted by adapter-node after every connection has ended; not in `vite dev`.
	process.on('sveltekit:shutdown', () => {
		if (exiting) return;
		exiting = true;
		void (async () => {
			if (env.WARCON_ROLE !== 'web') await stopPoller().catch(() => {});
			await env.sql.end().catch(() => {});
			console.log('[warcon] web stopped');
			process.exit(0);
		})();
	});
}

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.user = null;
	event.locals.session = null;
	event.locals.apiKey = null;

	const secured: typeof resolve = async (ev, opts) => {
		const res = await resolve(ev, opts);
		for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.headers.set(k, v);
		return res;
	};

	if (building) return secured(event);
	const env = getEnv();

	// One trustworthy client address for audit rows and Better Auth sessions (overwrites anything the client sent).
	event.request.headers.set(CLIENT_IP_HEADER, resolveClientIp(event.getClientAddress));

	if (!authConfigured(env)) return secured(event);

	const auth = getAuth();
	event.locals.auth = auth;
	const path = event.url.pathname;
	const isAuthApi = path.startsWith('/api/auth');

	// Every Better Auth call the panel makes is server-side (auth.api.*) from a form action or API
	// route, behind the login lockout, the audit trail and the last-owner checks. Nothing in the
	// browser talks to /api/auth/* except the OAuth callback, so the rest is closed: nobody can sign
	// in, self-register or run admin-plugin endpoints around those checks. auth.ts lists the same
	// routes in Better Auth's own disabledPaths.
	if (isAuthApi && !AUTH_PUBLIC.test(path)) return json({ error: 'Not found.' }, { status: 404 });

	// Bots: an organisation API key as a bearer token, on the JSON API only. It stands in for the
	// session (cookies are ignored) and for the CSRF header (a browser cannot attach a bearer to a
	// cross-site request). A bad key never falls back to the cookie: it is simply refused.
	const authorization = event.request.headers.get('authorization');
	if (path.startsWith('/api/') && !isAuthApi && looksLikeOurToken(authorization)) {
		try {
			const token = parseBearer(authorization);
			if (!token) throw new ApiError(401, 'Malformed API key.', 'invalid_api_key');
			const principal = await resolveBearer(env, token);
			event.locals.apiKey = principal;
			event.locals.user = keyUser(principal);
		} catch (err) {
			if (err instanceof ApiError && err.status === 401) {
				try {
					assertRate(`apikey-bad:${clientIp(event.request)}`, 20, 60_000);
				} catch (limited) {
					return apiError(limited);
				}
			}
			return apiError(err);
		}
	}

	// CSRF guard for the JSON API: every mutation must carry the custom header (browsers never add
	// it to cross-site form posts or simple requests). Better Auth checks origins for its own routes.
	if (
		path.startsWith('/api/') &&
		!isAuthApi &&
		!event.locals.apiKey &&
		!SAFE_METHODS.has(event.request.method)
	) {
		if (event.request.headers.get('x-requested-with') !== 'warcon') {
			return json(
				{ ok: false, error: { message: 'Missing X-Requested-With: warcon header.', code: 'csrf' } },
				{ status: 403 }
			);
		}
	}

	if (!isAuthApi && !event.locals.apiKey) {
		try {
			const session = await auth.api.getSession({ headers: event.request.headers });
			if (session && !session.user.banned) {
				event.locals.user = toSessionUser(session.user);
				event.locals.session = {
					id: session.session.id,
					token: session.session.token,
					expiresAt: session.session.expiresAt
				};
			}
		} catch (err) {
			console.error('session lookup failed:', err instanceof Error ? err.stack : err);
		}

		if (event.locals.user?.mustChangePassword && !PASSWORD_GATE_EXEMPT.test(path)) {
			if (path.startsWith('/api/')) {
				return json(
					{
						ok: false,
						error: { message: 'You must change your password first.', code: 'must_change_password' }
					},
					{ status: 403 }
				);
			}
			redirect(303, '/account?force=1');
		}
	}

	return svelteKitHandler({ event, resolve: secured, auth, building });
};

export const handleError: HandleServerError = ({ error, status, message }) => {
	const known = normalizeError(error);
	if (known) return { message: known.message, code: known.code || undefined };
	if (status !== 404)
		console.error('unhandled', status, error instanceof Error ? error.stack : error);
	return { message: status === 404 ? 'Not found.' : message || 'Internal error.' };
};
