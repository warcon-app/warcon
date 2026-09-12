// An organisation's server roles: named capability sets (see $lib/capabilities). Every org gets
// the three built-ins at creation (and here, for anything older); owners may edit them, add their
// own, and delete custom roles that nothing uses. Grants and invites point at roles by id, and
// every writer checks the role belongs to the server's org, since the schema alone cannot.
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, newId, str } from './http';
import { writeAudit } from './audit';
import type { OrgRow, SessionUser } from './access';
import type { Db } from './db';
import { orgInvites, orgRoles, serverGrants, servers, type OrgRoleRow } from './db/schema';
import {
	BUILTIN_CAPABILITIES,
	BUILTIN_ROLES,
	knownCapabilities,
	parseCapabilities,
	VIEW,
	type Capability
} from '../capabilities';
import type { RoleView } from '$lib/types';

/** The db or a transaction handle: ensureOrgRoles runs inside createOrg's transaction. */
type DbLike = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

const ROLE_NAME_MAX = 40;
const iso = (v: Date | null | undefined): string | null => (v ? v.toISOString() : null);

/** Seeds viewer / operator / admin for an org; a no-op where they already exist (repairs older orgs too). */
export async function ensureOrgRoles(db: DbLike, orgId: string): Promise<void> {
	await db
		.insert(orgRoles)
		.values(
			BUILTIN_ROLES.map((b, i) => ({
				id: newId(),
				orgId,
				name: b,
				capabilities: BUILTIN_CAPABILITIES[b],
				builtin: b,
				sortOrder: i
			}))
		)
		.onConflictDoNothing();
}

export function validateRoleName(v: unknown): string {
	const name = str(v, ROLE_NAME_MAX).trim();
	if (name.length < 2) throw new ApiError(400, 'Role name must be at least 2 characters.');
	if (name.length > ROLE_NAME_MAX)
		throw new ApiError(400, `Role name must be at most ${ROLE_NAME_MAX} characters.`);
	return name;
}

/** A role's capability list from a request body: known names only, and it must keep 'View'. */
export function validateRoleCapabilities(raw: unknown): Capability[] {
	let caps: Capability[];
	try {
		caps = parseCapabilities(raw);
	} catch (err) {
		throw new ApiError(400, err instanceof Error ? err.message : 'Bad capabilities.');
	}
	if (!caps.includes(VIEW))
		throw new ApiError(400, "Every role must include 'View'; remove the member's grant instead.");
	return caps;
}

const shape = (r: OrgRoleRow, inUse: { grants: number; invites: number }): RoleView => ({
	id: r.id,
	name: r.name,
	capabilities: knownCapabilities(r.capabilities),
	builtin: r.builtin,
	sortOrder: r.sortOrder,
	inUse,
	createdAt: iso(r.createdAt),
	updatedAt: iso(r.updatedAt)
});

/** Rows in display order: built-ins first (viewer, operator, admin), then custom roles by name. */
export async function orgRoleRows(env: Env, orgId: string): Promise<OrgRoleRow[]> {
	return env.db
		.select()
		.from(orgRoles)
		.where(eq(orgRoles.orgId, orgId))
		.orderBy(asc(orgRoles.sortOrder), asc(orgRoles.name));
}

/** id -> row, for validating grant payloads against one org. */
export async function rolesOf(env: Env, orgId: string): Promise<Map<string, OrgRoleRow>> {
	return new Map((await orgRoleRows(env, orgId)).map((r) => [r.id, r]));
}

async function usage(
	env: Env,
	orgId: string
): Promise<Map<string, { grants: number; invites: number }>> {
	const [grants, invites] = await Promise.all([
		env.db
			.select({ roleId: serverGrants.roleId, n: count() })
			.from(serverGrants)
			.innerJoin(servers, eq(servers.id, serverGrants.serverId))
			.where(eq(servers.orgId, orgId))
			.groupBy(serverGrants.roleId),
		env.db
			.select({ roleId: orgInvites.serverRoleId, n: count() })
			.from(orgInvites)
			.where(and(eq(orgInvites.orgId, orgId), isNull(orgInvites.revokedAt)))
			.groupBy(orgInvites.serverRoleId)
	]);
	const out = new Map<string, { grants: number; invites: number }>();
	const at = (id: string) => {
		if (!out.has(id)) out.set(id, { grants: 0, invites: 0 });
		return out.get(id)!;
	};
	for (const g of grants) at(g.roleId).grants = Number(g.n);
	for (const i of invites) if (i.roleId) at(i.roleId).invites = Number(i.n);
	return out;
}

export async function listRoles(env: Env, orgId: string): Promise<RoleView[]> {
	const [rows, used] = await Promise.all([orgRoleRows(env, orgId), usage(env, orgId)]);
	return rows.map((r) => shape(r, used.get(r.id) ?? { grants: 0, invites: 0 }));
}

/** The role, if it exists in this org (404 otherwise, so a foreign role id reads as unknown). */
export async function roleInOrg(env: Env, orgId: string, roleId: string): Promise<OrgRoleRow> {
	const [row] = await env.db
		.select()
		.from(orgRoles)
		.where(and(eq(orgRoles.id, roleId), eq(orgRoles.orgId, orgId)))
		.limit(1);
	if (!row) throw new ApiError(404, 'Role not found.', 'not_found');
	return row;
}

