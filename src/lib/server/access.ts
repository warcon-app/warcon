// Who may do what. Three layers:
//   global role  (Better Auth user.role)  "owner" runs the whole panel: every org, every server, all users.
//   org role     (org_members)            "owner" manages one org: its servers, members and invite links,
//                                         and is admin on every server in it. "member" relies on grants.
//   server role  (server_grants)          viewer / operator / admin on one server.
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Env } from './env';
import { isDemoServer } from './env';
import { ApiError } from './http';
import {
	loginAttempts,
	orgMembers,
	organizations,
	serverGrants,
	servers,
	type OrgRow,
	type ServerRow
} from './db/schema';

export type { OrgRow, ServerRow };
export type GlobalRole = 'owner' | 'member';
export type OrgRole = 'owner' | 'member';
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
export const ORG_ROLES: OrgRole[] = ['owner', 'member'];

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

// --- orgs ---

export async function getOrg(env: Env, id: string): Promise<OrgRow | null> {
	const [row] = await env.db.select().from(organizations).where(eq(organizations.id, id)).limit(1);
	return row ?? null;
}

/** The user's role in one org; the site owner counts as owner everywhere. */
export async function orgRoleFor(
	env: Env,
	user: SessionUser,
	orgId: string
): Promise<OrgRole | null> {
	if (user.role === 'owner') return 'owner';
	const [row] = await env.db
		.select({ role: orgMembers.role })
		.from(orgMembers)
		.where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, user.id)))
		.limit(1);
	return row ? row.role : null;
}

export async function requireOrgRole(
	env: Env,
	locals: App.Locals,
	orgId: string,
	need: OrgRole
): Promise<{ org: OrgRow; role: OrgRole; user: SessionUser }> {
	const user = requireUser(locals);
	const org = await getOrg(env, orgId);
	const role = org ? await orgRoleFor(env, user, orgId) : null;
	if (!org || !role) throw new ApiError(404, 'Organisation not found.', 'not_found');
	if (org.suspendedAt && user.role !== 'owner')
		throw new ApiError(403, `${org.name} is suspended. Contact the site owner.`, 'suspended');
	if (need === 'owner' && role !== 'owner')
		throw new ApiError(403, `Only an owner of ${org.name} can do that.`, 'forbidden');
	return { org, role, user };
}

/** Ids of every org the user owns (all of them for the site owner). */
export async function ownedOrgIds(env: Env, user: SessionUser): Promise<string[]> {
	if (user.role === 'owner')
		return (await env.db.select({ id: organizations.id }).from(organizations)).map((r) => r.id);
	const found = await env.db
		.select({ orgId: orgMembers.orgId })
		.from(orgMembers)
		.where(and(eq(orgMembers.userId, user.id), eq(orgMembers.role, 'owner')));
	return found.map((r) => r.orgId);
}

export interface OrgSummary {
	id: string;
	name: string;
	slug: string;
	role: OrgRole;
	/** frozen by the site owner: members cannot open its servers, owners cannot add or invite */
	suspended: boolean;
}

/** Orgs the user belongs to, with their role; the site owner sees every org as owner. */
export async function userOrgs(env: Env, user: SessionUser): Promise<OrgSummary[]> {
	const shape = (o: OrgRow, role: OrgRole): OrgSummary => ({
		id: o.id,
		name: o.name,
		slug: o.slug,
		role,
		suspended: !!o.suspendedAt
	});
	if (user.role === 'owner') {
		const all = await env.db.select().from(organizations).orderBy(asc(organizations.name));
		return all.map((o) => shape(o, 'owner'));
	}
	const mine = await env.db
		.select({ org: organizations, role: orgMembers.role })
		.from(orgMembers)
		.innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
		.where(eq(orgMembers.userId, user.id))
		.orderBy(asc(organizations.name));
	return mine.map((r) => shape(r.org, r.role));
}

/** May the user add servers, manage members or mint invite links anywhere? Drives navigation. */
export const canManage = (user: SessionUser, orgs: OrgSummary[]) =>
	user.role === 'owner' || orgs.some((o) => o.role === 'owner' && !o.suspended);

// --- servers ---

