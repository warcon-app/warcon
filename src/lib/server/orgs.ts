// Organisations: the clan or community that owns a set of servers. People join through shareable
// invite links (/join/<token>) rather than being created one by one.
import { and, asc, count, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, int, newId, str } from './http';
import { writeAudit } from './audit';
import {
	ORG_ROLES,
	SERVER_ROLES,
	type OrgRole,
	type OrgRow,
	type ServerRole,
	type SessionUser
} from './access';
import { orgInvites, orgMembers, organizations, serverGrants, servers, user } from './db/schema';
import type { OrgInviteRow } from './db/schema';
import type { Db } from './db';
import type { InviteStatus, InviteView, OrgMemberView, OrgView } from '$lib/types';

/** A Drizzle transaction handle (what `db.transaction(async (tx) => ...)` passes). */
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const iso = (v: Date | null | undefined): string | null => (v ? v.toISOString() : null);

export function validateOrgName(v: unknown): string {
	const name = str(v, 60);
	if (name.length < 2) throw new ApiError(400, 'Organisation name must be at least 2 characters.');
	return name;
}

const slugOf = (name: string) =>
	name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40) || 'org';

async function freeSlug(env: Env, base: string, exceptId?: string): Promise<string> {
	for (let n = 0; n < 50; n++) {
		const candidate = n ? `${base}-${n + 1}` : base;
		const [taken] = await env.db
			.select({ id: organizations.id })
			.from(organizations)
			.where(
				exceptId
					? and(eq(organizations.slug, candidate), ne(organizations.id, exceptId))
					: eq(organizations.slug, candidate)
			)
			.limit(1);
		if (!taken) return candidate;
	}
	return `${base}-${newId().slice(0, 8)}`;
}

// --- orgs ---

/** The given orgs with member and server counts (callers pass the ids the user may see). */
export async function listOrgs(env: Env, ids: string[]): Promise<OrgView[]> {
	if (!ids.length) return [];
	const [rows, members, srv] = await Promise.all([
		env.db
			.select()
			.from(organizations)
			.where(inArray(organizations.id, ids))
			.orderBy(asc(organizations.name)),
		env.db
			.select({ orgId: orgMembers.orgId, n: count() })
			.from(orgMembers)
			.where(inArray(orgMembers.orgId, ids))
			.groupBy(orgMembers.orgId),
		env.db
			.select({ orgId: servers.orgId, n: count() })
			.from(servers)
			.where(inArray(servers.orgId, ids))
			.groupBy(servers.orgId)
	]);
	const m = new Map(members.map((r) => [r.orgId, r.n]));
	const s = new Map(srv.map((r) => [r.orgId, r.n]));
	return rows.map((o) => ({
		id: o.id,
		name: o.name,
		slug: o.slug,
		memberCount: m.get(o.id) ?? 0,
		serverCount: s.get(o.id) ?? 0,
		createdAt: iso(o.createdAt)
	}));
}

/** Creates an org with the actor as its first owner. */
export async function createOrg(
	env: Env,
	req: Request,
	actor: SessionUser,
	body: Record<string, unknown>
): Promise<string> {
	const name = validateOrgName(body.name);
	const id = newId();
	const slug = await freeSlug(env, slugOf(name));
	await env.db.transaction(async (tx) => {
		await tx.insert(organizations).values({ id, name, slug, createdBy: actor.id });
		await tx.insert(orgMembers).values({ orgId: id, userId: actor.id, role: 'owner' });
	});
	await writeAudit(env, req, {
		actor,
		orgId: id,
		category: 'org',
		action: 'org.create',
		outcome: 'ok',
		target: name,
		detail: { orgId: id, slug }
	});
	return id;
}

export async function updateOrg(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<void> {
	const name = validateOrgName(body.name);
	const slug = await freeSlug(env, slugOf(name), org.id);
	await env.db
		.update(organizations)
		.set({ name, slug, updatedAt: new Date() })
		.where(eq(organizations.id, org.id));
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.update',
		outcome: 'ok',
		target: name,
		detail: { orgId: org.id, from: org.name }
	});
}

/**
 * Removes the org and, by cascade, its servers, grants, memberships and invites. Each server
 * gets its own 'server.delete' row so per-server audit history shows who removed it.
 */
