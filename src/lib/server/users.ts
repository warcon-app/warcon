// Accounts live in Better Auth's tables; Warcon adds per-server grants, forced password change
// and "disabled" (the admin plugin's ban flag).
import { and, asc, count, desc, eq, isNull, max, ne, or, sql } from 'drizzle-orm';
import type { Auth } from './auth';
import { emailFor, MIN_PASSWORD, USERNAME_RE } from './auth';
import type { Env } from './env';
import { ApiError, str } from './http';
import { writeAudit } from './audit';
import { SERVER_ROLES, type ServerRole, type SessionUser } from './access';
import {
	account,
	orgMembers,
	organizations,
	serverGrants,
	servers,
	session,
	user
} from './db/schema';
import { ensureMemberships, soleOwnerOf } from './orgs';
import type { UserView } from '$lib/types';

export function validatePassword(pw: unknown): string {
	if (typeof pw !== 'string' || pw.length < MIN_PASSWORD)
		throw new ApiError(400, `Password must be at least ${MIN_PASSWORD} characters.`);
	if (pw.length > 200) throw new ApiError(400, 'Password is too long.');
	return pw;
}

export function validateUsername(u: unknown): string {
	const name = str(u, 32);
	if (!USERNAME_RE.test(name))
		throw new ApiError(
			400,
			'Username must be 2-32 characters: letters, digits, dot, dash, underscore.'
		);
	return name;
}

export async function userCount(env: Env): Promise<number> {
	const [row] = await env.db.select({ n: count() }).from(user);
	return row?.n ?? 0;
}

export async function ownerCount(env: Env): Promise<number> {
	const [row] = await env.db
		.select({ n: count() })
		.from(user)
		.where(and(eq(user.role, 'owner'), or(isNull(user.banned), eq(user.banned, false))));
	return row?.n ?? 0;
}

const iso = (v: Date | null | undefined): string | null => (v ? v.toISOString() : null);
const label = (u: { displayUsername: string | null; username: string | null; email: string }) =>
	u.displayUsername || u.username || u.email.split('@')[0];

export async function getUser(env: Env, id: string) {
	const [row] = await env.db.select().from(user).where(eq(user.id, id)).limit(1);
	return row ?? null;
}

export async function listUsers(env: Env): Promise<UserView[]> {
	const lastLogin = env.db
		.select({ userId: session.userId, at: max(session.createdAt).as('at') })
		.from(session)
		.groupBy(session.userId)
		.as('last_login');
	const users = await env.db
		.select({ u: user, lastLoginAt: lastLogin.at })
		.from(user)
		.leftJoin(lastLogin, eq(lastLogin.userId, user.id))
		.orderBy(asc(user.username), asc(user.name));
	const grants = await env.db
		.select({
			userId: serverGrants.userId,
			serverId: serverGrants.serverId,
			role: serverGrants.role,
			serverName: servers.name
		})
		.from(serverGrants)
		.innerJoin(servers, eq(servers.id, serverGrants.serverId))
		.orderBy(asc(servers.sortOrder), asc(servers.name));
	const byUser = new Map<string, UserView['grants']>();
	for (const g of grants) {
		if (!byUser.has(g.userId)) byUser.set(g.userId, []);
		byUser.get(g.userId)!.push({ serverId: g.serverId, serverName: g.serverName, role: g.role });
	}
	const memberships = await env.db
		.select({
			userId: orgMembers.userId,
			orgId: orgMembers.orgId,
			orgName: organizations.name,
			role: orgMembers.role
		})
		.from(orgMembers)
		.innerJoin(organizations, eq(organizations.id, orgMembers.orgId))
		.orderBy(asc(organizations.name));
	const orgsByUser = new Map<string, UserView['orgs']>();
	for (const m of memberships) {
		if (!orgsByUser.has(m.userId)) orgsByUser.set(m.userId, []);
		orgsByUser.get(m.userId)!.push({ orgId: m.orgId, orgName: m.orgName, role: m.role });
	}
	return users.map(({ u, lastLoginAt }) => ({
		id: u.id,
		username: label(u),
		name: u.name || u.displayUsername || u.username || '',
		role: u.role === 'owner' ? 'owner' : 'member',
		disabled: !!u.banned,
		mustChangePassword: u.mustChangePassword,
		image: u.image,
		createdAt: iso(u.createdAt),
		lastLoginAt: iso(
			lastLoginAt instanceof Date ? lastLoginAt : lastLoginAt ? new Date(lastLoginAt) : null
		),
		grants: byUser.get(u.id) || [],
		orgs: orgsByUser.get(u.id) || []
	}));
}

export async function setMustChangePassword(
	env: Env,
	userId: string,
	value: boolean
): Promise<void> {
	await env.db.update(user).set({ mustChangePassword: value }).where(eq(user.id, userId));
}

