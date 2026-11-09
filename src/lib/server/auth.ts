// Better Auth wiring. Accounts, sessions and password handling live here; Warcon adds
// per-server roles (access.ts) and its own audit trail on top.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { like } from 'drizzle-orm';
import {
	account,
	passkey as passkeyTable,
	session,
	twoFactor as twoFactorTable,
	user,
	verification
} from './db/schema';
import { admin, twoFactor, username } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { count } from 'drizzle-orm';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { writeAudit } from './audit';
import { auditSelfDelete, beforeSelfDelete, eraseUserTraces } from './erasure';
import { discordEnabled, type Env } from './env';
import { ApiError, CLIENT_IP_HEADER, forLog } from './http';
import { warconSessions } from './auth-plugin';
import { refreshAuthComplete, startGrace } from './enrolment';
import { refuseMemberBeforeOwner } from './users';

export const authConfigured = (env: Partial<Env> | undefined) => Boolean(env?.BETTER_AUTH_SECRET);

/** Usernames are the login identity; Better Auth still wants an email column, so we synthesise one. */
export const EMAIL_SUFFIX = '@warcon.invalid';
export const emailFor = (username: string) => `${username.toLowerCase()}${EMAIL_SUFFIX}`;

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/i;
export const MIN_PASSWORD = 10;

const USERNAME_MAX = 32;

/**
 * Accounts created by Discord (through an invite link) need a panel username. Derive one from the
 * Discord handle, then add a numeric suffix until it is free. Runs in the provider's profile
 * mapper, before the username plugin validates the row, so a taken handle becomes "handle2"
 * instead of a failed sign-in. One query fetches every name that could collide.
 */
export async function freeUsername(env: Env, wanted: string): Promise<string> {
	const base =
		wanted
			.toLowerCase()
			.replace(/[^a-z0-9._-]+/g, '')
			.replace(/^[._-]+/, '')
			.slice(0, USERNAME_MAX) || 'user';
	const taken = new Set(
		(
			await env.db
				.select({ username: user.username })
				.from(user)
				.where(like(user.username, `${base}%`))
		).map((r) => (r.username ?? '').toLowerCase())
	);
	for (let n = 1; n <= 1000; n++) {
		const suffix = n === 1 ? '' : String(n);
		const candidate = base.slice(0, USERNAME_MAX - suffix.length) + suffix;
		if (USERNAME_RE.test(candidate) && !taken.has(candidate)) return candidate;
	}
	return `${base.slice(0, 20)}${Date.now().toString(36)}`;
}

/**
 * Better Auth routes the browser must never reach. The panel calls every one of these through
 * auth.api.* on the server, behind its own lockout, audit trail and ownership checks; over HTTP they
 * would skip all of that (a direct sign-in dodges the lockout, admin/set-role can demote the last
 * owner, admin/set-user-password leaves sessions alive). Better Auth answers 404 for them;
 * hooks.server.ts closes the rest of /api/auth/* as well.
 */
const DISABLED_PATHS = [
	'/sign-in/email',
	'/sign-in/username',
	'/sign-in/social',
	'/sign-up/email',
	'/is-username-available',
	'/update-user',
	'/change-password',
	'/set-password',
	'/change-email',
	'/delete-user',
	'/delete-user/callback',
	'/admin/create-user',
	'/admin/list-users',
	'/admin/get-user',
	'/admin/set-role',
	'/admin/ban-user',
	'/admin/unban-user',
	'/admin/list-user-sessions',
	'/admin/revoke-user-session',
	'/admin/revoke-user-sessions',
	'/admin/impersonate-user',
	'/admin/stop-impersonating',
	'/admin/remove-user',
	'/admin/set-user-password',
	'/admin/update-user',
	'/admin/has-permission',
	'/two-factor/enable',
	'/two-factor/disable',
	'/two-factor/get-totp-uri',
	'/two-factor/verify-totp',
	'/two-factor/send-otp',
	'/two-factor/verify-otp',
	'/two-factor/generate-backup-codes',
	'/two-factor/verify-backup-code',
	'/two-factor/view-backup-codes',
	'/passkey/generate-register-options',
	'/passkey/verify-registration',
	'/passkey/generate-authenticate-options',
	'/passkey/verify-authentication',
	'/passkey/list-user-passkeys',
	'/passkey/delete-passkey',
	'/passkey/update-passkey',
	'/warcon/sign-in-user'
];