export async function deleteOrg(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow
): Promise<void> {
	const gone = await env.db
		.select({ id: servers.id, name: servers.name, host: servers.host, port: servers.port })
		.from(servers)
		.where(eq(servers.orgId, org.id));
	await env.db.delete(organizations).where(eq(organizations.id, org.id));
	for (const s of gone) {
		await writeAudit(env, req, {
			actor,
			server: { id: s.id, name: s.name },
			orgId: org.id,
			category: 'server',
			action: 'server.delete',
			outcome: 'ok',
			target: `${s.host}:${s.port}`,
			detail: { orgId: org.id, org: org.name, reason: 'org.delete' }
		});
	}
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.delete',
		outcome: 'ok',
		target: org.name,
		detail: { orgId: org.id, servers: gone.map((s) => s.id) }
	});
}

// --- members ---

export async function listMembers(env: Env, orgId: string): Promise<OrgMemberView[]> {
	const rows = await env.db
		.select({ m: orgMembers, u: user })
		.from(orgMembers)
		.innerJoin(user, eq(user.id, orgMembers.userId))
		.where(eq(orgMembers.orgId, orgId))
		.orderBy(asc(orgMembers.role), asc(user.username), asc(user.name));
	const grants = await env.db
		.select({
			userId: serverGrants.userId,
			serverId: serverGrants.serverId,
			serverName: servers.name,
			role: serverGrants.role
		})
		.from(serverGrants)
		.innerJoin(servers, eq(servers.id, serverGrants.serverId))
		.where(eq(servers.orgId, orgId))
		.orderBy(asc(servers.sortOrder), asc(servers.name));
	const byUser = new Map<string, OrgMemberView['grants']>();
	for (const g of grants) {
		if (!byUser.has(g.userId)) byUser.set(g.userId, []);
		byUser.get(g.userId)!.push({ serverId: g.serverId, serverName: g.serverName, role: g.role });
	}
	return rows.map(({ m, u }) => ({
		userId: u.id,
		username: u.displayUsername || u.username || u.email.split('@')[0],
		name: u.name || u.displayUsername || u.username || '',
		image: u.image,
		siteOwner: u.role === 'owner',
		disabled: !!u.banned,
		role: m.role,
		joinedAt: iso(m.createdAt),
		grants: byUser.get(u.id) || []
	}));
}

async function ownerCountIn(env: Env, orgId: string): Promise<number> {
	const [row] = await env.db
		.select({ n: count() })
		.from(orgMembers)
		.where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.role, 'owner')));
	return row?.n ?? 0;
}

/** Is there a stored membership row (site owners are not implied members)? */
export async function isMember(env: Env, orgId: string, userId: string): Promise<boolean> {
	const [row] = await env.db
		.select({ userId: orgMembers.userId })
		.from(orgMembers)
		.where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
		.limit(1);
	return !!row;
}

/** Names of the orgs where this user is the only owner; deleting them would leave those ownerless. */
export async function soleOwnerOf(env: Env, userId: string): Promise<string[]> {
	const owners = sql<number>`(
		select count(*) from ${orgMembers} o
		where o.org_id = ${orgMembers.orgId} and o.role = 'owner'
	)`;
	const rows = await env.db
		.select({ name: organizations.name })
		.from(orgMembers)
		.innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
		.where(and(eq(orgMembers.userId, userId), eq(orgMembers.role, 'owner'), eq(owners, 1)))
		.orderBy(asc(organizations.name));
	return rows.map((r) => r.name);
}

async function memberOf(env: Env, orgId: string, userId: string) {
	const [row] = await env.db
		.select({ m: orgMembers, name: user.name, username: user.username })
		.from(orgMembers)
		.innerJoin(user, eq(user.id, orgMembers.userId))
		.where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId)))
		.limit(1);
	if (!row) throw new ApiError(404, 'Not a member of this organisation.');
	return { ...row.m, label: row.username || row.name };
}

export async function setMemberRole(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	userId: string,
	roleIn: unknown
): Promise<void> {
	const role = roleIn as OrgRole;
	if (!ORG_ROLES.includes(role)) throw new ApiError(400, 'role must be owner or member.');
	const m = await memberOf(env, org.id, userId);
	if (m.role === role) return;
	if (m.role === 'owner' && (await ownerCountIn(env, org.id)) <= 1)
		throw new ApiError(400, `${org.name} needs at least one owner.`);
	await env.db
		.update(orgMembers)
		.set({ role })
		.where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, userId)));
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.member.role',
		outcome: 'ok',
		target: m.label,
		detail: { orgId: org.id, org: org.name, role }
	});
}