export const revokeUserSessions = (env: Env, userId: string) =>
	env.db.delete(session).where(eq(session.userId, userId));

export interface CreateUserInput {
	username: string;
	password: string;
	displayName?: string;
	role: 'owner' | 'member';
	mustChangePassword: boolean;
}

/** Creates an account through Better Auth (so ids, hashing and hooks match), then applies Warcon's flags. */
export async function createUser(
	auth: Auth,
	env: Env,
	headers: Headers | undefined,
	input: CreateUserInput
): Promise<string> {
	const [taken] = await env.db
		.select({ id: user.id })
		.from(user)
		.where(
			or(eq(user.username, input.username.toLowerCase()), eq(user.email, emailFor(input.username)))
		)
		.limit(1);
	if (taken) throw new ApiError(409, 'That username is taken.');
	const res = await auth.api.createUser({
		body: {
			email: emailFor(input.username),
			password: input.password,
			name: str(input.displayName, 80) || input.username,
			role: input.role,
			data: { username: input.username, displayUsername: input.username }
		},
		headers
	});
	const id = res.user.id;
	if (input.mustChangePassword) await setMustChangePassword(env, id, true);
	return id;
}

export interface UpdateUserInput {
	displayName?: unknown;
	role?: unknown;
	disabled?: unknown;
	password?: unknown;
	mustChangePassword?: unknown;
}

export async function updateUser(
	auth: Auth,
	env: Env,
	req: Request,
	actor: SessionUser,
	userId: string,
	body: UpdateUserInput
): Promise<void> {
	const u = await getUser(env, userId);
	if (!u) throw new ApiError(404, 'User not found.');
	const username = label(u);
	const changes: Record<string, unknown> = {};
	const set: Partial<typeof user.$inferInsert> = {};
	let signOut = false;

	if (body.displayName !== undefined) {
		set.name = str(body.displayName, 80) || username;
		changes.displayName = true;
	}
	if (body.role !== undefined) {
		const role = body.role === 'owner' ? 'owner' : 'member';
		if (u.role === 'owner' && role !== 'owner' && (await ownerCount(env)) <= 1)
			throw new ApiError(400, 'Cannot demote the last owner.');
		if (u.id === actor.id && role !== 'owner')
			throw new ApiError(400, 'You cannot demote yourself.');
		set.role = role;
		changes.role = role;
	}
	if (body.disabled !== undefined) {
		const disabled = !!body.disabled;
		if (u.id === actor.id && disabled) throw new ApiError(400, 'You cannot disable yourself.');
		if (disabled && u.role === 'owner' && (await ownerCount(env)) <= 1)
			throw new ApiError(400, 'Cannot disable the last owner.');
		set.banned = disabled;
		set.banReason = disabled ? 'Disabled by owner' : null;
		set.banExpires = null;
		if (disabled) signOut = true;
		changes.disabled = disabled;
	}
	if (body.password !== undefined) {
		const password = validatePassword(body.password);
		await auth.api.setUserPassword({
			body: { userId: u.id, newPassword: password },
			headers: req.headers
		});
		set.mustChangePassword = body.mustChangePassword !== false;
		signOut = true;
		changes.passwordReset = true;
	} else if (body.mustChangePassword !== undefined) {
		set.mustChangePassword = !!body.mustChangePassword;
		changes.mustChangePassword = !!body.mustChangePassword;
	}
	if (!Object.keys(changes).length) throw new ApiError(400, 'Nothing to update.');
	set.updatedAt = new Date();
	await env.db.transaction(async (tx) => {
		await tx.update(user).set(set).where(eq(user.id, u.id));
		if (signOut) await tx.delete(session).where(eq(session.userId, u.id));
	});
	await writeAudit(env, req, {
		actor,
		category: 'user',
		action: 'user.update',
		outcome: 'ok',
		target: username,
		detail: changes
	});
}

export async function deleteUser(
	auth: Auth,
	env: Env,
	req: Request,
	actor: SessionUser,
	userId: string
): Promise<void> {
	const u = await getUser(env, userId);
	if (!u) throw new ApiError(404, 'User not found.');
	if (u.id === actor.id) throw new ApiError(400, 'You cannot delete yourself.');
	if (u.role === 'owner' && (await ownerCount(env)) <= 1)
		throw new ApiError(400, 'Cannot delete the last owner.');
	const sole = await soleOwnerOf(env, u.id);
	if (sole.length)
		throw new ApiError(
			400,
			`${label(u)} is the only owner of ${sole.join(', ')}. Promote another owner there first.`
		);
	await auth.api.removeUser({ body: { userId: u.id }, headers: req.headers }); // grants and memberships cascade
	await writeAudit(env, req, {
		actor,
		category: 'user',
		action: 'user.delete',
		outcome: 'ok',
		target: label(u)
	});
}