async function assertNameFree(env: Env, orgId: string, name: string, exceptId?: string) {
	const rows = await env.db
		.select({ id: orgRoles.id })
		.from(orgRoles)
		.where(and(eq(orgRoles.orgId, orgId), sql`lower(${orgRoles.name}) = lower(${name})`));
	if (rows.some((r) => r.id !== exceptId))
		throw new ApiError(409, `A role called '${name}' already exists.`, 'conflict');
}

export async function createRole(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<RoleView> {
	const name = validateRoleName(body.name);
	const capabilities = validateRoleCapabilities(body.capabilities ?? [VIEW]);
	await assertNameFree(env, org.id, name);
	const [row] = await env.db
		.insert(orgRoles)
		.values({ id: newId(), orgId: org.id, name, capabilities, builtin: null, sortOrder: 100 })
		.returning();
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.role.create',
		outcome: 'ok',
		target: name,
		detail: { orgId: org.id, roleId: row.id, capabilities }
	});
	return shape(row, { grants: 0, invites: 0 });
}

/** Rename and/or change what a role may do; applies to everyone holding it at once. */
export async function updateRole(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	roleId: string,
	body: Record<string, unknown>
): Promise<RoleView> {
	const role = await roleInOrg(env, org.id, roleId);
	const patch: Partial<typeof orgRoles.$inferInsert> = { updatedAt: new Date() };
	if (body.name !== undefined) {
		patch.name = validateRoleName(body.name);
		await assertNameFree(env, org.id, patch.name, role.id);
	}
	if (body.capabilities !== undefined)
		patch.capabilities = validateRoleCapabilities(body.capabilities);
	const [row] = await env.db
		.update(orgRoles)
		.set(patch)
		.where(eq(orgRoles.id, role.id))
		.returning();
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.role.update',
		outcome: 'ok',
		target: row.name,
		detail: {
			orgId: org.id,
			roleId: role.id,
			from: { name: role.name, capabilities: knownCapabilities(role.capabilities) },
			to: { name: row.name, capabilities: knownCapabilities(row.capabilities) }
		}
	});
	const used = await usage(env, org.id);
	return shape(row, used.get(row.id) ?? { grants: 0, invites: 0 });
}

/** Custom roles only, and only while nothing points at them (the FK would refuse anyway; say why). */
export async function deleteRole(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	roleId: string
): Promise<void> {
	const role = await roleInOrg(env, org.id, roleId);
	if (role.builtin)
		throw new ApiError(409, `'${role.name}' is a built-in role; reset it instead.`, 'builtin');
	const used = (await usage(env, org.id)).get(role.id);
	if (used && (used.grants || used.invites)) {
		const parts = [];
		if (used.grants) parts.push(`${used.grants} grant${used.grants === 1 ? '' : 's'}`);
		if (used.invites) parts.push(`${used.invites} invite link${used.invites === 1 ? '' : 's'}`);
		throw new ApiError(
			409,
			`'${role.name}' is still used by ${parts.join(' and ')}. Move them to another role first.`,
			'in_use'
		);
	}
	await env.db.delete(orgRoles).where(eq(orgRoles.id, role.id));
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.role.delete',
		outcome: 'ok',
		target: role.name,
		detail: { orgId: org.id, roleId: role.id, capabilities: knownCapabilities(role.capabilities) }
	});
}

/** Puts a built-in back to its shipped name and capabilities. */
export async function resetRole(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	roleId: string
): Promise<RoleView> {
	const role = await roleInOrg(env, org.id, roleId);
	if (!role.builtin) throw new ApiError(409, 'Only built-in roles can be reset.', 'not_builtin');
	await assertNameFree(env, org.id, role.builtin, role.id);
	const [row] = await env.db
		.update(orgRoles)
		.set({
			name: role.builtin,
			capabilities: BUILTIN_CAPABILITIES[role.builtin],
			updatedAt: new Date()
		})
		.where(eq(orgRoles.id, role.id))
		.returning();
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.role.reset',
		outcome: 'ok',
		target: row.name,
		detail: { orgId: org.id, roleId: role.id, from: knownCapabilities(role.capabilities) }
	});
	const used = await usage(env, org.id);
	return shape(row, used.get(row.id) ?? { grants: 0, invites: 0 });
}

/** Roles of several orgs at once (the site owner's user dialog spans every organisation). */
export async function rolesByOrg(
	env: Env,
	orgIds: string[]
): Promise<Record<string, { id: string; name: string; builtin: string | null }[]>> {
	const out: Record<string, { id: string; name: string; builtin: string | null }[]> = {};
	if (!orgIds.length) return out;
	const rows = await env.db
		.select({
			id: orgRoles.id,
			orgId: orgRoles.orgId,
			name: orgRoles.name,
			builtin: orgRoles.builtin
		})
		.from(orgRoles)
		.where(inArray(orgRoles.orgId, orgIds))
		.orderBy(asc(orgRoles.sortOrder), asc(orgRoles.name));
	for (const r of rows) (out[r.orgId] ??= []).push({ id: r.id, name: r.name, builtin: r.builtin });
	return out;
}