/** Removes the membership and every grant on the org's servers. */
export async function removeMember(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	userId: string
): Promise<void> {
	const m = await memberOf(env, org.id, userId);
	if (m.role === 'owner' && (await ownerCountIn(env, org.id)) <= 1)
		throw new ApiError(400, `${org.name} needs at least one owner.`);
	await env.db.transaction(async (tx) => {
		const ids = (
			await tx.select({ id: servers.id }).from(servers).where(eq(servers.orgId, org.id))
		).map((r) => r.id);
		if (ids.length)
			await tx
				.delete(serverGrants)
				.where(and(eq(serverGrants.userId, userId), inArray(serverGrants.serverId, ids)));
		await tx
			.delete(orgMembers)
			.where(and(eq(orgMembers.orgId, org.id), eq(orgMembers.userId, userId)));
	});
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.member.remove',
		outcome: 'ok',
		target: m.label,
		detail: { orgId: org.id, org: org.name }
	});
}

/** Replaces a member's grants on this org's servers (grants elsewhere are untouched). */
export async function setMemberGrants(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	userId: string,
	grants: unknown
) {
	const m = await memberOf(env, org.id, userId);
	const known = new Set(
		(await env.db.select({ id: servers.id }).from(servers).where(eq(servers.orgId, org.id))).map(
			(r) => r.id
		)
	);
	const wanted = Array.isArray(grants) ? (grants as { serverId?: unknown; role?: unknown }[]) : [];
	const applied: { serverId: string; role: ServerRole }[] = [];
	for (const g of wanted) {
		const serverId = str(g.serverId, 64);
		const role = g.role as ServerRole;
		if (!known.has(serverId) || !SERVER_ROLES.includes(role)) continue;
		if (!applied.some((a) => a.serverId === serverId)) applied.push({ serverId, role });
	}
	await env.db.transaction(async (tx) => {
		if (known.size)
			await tx
				.delete(serverGrants)
				.where(and(eq(serverGrants.userId, userId), inArray(serverGrants.serverId, [...known])));
		if (applied.length)
			await tx
				.insert(serverGrants)
				.values(applied.map((a) => ({ ...a, userId, grantedBy: actor.id })));
	});
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.member.grants',
		outcome: 'ok',
		target: m.label,
		detail: { orgId: org.id, org: org.name, grants: applied }
	});
	return applied;
}

/**
 * Makes sure each user is at least a member of the given org (a grant implies membership).
 * Runs inside the caller's grant transaction so a grant can never exist without its membership.
 */
export async function ensureMemberships(
	tx: Tx,
	pairs: { orgId: string; userId: string }[]
): Promise<void> {
	const rows: { orgId: string; userId: string; role: OrgRole }[] = [];
	for (const p of pairs) {
		if (!rows.some((r) => r.orgId === p.orgId && r.userId === p.userId))
			rows.push({ orgId: p.orgId, userId: p.userId, role: 'member' });
	}
	if (rows.length) await tx.insert(orgMembers).values(rows).onConflictDoNothing();
}

// --- invite links ---

export const inviteUrl = (env: Env, token: string) => `${env.ORIGIN}/join/${token}`;

const newToken = () => {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString('base64url');
};

export function inviteStatus(inv: OrgInviteRow, now = new Date()): InviteStatus {
	if (inv.revokedAt) return 'revoked';
	if (inv.expiresAt && inv.expiresAt.getTime() <= now.getTime()) return 'expired';
	if (inv.maxUses !== null && inv.uses >= inv.maxUses) return 'used';
	return 'live';
}

const STATUS_PROBLEM: Record<Exclude<InviteStatus, 'live'>, string> = {
	revoked: 'This invite link has been revoked.',
	expired: 'This invite link has expired.',
	used: 'This invite link has been used up.'
};

/** Why an invite cannot be used right now, or null when it can. */
export function inviteProblem(inv: OrgInviteRow, now = new Date()): string | null {
	const status = inviteStatus(inv, now);
	return status === 'live' ? null : STATUS_PROBLEM[status];
}

const shapeInvite = (env: Env, inv: OrgInviteRow): InviteView => {
	const status = inviteStatus(inv);
	return {
		id: inv.id,
		label: inv.label,
		orgRole: inv.orgRole,
		serverRole: inv.serverRole,
		maxUses: inv.maxUses,
		uses: inv.uses,
		expiresAt: iso(inv.expiresAt),
		revokedAt: iso(inv.revokedAt),
		createdAt: iso(inv.createdAt),
		url: inviteUrl(env, inv.token),
		status,
		problem: status === 'live' ? null : STATUS_PROBLEM[status]
	};
};

export async function listInvites(env: Env, orgId: string): Promise<InviteView[]> {
	const rows = await env.db
		.select()
		.from(orgInvites)
		.where(eq(orgInvites.orgId, orgId))
		.orderBy(asc(orgInvites.createdAt));
	return rows.map((r) => shapeInvite(env, r));
}