/** Replaces a user's per-server grants wholesale (site owner tool); a grant makes them a member of that server's org. */
export async function setUserGrants(
	env: Env,
	req: Request,
	actor: SessionUser,
	userId: string,
	grants: unknown
) {
	const u = await getUser(env, userId);
	if (!u) throw new ApiError(404, 'User not found.');
	const wanted = Array.isArray(grants) ? (grants as { serverId?: unknown; role?: unknown }[]) : [];
	const orgOf = new Map(
		(await env.db.select({ id: servers.id, orgId: servers.orgId }).from(servers)).map((s) => [
			s.id,
			s.orgId
		])
	);
	const applied: { serverId: string; role: ServerRole }[] = [];
	for (const g of wanted) {
		const serverId = str(g.serverId, 64);
		const role = g.role as ServerRole;
		if (!orgOf.has(serverId) || !SERVER_ROLES.includes(role)) continue;
		if (!applied.some((a) => a.serverId === serverId)) applied.push({ serverId, role });
	}
	await env.db.transaction(async (tx) => {
		await tx.delete(serverGrants).where(eq(serverGrants.userId, u.id));
		if (applied.length)
			await tx.insert(serverGrants).values(
				applied.map((a) => ({
					serverId: a.serverId,
					userId: u.id,
					role: a.role,
					grantedBy: actor.id
				}))
			);
		await ensureMemberships(
			tx,
			applied.map((a) => ({ orgId: orgOf.get(a.serverId)!, userId: u.id }))
		);
	});
	await writeAudit(env, req, {
		actor,
		category: 'user',
		action: 'user.grants',
		outcome: 'ok',
		target: label(u),
		detail: { grants: applied }
	});
	return applied;
}

export interface SessionView {
	id: string;
	createdAt: string | null;
	updatedAt: string | null;
	expiresAt: string | null;
	ip: string;
	userAgent: string;
	current: boolean;
}

export async function listSessions(
	env: Env,
	userId: string,
	currentId: string | null
): Promise<SessionView[]> {
	const found = await env.db
		.select({
			id: session.id,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			expiresAt: session.expiresAt,
			ipAddress: session.ipAddress,
			userAgent: session.userAgent
		})
		.from(session)
		.where(eq(session.userId, userId))
		.orderBy(desc(session.updatedAt));
	return found.map((s) => ({
		id: s.id,
		createdAt: iso(s.createdAt),
		updatedAt: iso(s.updatedAt),
		expiresAt: iso(s.expiresAt),
		ip: s.ipAddress || '',
		userAgent: s.userAgent || '',
		current: s.id === currentId
	}));
}

export async function revokeSession(env: Env, userId: string, sessionId: string): Promise<void> {
	await env.db.delete(session).where(and(eq(session.id, sessionId), eq(session.userId, userId)));
}

export async function linkedProviders(env: Env, userId: string): Promise<string[]> {
	const found = await env.db
		.select({ providerId: account.providerId })
		.from(account)
		.where(eq(account.userId, userId));
	return found.map((r) => r.providerId);
}

/** Removes the Discord account link, keeping at least one way to sign in. */
export async function unlinkDiscord(env: Env, userId: string): Promise<void> {
	const [other] = await env.db
		.select({ id: account.id })
		.from(account)
		.where(and(eq(account.userId, userId), ne(account.providerId, 'discord')))
		.limit(1);
	if (!other)
		throw new ApiError(
			400,
			'Set a password before unlinking Discord, or you would have no way to sign in.'
		);
	await env.db
		.delete(account)
		.where(and(eq(account.userId, userId), eq(account.providerId, 'discord')));
}

/**
 * Links a SteamID64 to the account (or clears it). One SteamID per account: an org that hands its
 * members reserved slots must know whose slot it is.
 */
/** The organisation the panel opens scoped to; null clears it (every org). */
export async function setDefaultOrg(env: Env, userId: string, orgId: string | null): Promise<void> {
	await env.db.update(user).set({ defaultOrgId: orgId }).where(eq(user.id, userId));
}

export async function setSteamId(env: Env, userId: string, steamId: string | null): Promise<void> {
	if (steamId) {
		const [taken] = await env.db
			.select({ id: user.id })
			.from(user)
			.where(and(eq(user.steamId, steamId), ne(user.id, userId)))
			.limit(1);
		if (taken)
			throw new ApiError(409, 'That SteamID is already linked to another account.', 'steam_taken');
	}
	await env.db.update(user).set({ steamId, updatedAt: new Date() }).where(eq(user.id, userId));
}

export const dbNow = sql`now()`;