export async function serverRoleFor(
	env: Env,
	user: SessionUser,
	serverId: string
): Promise<ServerRole | null> {
	if (user.role === 'owner') return 'admin';
	const [row] = await env.db
		.select({
			grant: serverGrants.role,
			orgRole: orgMembers.role,
			suspendedAt: organizations.suspendedAt
		})
		.from(servers)
		.innerJoin(organizations, eq(organizations.id, servers.orgId))
		.leftJoin(
			serverGrants,
			and(eq(serverGrants.serverId, servers.id), eq(serverGrants.userId, user.id))
		)
		.leftJoin(orgMembers, and(eq(orgMembers.orgId, servers.orgId), eq(orgMembers.userId, user.id)))
		.where(eq(servers.id, serverId))
		.limit(1);
	if (!row || row.suspendedAt) return null;
	if (row.orgRole === 'owner') return 'admin';
	return row.grant ?? null;
}

/** The server plus proof the user runs its org (site owner or org owner): edit, delete, grants. */
export async function requireServerManager(
	env: Env,
	locals: App.Locals,
	serverId: string
): Promise<{ server: ServerRow; user: SessionUser }> {
	const user = requireUser(locals);
	const server = await getServer(env, serverId);
	const role = server ? await serverRoleFor(env, user, serverId) : null;
	if (!server || !role) throw new ApiError(404, 'Server not found.', 'not_found');
	if ((await orgRoleFor(env, user, server.orgId)) !== 'owner')
		throw new ApiError(
			403,
			`Only an owner of the organisation that runs ${server.name} can do that.`,
			'forbidden'
		);
	return { server, user };
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
	orgId: string;
	orgName: string;
	name: string;
	host: string;
	port: number;
	scheme: 'http' | 'https';
	notes: string;
	role: ServerRole;
	/** true when the role comes from owning the org rather than a grant */
	manager: boolean;
	sortOrder: number;
	demo: boolean;
};

export function shapeServer(
	env: Env,
	s: ServerRow,
	orgName: string,
	role: ServerRole,
	manager: boolean
): ServerSummary {
	return {
		id: s.id,
		orgId: s.orgId,
		orgName,
		name: s.name,
		host: s.host,
		port: s.port,
		scheme: s.scheme,
		notes: s.notes,
		role,
		manager,
		sortOrder: s.sortOrder,
		demo: isDemoServer(env, s)
	};
}

/** Every server the user can open: all of them for the site owner, else owned-org servers plus grants. */
export async function accessibleServers(env: Env, user: SessionUser): Promise<ServerSummary[]> {
	const order = [asc(organizations.name), asc(servers.sortOrder), asc(servers.name)];
	if (user.role === 'owner') {
		const rowsAll = await env.db
			.select({ server: servers, orgName: organizations.name })
			.from(servers)
			.innerJoin(organizations, eq(organizations.id, servers.orgId))
			.orderBy(...order);
		return rowsAll.map((r) => shapeServer(env, r.server, r.orgName, 'admin', true));
	}
	const rows = await env.db
		.select({
			server: servers,
			orgName: organizations.name,
			grant: serverGrants.role,
			orgRole: orgMembers.role
		})
		.from(servers)
		.innerJoin(organizations, eq(organizations.id, servers.orgId))
		.leftJoin(
			serverGrants,
			and(eq(serverGrants.serverId, servers.id), eq(serverGrants.userId, user.id))
		)
		.leftJoin(orgMembers, and(eq(orgMembers.orgId, servers.orgId), eq(orgMembers.userId, user.id)))
		.where(
			and(
				isNull(organizations.suspendedAt),
				or(isNotNull(serverGrants.role), eq(orgMembers.role, 'owner'))
			)
		)
		.orderBy(...order);
	return rows.map((r) => {
		const manager = r.orgRole === 'owner';
		return shapeServer(env, r.server, r.orgName, manager ? 'admin' : r.grant!, manager);
	});
}

/**
 * What a non-site-owner may see in the audit log: their own rows, rows on servers they admin
 * (explicit admin grants plus everything in orgs they own), and rows of orgs they own.
 */
export async function auditVisibility(
	env: Env,
	user: SessionUser
): Promise<{ userId: string; adminServerIds: string[]; ownedOrgIds: string[] } | null> {
	if (user.role === 'owner') return null;
	const [granted, orgIds] = await Promise.all([
		env.db
			.select({ serverId: serverGrants.serverId })
			.from(serverGrants)
			.where(and(eq(serverGrants.userId, user.id), eq(serverGrants.role, 'admin'))),
		ownedOrgIds(env, user)
	]);
	const ids = new Set(granted.map((r) => r.serverId));
	if (orgIds.length) {
		const owned = await env.db
			.select({ id: servers.id })
			.from(servers)
			.where(inArray(servers.orgId, orgIds));
		for (const r of owned) ids.add(r.id);
	}
	return { userId: user.id, adminServerIds: [...ids], ownedOrgIds: orgIds };
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