export async function createInvite(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<InviteView> {
	const orgRole: OrgRole = body.orgRole === 'owner' ? 'owner' : 'member';
	const serverRole = SERVER_ROLES.includes(body.serverRole as ServerRole)
		? (body.serverRole as ServerRole)
		: null;
	// Blank, 0 or anything below 0 means "no limit"; only a positive count or day span applies.
	const maxUses = int(body.maxUses, 0, 0, 100000) || null;
	const days = int(body.expiresDays, 0, 0, 3650);
	const expiresAt = days ? new Date(Date.now() + days * 86400_000) : null;
	const row: typeof orgInvites.$inferInsert = {
		id: newId(),
		orgId: org.id,
		token: newToken(),
		label: str(body.label, 60),
		orgRole,
		serverRole,
		maxUses,
		expiresAt,
		createdBy: actor.id
	};
	const [created] = await env.db.insert(orgInvites).values(row).returning();
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.invite.create',
		outcome: 'ok',
		target: org.name,
		detail: {
			orgId: org.id,
			inviteId: row.id,
			orgRole,
			serverRole,
			maxUses,
			expiresAt: iso(expiresAt)
		}
	});
	return shapeInvite(env, created);
}

export async function revokeInvite(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	inviteId: string
): Promise<void> {
	const [inv] = await env.db
		.update(orgInvites)
		.set({ revokedAt: new Date() })
		.where(and(eq(orgInvites.id, inviteId), eq(orgInvites.orgId, org.id)))
		.returning({ id: orgInvites.id });
	if (!inv) throw new ApiError(404, 'Invite not found.');
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.invite.revoke',
		outcome: 'ok',
		target: org.name,
		detail: { orgId: org.id, inviteId }
	});
}

export async function findInvite(
	env: Env,
	token: string
): Promise<{ invite: OrgInviteRow; org: OrgRow } | null> {
	if (!token || token.length > 100) return null;
	const [row] = await env.db
		.select({ invite: orgInvites, org: organizations })
		.from(orgInvites)
		.innerJoin(organizations, eq(organizations.id, orgInvites.orgId))
		.where(eq(orgInvites.token, token))
		.limit(1);
	return row ?? null;
}

/**
 * Applies an invite to a signed-in user: membership at the invite's org role, plus the invite's
 * default role on every server the org has right now. A no-op for existing members. The use is
 * claimed with a conditional update inside the transaction, so two people racing for the last
 * use of a link cannot both get in, and a double submit is absorbed by the membership key.
 */
export async function joinOrg(
	env: Env,
	req: Request,
	user: SessionUser,
	invite: OrgInviteRow,
	org: OrgRow
): Promise<void> {
	// Members re-opening a link (even one that has since run out) are simply already in.
	if (await isMember(env, org.id, user.id)) return;
	const problem = inviteProblem(invite);
	if (problem) throw new ApiError(410, problem, 'invite');
	let granted = 0;
	const joined = await env.db.transaction(async (tx) => {
		const inserted = await tx
			.insert(orgMembers)
			.values({ orgId: org.id, userId: user.id, role: invite.orgRole, inviteId: invite.id })
			.onConflictDoNothing()
			.returning({ userId: orgMembers.userId });
		if (!inserted.length) return false; // already a member: no use consumed
		const claimed = await tx
			.update(orgInvites)
			.set({ uses: sql`${orgInvites.uses} + 1` })
			.where(
				and(
					eq(orgInvites.id, invite.id),
					isNull(orgInvites.revokedAt),
					or(isNull(orgInvites.expiresAt), gt(orgInvites.expiresAt, new Date())),
					or(isNull(orgInvites.maxUses), lt(orgInvites.uses, orgInvites.maxUses))
				)
			)
			.returning({ id: orgInvites.id });
		// Rolls back the membership: the link ran out (or was revoked) since the page was loaded.
		if (!claimed.length)
			throw new ApiError(410, 'This invite link can no longer be used.', 'invite');
		if (invite.serverRole) {
			const ids = await tx
				.select({ id: servers.id })
				.from(servers)
				.where(eq(servers.orgId, org.id));
			if (ids.length) {
				await tx
					.insert(serverGrants)
					.values(
						ids.map((s) => ({
							serverId: s.id,
							userId: user.id,
							role: invite.serverRole!,
							grantedBy: invite.createdBy
						}))
					)
					.onConflictDoNothing();
				granted = ids.length;
			}
		}
		return true;
	});
	if (!joined) return;
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.join',
		outcome: 'ok',
		target: org.name,
		detail: {
			orgId: org.id,
			inviteId: invite.id,
			orgRole: invite.orgRole,
			serverRole: invite.serverRole,
			servers: granted
		}
	});
}
