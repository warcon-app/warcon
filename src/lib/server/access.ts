// Who may do what: global roles come from Better Auth's user.role, per-server roles from server_grants.
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Env } from './env';
import { flag } from './env';
import { ApiError } from './http';
import { loginAttempts, serverGrants, servers, type ServerRow } from './db/schema';

export type { ServerRow };
export type GlobalRole = 'owner' | 'member';
export type ServerRole = 'viewer' | 'operator' | 'admin';

export interface SessionUser {
	id: string;
	username: string;
	name: string;
	role: GlobalRole;
	mustChangePassword: boolean;
	image: string | null;
}

export const ROLE_RANK: Record<ServerRole, number> = { viewer: 1, operator: 2, admin: 3 };
export const SERVER_ROLES: ServerRole[] = ['viewer', 'operator', 'admin'];

export const roleAtLeast = (have: ServerRole | null | undefined, need: ServerRole) =>
	!!have && ROLE_RANK[have] >= ROLE_RANK[need];

/** Shape a Better Auth user (with username + admin plugin fields) into what pages need. */
export function toSessionUser(u: Record<string, unknown>): SessionUser {
	return {
		id: String(u.id),
		username: String(u.username ?? u.displayUsername ?? '') || String(u.email ?? '').split('@')[0],
		name: String(u.name ?? '') || String(u.displayUsername ?? u.username ?? ''),
		role: u.role === 'owner' ? 'owner' : 'member',
		mustChangePassword: Boolean(u.mustChangePassword),
		image: typeof u.image === 'string' ? u.image : null
	};
}

export const requireUser = (locals: App.Locals): SessionUser => {
	if (!locals.user) throw new ApiError(401, 'Sign in required.', 'unauthenticated');
	return locals.user;
};

export const requireOwner = (locals: App.Locals): SessionUser => {
	const user = requireUser(locals);
	if (user.role !== 'owner') throw new ApiError(403, 'Owner access required.', 'forbidden');
	return user;
};

export async function getServer(env: Env, id: string): Promise<ServerRow | null> {
	const [row] = await env.db.select().from(servers).where(eq(servers.id, id)).limit(1);
	return row ?? null;
}

export async function serverRoleFor(
	env: Env,
	user: SessionUser,
	serverId: string
): Promise<ServerRole | null> {
	if (user.role === 'owner') return 'admin';
	const [row] = await env.db
		.select({ role: serverGrants.role })
		.from(serverGrants)
		.where(and(eq(serverGrants.serverId, serverId), eq(serverGrants.userId, user.id)))
		.limit(1);
	return row ? row.role : null;
}

export async function requireServerRole(
	env: Env,
	locals: App.Locals,
	serverId: string,
	need: ServerRole
): Promise<{ server: ServerRow; role: ServerRole }> {
	const user = requireUser(locals);
	const server = await getServer(env, serverId);
	const role = server ? await serverRoleFor(env, user, serverId) : null;
	if (!server || !role) throw new ApiError(404, 'Server not found.', 'not_found');
	if (!roleAtLeast(role, need)) {
		throw new ApiError(
			403,
			`This action needs the '${need}' role on ${server.name}; you have '${role}'.`,
			'forbidden'
		);
	}
	return { server, role };
}

export type ServerSummary = {
	id: string;
	name: string;
	host: string;
	port: number;
	scheme: 'http' | 'https';
	notes: string;
	role: ServerRole;
	sortOrder: number;
	demo: boolean;
};

export async function accessibleServers(env: Env, user: SessionUser): Promise<ServerSummary[]> {
	const demo = flag(env.ALLOW_DEMO_SERVER, false);
	const shape = (s: ServerRow, role: ServerRole): ServerSummary => ({
		id: s.id,
		name: s.name,
		host: s.host,
		port: s.port,
		scheme: s.scheme,
		notes: s.notes,
		role,
		sortOrder: s.sortOrder,
		demo: demo && s.host === 'demo'
	});
	if (user.role === 'owner') {
		const rowsAll = await env.db
			.select()
			.from(servers)
			.orderBy(asc(servers.sortOrder), asc(servers.name));
		return rowsAll.map((s) => shape(s, 'admin'));
	}
	const granted = await env.db
		.select({ server: servers, role: serverGrants.role })
		.from(servers)
		.innerJoin(serverGrants, eq(serverGrants.serverId, servers.id))
		.where(eq(serverGrants.userId, user.id))
		.orderBy(asc(servers.sortOrder), asc(servers.name));
	return granted.map((r) => shape(r.server, r.role));
}

export async function adminServerIds(env: Env, user: SessionUser): Promise<string[]> {
	const found = await env.db
		.select({ serverId: serverGrants.serverId })
		.from(serverGrants)
		.where(and(eq(serverGrants.userId, user.id), eq(serverGrants.role, 'admin')));
	return found.map((r) => r.serverId);
}

// --- login throttling (the sign-in form action calls Better Auth server-side, so its HTTP rate limiter does not apply) ---

const LOCK_AFTER_USER = 8;
const LOCK_AFTER_IP = 40;
const LOCK_MINUTES = 15;
const WINDOW_MINUTES = 30;

export async function loginLockSeconds(env: Env, keys: string[]): Promise<number> {
	const now = Date.now();
	let worst = 0;
	for (const key of keys) {
		const [row] = await env.db
			.select({ lockedUntil: loginAttempts.lockedUntil })
			.from(loginAttempts)
			.where(eq(loginAttempts.key, key))
			.limit(1);
		if (row?.lockedUntil) {
			const remaining = Math.ceil((row.lockedUntil.getTime() - now) / 1000);
			if (remaining > worst) worst = remaining;
		}
	}
	return worst;
}

export async function noteLoginFailure(env: Env, keys: string[]): Promise<void> {
	const now = new Date();
	for (const key of keys) {
		const [row] = await env.db
			.select({ count: loginAttempts.count, firstAt: loginAttempts.firstAt })
			.from(loginAttempts)
			.where(eq(loginAttempts.key, key))
			.limit(1);
		let count = 1;
		let firstAt = now;
		if (row && now.getTime() - row.firstAt.getTime() < WINDOW_MINUTES * 60 * 1000) {
			count = row.count + 1;
			firstAt = row.firstAt;
		}
		const limit = key.startsWith('ip:') ? LOCK_AFTER_IP : LOCK_AFTER_USER;
		const lockedUntil = count >= limit ? new Date(now.getTime() + LOCK_MINUTES * 60 * 1000) : null;
		await env.db
			.insert(loginAttempts)
			.values({ key, count, firstAt, lockedUntil })
			.onConflictDoUpdate({ target: loginAttempts.key, set: { count, firstAt, lockedUntil } });
	}
}

export async function clearLoginFailures(env: Env, keys: string[]): Promise<void> {
	for (const key of keys) await env.db.delete(loginAttempts).where(eq(loginAttempts.key, key));
}

/** Handy for raw SQL fragments that need the current time from the database's clock. */
export const dbNow = sql`now()`;
