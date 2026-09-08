// Better Auth wiring. Accounts, sessions and password handling live here; Warcon adds
// per-server roles (access.ts) and its own audit trail on top.
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { account, session, user, verification } from './db/schema';
import { admin, username } from 'better-auth/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc, defaultStatements, userAc } from 'better-auth/plugins/admin/access';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { hashPassword, verifyPassword } from './crypto';
import { writeAudit } from './audit';
import type { Env } from './env';
import { CLIENT_IP_HEADER } from './http';

export const authConfigured = (env: Partial<Env> | undefined) => Boolean(env?.BETTER_AUTH_SECRET);

/** Usernames are the login identity; Better Auth still wants an email column, so we synthesise one. */
export const EMAIL_SUFFIX = '@warcon.invalid';
export const emailFor = (username: string) => `${username.toLowerCase()}${EMAIL_SUFFIX}`;

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/i;
export const MIN_PASSWORD = 10;

// Global roles: "owner" runs the panel (every admin-plugin permission), "member" only sees
// servers they are granted. Per-server roles live in server_grants, not here.
const ac = createAccessControl(defaultStatements);
const ROLES = {
	owner: ac.newRole({ ...adminAc.statements }),
	member: ac.newRole({ ...userAc.statements })
};

const cache = new WeakMap<object, ReturnType<typeof build>>();

function build(env: Env, baseURL: string) {
	const discord = env.DISCORD_CLIENT_ID && env.DISCORD_CLIENT_SECRET;
	return betterAuth({
		appName: env.APP_NAME || 'Warcon',
		baseURL,
		secret: env.BETTER_AUTH_SECRET,
		database: drizzleAdapter(env.db, {
			provider: 'pg',
			schema: { user, session, account, verification }
		}),
		emailAndPassword: {
			enabled: true,
			minPasswordLength: MIN_PASSWORD,
			maxPasswordLength: 200,
			// Native PBKDF2 keeps login inside the Workers CPU budget; the default scrypt is pure JS.
			password: {
				hash: hashPassword,
				verify: ({ hash, password }) => verifyPassword(password, hash)
			}
		},
		user: {
			additionalFields: {
				mustChangePassword: { type: 'boolean', defaultValue: false, input: false }
			}
		},
		socialProviders: discord
			? {
					discord: {
						clientId: env.DISCORD_CLIENT_ID!,
						clientSecret: env.DISCORD_CLIENT_SECRET!,
						disableDefaultScope: true,
						// Accounts are created by the owner; Discord only signs in users who linked it.
						disableImplicitSignUp: true,
						scope: ['identify'],
						mapProfileToUser: (profile) => ({
							name: profile.global_name || profile.username,
							email: `${profile.id}@discord.invalid`,
							emailVerified: true,
							image: profile.avatar
								? `https://cdn.discordapp.com/avatars/${profile.id}/${profile.avatar}.png?size=128`
								: undefined
						})
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
			session: {
				create: {
					after: async (session) => {
						await writeAudit(env, null, {
							actor: { id: session.userId, username: '' },
							category: 'auth',
							action: 'login',
							outcome: 'ok',
							ip: session.ipAddress ?? '',
							userAgent: session.userAgent ?? ''
						}).catch((err) => console.error('audit login', err));
					}
				}
			}
		},
		advanced: {
			cookiePrefix: 'warcon',
			useSecureCookies: baseURL.startsWith('https://'),
			// hooks.server.ts resolves the real client address (proxy-aware) into this header.
			ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] }
		},
		trustedOrigins: [baseURL],
		plugins: [
			username({
				minUsernameLength: 2,
				maxUsernameLength: 32,
				usernameValidator: (u) => USERNAME_RE.test(u)
			}),
			admin({ ac, roles: ROLES, defaultRole: 'member', adminRoles: ['owner'] }),
			sveltekitCookies(getRequestEvent)
		]
	});
}

export function getAuth(env: Env, baseURL: string) {
	let auth = cache.get(env.db);
	if (!auth) {
		auth = build(env, baseURL);
		cache.set(env.db, auth);
	}
	return auth;
}

export type Auth = ReturnType<typeof build>;
