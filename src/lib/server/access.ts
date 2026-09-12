// Who may do what. Three layers:
//   global role  (Better Auth user.role)  "owner" runs the whole panel: every org, every server, all users.
//   org role     (org_members)            "owner" manages one org: its servers, members and invite links,
//                                         and is admin on every server in it. "member" relies on grants.
//   server role  (server_grants -> org_roles) a named capability set on one server ($lib/capabilities).
import { and, asc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import type { Env } from './env';
import { isDemoServer } from './env';
import { ApiError } from './http';
import { CAPABILITY_INFO, type Capability } from '../capabilities';
import { accessFromCaps, resolveAccess, type ServerAccess } from './access-resolve';
import { keyActorId, keyActorName, keyCoversServer, type ApiKeyPrincipal } from './apikeys-core';
import {
	loginAttempts,
	orgMembers,
	orgRoles,
	organizations,
	serverGrants,
	servers,
	type OrgRow,
	type ServerRow
} from './db/schema';

export type { OrgRow, ServerRow, ServerAccess };
export type GlobalRole = 'owner' | 'member';
export type OrgRole = 'owner' | 'member';

export interface SessionUser {
	id: string;
	username: string;
	name: string;
	role: GlobalRole;
	mustChangePassword: boolean;
	image: string | null;
	/** the org the panel opens scoped to, unless a session scope overrides it; null = all */
	defaultOrgId: string | null;
	/** set when this "user" is really an organisation API key (see apikeys.ts) */
	apiKey?: ApiKeyPrincipal | null;
}

/** The synthetic user an API key acts as: its own actor id, so audit rows and author columns read naturally. */
export const keyUser = (k: ApiKeyPrincipal): SessionUser => ({
	id: keyActorId(k.id),
	username: keyActorName(k.label),
	name: k.label,
	role: 'member',
	mustChangePassword: false,
	image: null,
	defaultOrgId: k.orgId,
	apiKey: k
});

const keyForbidden = () =>
	new ApiError(403, 'API keys cannot manage an organisation or the panel.', 'api_key_forbidden');

export const ORG_ROLES: OrgRole[] = ['owner', 'member'];

/** jsonb containment: does this role's capability list include `cap`? */
const hasCap = (cap: Capability) =>
	sql`${orgRoles.capabilities} @> ${JSON.stringify([cap])}::jsonb`;

/** Shape a Better Auth user (with username + admin plugin fields) into what pages need. */
export function toSessionUser(u: Record<string, unknown>): SessionUser {
	return {
		id: String(u.id),
		username: String(u.username ?? u.displayUsername ?? '') || String(u.email ?? '').split('@')[0],
		name: String(u.name ?? '') || String(u.displayUsername ?? u.username ?? ''),
		role: u.role === 'owner' ? 'owner' : 'member',
		mustChangePassword: Boolean(u.mustChangePassword),
		image: typeof u.image === 'string' ? u.image : null,
		defaultOrgId: typeof u.defaultOrgId === 'string' && u.defaultOrgId ? u.defaultOrgId : null
	};
}

export const requireUser = (locals: App.Locals): SessionUser => {
	if (!locals.user) throw new ApiError(401, 'Sign in required.', 'unauthenticated');
	return locals.user;
};

export const requireOwner = (locals: App.Locals): SessionUser => {
	const user = requireUser(locals);
	if (user.apiKey) throw keyForbidden();
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
	if (user.apiKey) return null;
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
	if (user.apiKey) throw keyForbidden();
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
	if (user.apiKey) return [];
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
	/** may open the org's ban and reserved lists: owners, and anyone whose role on one of its servers includes lists.edit */
	lists: boolean;
}

/** Servers (with their orgs) where the user's granted role includes `cap`. */
async function grantedWith(
	env: Env,
	user: SessionUser,
	cap: Capability
): Promise<{ serverId: string; orgId: string }[]> {
	return env.db
		.select({ serverId: serverGrants.serverId, orgId: servers.orgId })
		.from(serverGrants)
		.innerJoin(servers, eq(servers.id, serverGrants.serverId))
		.innerJoin(orgRoles, eq(orgRoles.id, serverGrants.roleId))
		.where(and(eq(serverGrants.userId, user.id), hasCap(cap)));
}

/** Orgs the user belongs to, with their role; the site owner sees every org as owner. */
export async function userOrgs(env: Env, user: SessionUser): Promise<OrgSummary[]> {
	const shape = (o: OrgRow, role: OrgRole, lists: boolean): OrgSummary => ({
		id: o.id,
		name: o.name,
		slug: o.slug,
		role,
		suspended: !!o.suspendedAt,
		lists
	});
	if (user.apiKey) {
		const o = await getOrg(env, user.apiKey.orgId);
		return o && !o.suspendedAt
			? [shape(o, 'member', user.apiKey.capabilities.includes('lists.edit'))]
			: [];
	}
	if (user.role === 'owner') {
		const all = await env.db.select().from(organizations).orderBy(asc(organizations.name));
		return all.map((o) => shape(o, 'owner', true));
	}
	const [mine, adminOrgs] = await Promise.all([
		env.db
			.select({ org: organizations, role: orgMembers.role })
			.from(orgMembers)
			.innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
			.where(eq(orgMembers.userId, user.id))
			.orderBy(asc(organizations.name)),
		grantedWith(env, user, 'lists.edit').then((rows) => new Set(rows.map((r) => r.orgId)))
	]);
	return mine.map((r) =>
		shape(r.org, r.role, !r.org.suspendedAt && (r.role === 'owner' || adminOrgs.has(r.org.id)))
	);
}

// --- org lists (bans and reserved slots) ---

/** owner: the org's owners; editor: holds lists.edit on at least one of its servers. Both may add and remove entries. */
export type ListsRole = 'owner' | 'editor';

export async function listsRoleFor(
	env: Env,
	user: SessionUser,
	orgId: string
): Promise<ListsRole | null> {
	if (user.apiKey)
		return user.apiKey.orgId === orgId && user.apiKey.capabilities.includes('lists.edit')
			? 'editor'
			: null;
	if ((await orgRoleFor(env, user, orgId)) === 'owner') return 'owner';
	const [row] = await env.db
		.select({ serverId: serverGrants.serverId })
		.from(serverGrants)
		.innerJoin(servers, eq(servers.id, serverGrants.serverId))
		.innerJoin(orgRoles, eq(orgRoles.id, serverGrants.roleId))
		.where(and(eq(serverGrants.userId, user.id), eq(servers.orgId, orgId), hasCap('lists.edit')))
		.limit(1);
	return row ? 'editor' : null;
}

/** Like requireOrgRole, for the ban and reserved lists: lists.edit holders count as editors. */
export async function requireListsRole(
	env: Env,
	locals: App.Locals,
	orgId: string,
	need: ListsRole = 'editor'
): Promise<{ org: OrgRow; role: ListsRole; user: SessionUser }> {
	const user = requireUser(locals);
	const org = await getOrg(env, orgId);
	const role = org ? await listsRoleFor(env, user, orgId) : null;
	if (!org || !role) throw new ApiError(404, 'Organisation not found.', 'not_found');
	if (org.suspendedAt && user.role !== 'owner')
		throw new ApiError(403, `${org.name} is suspended. Contact the site owner.`, 'suspended');
	if (need === 'owner' && role !== 'owner')
		throw new ApiError(403, `Only an owner of ${org.name} can do that.`, 'forbidden');
	return { org, role, user };
}

/** May the user add servers, manage members or mint invite links anywhere? Drives navigation. */
export const canManage = (user: SessionUser, orgs: OrgSummary[]) =>
	user.role === 'owner' || orgs.some((o) => o.role === 'owner' && !o.suspended);

// --- servers ---

/** What the user may do on one server: everything for the site owner and org owners, else the granted role's list. */
export async function serverAccessFor(
	env: Env,
	user: SessionUser,
	serverId: string
): Promise<ServerAccess | null> {
	if (user.apiKey) {
		const [row] = await env.db
			.select({ id: servers.id, orgId: servers.orgId, suspendedAt: organizations.suspendedAt })
			.from(servers)
			.innerJoin(organizations, eq(organizations.id, servers.orgId))
			.where(eq(servers.id, serverId))
			.limit(1);
		// A key without View cannot see the server at all (a role always has View; a key may not).
		if (!user.apiKey.capabilities.includes('server.view')) return null;
		if (!row || row.suspendedAt || !keyCoversServer(user.apiKey, row)) return null;
		return accessFromCaps(user.apiKey.capabilities, 'API key');
	}
	if (user.role === 'owner') return resolveAccess({ manager: true });
	const [row] = await env.db
		.select({
			roleId: serverGrants.roleId,
			roleName: orgRoles.name,
			capabilities: orgRoles.capabilities,
			orgRole: orgMembers.role,
			suspendedAt: organizations.suspendedAt
		})
		.from(servers)
		.innerJoin(organizations, eq(organizations.id, servers.orgId))
		.leftJoin(
			serverGrants,
			and(eq(serverGrants.serverId, servers.id), eq(serverGrants.userId, user.id))
		)
		.leftJoin(orgRoles, eq(orgRoles.id, serverGrants.roleId))
		.leftJoin(orgMembers, and(eq(orgMembers.orgId, servers.orgId), eq(orgMembers.userId, user.id)))
		.where(eq(servers.id, serverId))
		.limit(1);
	if (!row) return null;
	return resolveAccess({
		manager: row.orgRole === 'owner',
		suspended: !!row.suspendedAt,
		grant: row.roleId
			? { roleId: row.roleId, roleName: row.roleName ?? '', capabilities: row.capabilities }
			: null
	});
}

/** The server plus proof the user runs its org (site owner or org owner): edit, delete, grants. */
export async function requireServerManager(
	env: Env,
	locals: App.Locals,
	serverId: string
): Promise<{ server: ServerRow; user: SessionUser }> {
	const user = requireUser(locals);
	if (user.apiKey) throw keyForbidden();
	const server = await getServer(env, serverId);
	const access = server ? await serverAccessFor(env, user, serverId) : null;
	if (!server || !access) throw new ApiError(404, 'Server not found.', 'not_found');
	if ((await orgRoleFor(env, user, server.orgId)) !== 'owner')
		throw new ApiError(
			403,
			`Only an owner of the organisation that runs ${server.name} can do that.`,
			'forbidden'
		);
	return { server, user };
}

/** The server plus proof the caller's role on it includes `cap` (404 when they cannot see it at all). */
export async function requireServerCap(
	env: Env,
	locals: App.Locals,
	serverId: string,
	cap: Capability
): Promise<{ server: ServerRow; access: ServerAccess; user: SessionUser }> {
	const user = requireUser(locals);
	const server = await getServer(env, serverId);
	const access = server ? await serverAccessFor(env, user, serverId) : null;
	if (!server || !access) throw new ApiError(404, 'Server not found.', 'not_found');
	if (!access.caps.has(cap)) {
		throw new ApiError(
			403,
			`This needs '${CAPABILITY_INFO[cap].label}' on ${server.name}; your role '${access.roleName}' does not include it.`,
			'forbidden'
		);
	}
	return { server, access, user };
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
	/** the granted role's name; 'owner' when access comes from running the org */
	roleName: string;
	caps: Capability[];
	/** true when access comes from owning the org rather than a grant */
	manager: boolean;
	sortOrder: number;
	demo: boolean;
};

export function shapeServer(
	env: Env,
	s: ServerRow,
	orgName: string,
	access: ServerAccess
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
		roleName: access.roleName,
		caps: [...access.caps],
		manager: access.manager,
		sortOrder: s.sortOrder,
		demo: isDemoServer(env, s)
	};
}