/**
 * A passkey-first sign-up carries who the account is for from the options step to the
 * verification step, inside the server-stored challenge (the browser only ever sees an opaque
 * challenge id), so the role in here is trustworthy.
 */
export interface PasskeySignup {
	username: string;
	name: string;
	role: 'owner' | 'member';
	/** first-run setup: only valid while the panel still has no users */
	setup?: boolean;
}

// Global roles: "owner" runs the panel (every admin-plugin permission), "member" only sees
// servers they are granted. Per-server roles live in server_grants, not here.
const ac = createAccessControl(defaultStatements);
const ROLES = {
	owner: ac.newRole({ ...adminAc.statements }),
	member: ac.newRole({ ...userAc.statements })
};

function build(env: Env) {
	const discord = discordEnabled(env);
	return betterAuth({
		appName: env.APP_NAME || 'Warcon',
		baseURL: env.ORIGIN,
		secret: env.BETTER_AUTH_SECRET,
		// Better Auth logs a failed endpoint's error as it is, and a failed query's message lists its
		// parameters (a session token, a password hash): it goes through forLog like ours.
		logger: {
			log: (level, message, ...args) =>
				console[level]('[Better Auth]', forLog(message), ...args.map(forLog))
		},
		database: drizzleAdapter(env.db, {
			provider: 'pg',
			schema: {
				user,
				session,
				account,
				verification,
				twoFactor: twoFactorTable,
				passkey: passkeyTable
			}
		}),
		emailAndPassword: {
			enabled: true,
			minPasswordLength: MIN_PASSWORD,
			maxPasswordLength: 200
			// Hashing is Better Auth's default: native node:crypto scrypt (N=16384, r=16) on Bun.
		},
		user: {
			additionalFields: {
				mustChangePassword: { type: 'boolean', defaultValue: false, input: false },
				defaultOrgId: { type: 'string', required: false, input: false },
				authComplete: { type: 'boolean', defaultValue: false, input: false },
				authGraceStartedAt: { type: 'date', required: false, input: false }
			},
			// Self-service deletion from the account page (right to erasure). The endpoint checks the
			// password when one is given; erasure.ts refuses to orphan the panel or an organisation and
			// pseudonymises the audit trail afterwards.
			deleteUser: {
				enabled: true,
				beforeDelete: (u) => beforeSelfDelete(env, u),
				afterDelete: async (u, request) => {
					await eraseUserTraces(env, u);
					if (request) await auditSelfDelete(env, request, u);
				}
			}
		},
		account: {
			accountLinking: {
				// Emails here are placeholders (name@warcon.invalid, <id>@discord.invalid) and Discord is
				// asked for no email at all, so the same-email rule would block every link. Linking is
				// only ever started by a signed-in user from the account page.
				allowDifferentEmails: true
			}
		},
		socialProviders: discord
			? {
					discord: {
						clientId: env.DISCORD_CLIENT_ID!,
						clientSecret: env.DISCORD_CLIENT_SECRET!,
						disableDefaultScope: true,
						// Discord signs in users who linked it. New accounts only appear through an invite
						// link (/join/<token> passes requestSignUp); hooks.server.ts blocks the public endpoint.
						disableImplicitSignUp: true,
						scope: ['identify'],
						// Better Auth calls this on every Discord callback but only uses the result when it
						// creates an account (existing users are matched by provider account id), so the
						// derived username is exactly what the username plugin validates on creation.
						mapProfileToUser: async (profile) => {
							const username = await freeUsername(env, profile.username);
							return {
								name: profile.global_name || profile.username,
								username,
								displayUsername: username,
								email: `${profile.id}@discord.invalid`,
								emailVerified: true,
								image: profile.avatar
									? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128`
									: undefined
							};
						}
					}
				}
			: undefined,
		session: {
			expiresIn: 60 * 60 * 24 * 7,
			updateAge: 60 * 60 * 24,
			// No cookie cache: disabling a user or revoking a session must take effect on the next request.
			cookieCache: { enabled: false }
		},
		databaseHooks: {
			user: {
				create: {
					// Password, passkey, Steam and Discord accounts are all made through here.
					before: async (u) => {
						await refuseMemberBeforeOwner(env, (u as { role?: unknown }).role);
					}
				}
			},
			session: {
				create: {
					// The address is read for throttling and never kept: a session is stored without it.
					before: async (session) => ({ data: { ...session, ipAddress: null } }),
					after: async (session) => {
						await writeAudit(env, null, {
							actor: { id: session.userId, username: '' },
							category: 'auth',
							action: 'login',
							outcome: 'ok',
							userAgent: session.userAgent ?? ''
						}).catch((err) => console.error('audit login', forLog(err)));
						// The sign-in rules: start the grace clock on the first sign-in and re-check the
						// verdict, in case a method changed through a path that did not refresh it.
						await startGrace(env, session.userId);
						await refreshAuthComplete(env, session.userId).catch((err) =>
							console.error('enrolment refresh', forLog(err))
						);
					}
				}
			},
			account: {
				create: {
					// Discord and Steam links land here through their callbacks.
					after: async (a) => {
						await refreshAuthComplete(env, a.userId).catch((err) =>
							console.error('enrolment refresh', forLog(err))
						);
					}
				}
			}
		},
		advanced: {
			cookiePrefix: 'warcon',
			useSecureCookies: env.ORIGIN.startsWith('https://'),
			// hooks.server.ts copies the client address adapter-node resolved into this header.
			ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] }
		},
		trustedOrigins: [env.ORIGIN],
		disabledPaths: DISABLED_PATHS,
		plugins: [
			username({
				minUsernameLength: 2,
				maxUsernameLength: USERNAME_MAX,
				usernameValidator: (u) => USERNAME_RE.test(u)
			}),
			admin({ ac, roles: ROLES, defaultRole: 'member', adminRoles: ['owner'] }),
			twoFactor({
				issuer: env.APP_NAME || 'Warcon',
				// Passkey-only and Discord-only accounts have no password to confirm with.
				allowPasswordless: true,
				backupCodeOptions: { storeBackupCodes: 'encrypted' }
			}),
			passkey({
				rpID: new URL(env.ORIGIN).hostname,
				rpName: env.APP_NAME || 'Warcon',
				origin: env.ORIGIN,
				registration: {
					// Signed-in users add passkeys to their own account (the plugin still uses the session
					// when there is one). Without a session this is a passkey-first sign-up: the account is
					// created only once the passkey is verified, so an abandoned attempt leaves nothing.
					requireSession: false,
					resolveUser: ({ context }) => {
						const signup = parseSignup(context);
						return {
							id: crypto.randomUUID(),
							name: signup.name,
							email: emailFor(signup.username),
							displayName: signup.username
						};
					},
					afterVerification: async ({ ctx, context }) => {
						if (!context) return;
						const signup = parseSignup(context);
						if (signup.setup) {
							const [row] = await env.db.select({ n: count() }).from(user);
							if ((row?.n ?? 0) > 0) throw new ApiError(409, 'Setup already completed.');
						}
						const [taken] = await env.db
							.select({ id: user.id })
							.from(user)
							.where(like(user.username, signup.username.toLowerCase()))
							.limit(1);
						if (taken) throw new ApiError(409, 'That username is taken.');
						const created = await ctx.context.internalAdapter.createUser(
							{
								email: emailFor(signup.username),
								emailVerified: true,
								name: signup.name,
								username: signup.username.toLowerCase(),
								displayUsername: signup.username,
								role: signup.role,
								createdAt: new Date(),
								updatedAt: new Date()
							},
							{ method: 'passkey' }
						);
						return { userId: created.id };
					}
				}
			}),
			warconSessions(),
			sveltekitCookies(getRequestEvent)
		]
	});
}

function parseSignup(context: string | null | undefined): PasskeySignup {
	let parsed: Partial<PasskeySignup> = {};
	try {
		parsed = context ? (JSON.parse(context) as Partial<PasskeySignup>) : {};
	} catch {
		parsed = {};
	}
	const username = String(parsed.username ?? '');
	if (!USERNAME_RE.test(username)) throw new ApiError(400, 'Sign-up details are missing.');
	return {
		username,
		name: String(parsed.name ?? '').slice(0, 80) || username,
		role: parsed.role === 'owner' ? 'owner' : 'member',
		setup: !!parsed.setup
	};
}

export type Auth = ReturnType<typeof build>;

let instance: Auth | null = null;

/** Builds the single Better Auth instance for this process. Called once from the server init hook. */
export function initAuth(env: Env): Auth {
	instance = build(env);
	return instance;
}

export function getAuth(): Auth {
	if (!instance) throw new Error('Auth not initialised yet.');
	return instance;
}