/**
 * Every server the user can open: all of them for the site owner, else owned-org servers plus
 * grants. `orgId` narrows the list to one organisation (the header scope, or an org page).
 */
export async function accessibleServers(
	env: Env,
	user: SessionUser,
	orgId: string | null = null
): Promise<ServerSummary[]> {
	const order = [asc(organizations.name), asc(servers.sortOrder), asc(servers.name)];
	const inOrg = orgId ? eq(servers.orgId, orgId) : undefined;
	if (user.apiKey) {
		const key = user.apiKey;
		if (orgId && orgId !== key.orgId) return [];
		if (!key.capabilities.includes('server.view')) return [];
		const rows = await env.db
			.select({ server: servers, orgName: organizations.name })
			.from(servers)
			.innerJoin(organizations, eq(organizations.id, servers.orgId))
			.where(and(eq(servers.orgId, key.orgId), isNull(organizations.suspendedAt)))
			.orderBy(...order);
		return rows
			.filter((r) => keyCoversServer(key, r.server))
			.map((r) =>
				shapeServer(env, r.server, r.orgName, accessFromCaps(key.capabilities, 'API key'))
			);
	}
	if (user.role === 'owner') {
		const rowsAll = await env.db
			.select({ server: servers, orgName: organizations.name })
			.from(servers)
			.innerJoin(organizations, eq(organizations.id, servers.orgId))
			.where(inOrg)
			.orderBy(...order);
		return rowsAll.map((r) =>
			shapeServer(env, r.server, r.orgName, resolveAccess({ manager: true })!)
		);
	}
	const rows = await env.db
		.select({
			server: servers,
			orgName: organizations.name,
			roleId: serverGrants.roleId,
			roleName: orgRoles.name,
			capabilities: orgRoles.capabilities,
			orgRole: orgMembers.role
		})
		.from(servers)
		.innerJoin(organizations, eq(organizations.id, servers.orgId))
		.leftJoin(
			serverGrants,
			and(eq(serverGrants.serverId, servers.id), eq(serverGrants.userId, user.id))
		)
		.leftJoin(orgRoles, eq(orgRoles.id, serverGrants.roleId))
		.leftJoin(orgMembers, and(eq(orgMembers.orgId, servers.orgId), eq(orgMembers.userId, user.id)))
		.where(
			and(
				inOrg,
				isNull(organizations.suspendedAt),
				or(isNotNull(serverGrants.roleId), eq(orgMembers.role, 'owner'))
			)
		)
		.orderBy(...order);
	return rows.map((r) =>
		shapeServer(
			env,
			r.server,
			r.orgName,
			resolveAccess({
				manager: r.orgRole === 'owner',
				grant: r.roleId
					? { roleId: r.roleId, roleName: r.roleName ?? '', capabilities: r.capabilities }
					: null
			})!
		)
	);
}

/**
 * What a non-site-owner may see in the audit log: their own rows, rows on servers where their
 * role includes audit.read (plus everything in orgs they own), and rows of orgs they own.
 */
export async function auditVisibility(
	env: Env,
	user: SessionUser
): Promise<{ userId: string; adminServerIds: string[]; ownedOrgIds: string[] } | null> {
	if (user.apiKey) {
		const covered = user.apiKey.capabilities.includes('audit.read')
			? (await accessibleServers(env, user)).map((s) => s.id)
			: [];
		return { userId: user.id, adminServerIds: covered, ownedOrgIds: [] };
	}
	if (user.role === 'owner') return null;
	const [granted, orgIds] = await Promise.all([
		grantedWith(env, user, 'audit.read'),
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
