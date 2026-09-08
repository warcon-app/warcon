// Server records: validation, CRUD helpers and the reachability test.
import { asc, eq } from 'drizzle-orm';
import type { Env } from './env';
import { isDemoServer } from './env';
import { ApiError, int, newId, publicMessage, str } from './http';
import { encryptSecret } from './crypto';
import { writeAudit } from './audit';
import {
	SERVER_ROLES,
	type OrgRow,
	type ServerRole,
	type ServerRow,
	type SessionUser
} from './access';
import { ACTIONS } from './actions';
import { GameError, WardogsClient } from './rcon';
import { serverGrants, servers, user } from './db/schema';
import { assertCanAddServer, ensureMemberships } from './orgs';

export interface TargetFields {
	name?: string;
	host?: string;
	port?: number;
	scheme?: 'http' | 'https';
	notes?: string;
	sortOrder?: number;
}

export function validateTarget(
	env: Env,
	body: Record<string, unknown>,
	partial = false
): TargetFields {
	const out: TargetFields = {};
	if (!partial || body.name !== undefined) {
		out.name = str(body.name, 80);
		if (!out.name) throw new ApiError(400, 'name is required.');
	}
	if (!partial || body.host !== undefined) {
		out.host = str(body.host, 253).toLowerCase();
		if (!out.host) throw new ApiError(400, 'host is required.');
		if (!isDemoServer(env, { host: out.host }) && !/^[a-z0-9.\-:[\]]+$/.test(out.host))
			throw new ApiError(400, 'host must be a hostname or IP address.');
	}
	if (!partial || body.port !== undefined) {
		out.port = int(body.port, 0, 1, 65535);
		if (!out.port) throw new ApiError(400, 'port must be 1-65535.');
	}
	if (!partial || body.scheme !== undefined)
		out.scheme = body.scheme === 'https' ? 'https' : 'http';
	if (body.notes !== undefined) out.notes = str(body.notes, 2000);
	if (body.sortOrder !== undefined) out.sortOrder = int(body.sortOrder, 0, -1000, 1000);
	return out;
}

export async function createServer(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<string> {
	const t = validateTarget(env, body);
	const password = typeof body.password === 'string' ? body.password : '';
	if (!password) throw new ApiError(400, "password (the server's RCON password) is required.");
	await assertCanAddServer(env, org, actor);
	const orgId = org.id;
	const id = newId();
	await env.db.insert(servers).values({
		id,
		orgId,
		name: t.name!,
		host: t.host!,
		port: t.port!,
		scheme: t.scheme!,
		passwordEnc: encryptSecret(env, password),
		notes: t.notes || '',
		sortOrder: t.sortOrder || 0,
		createdBy: actor.id
	});
	await writeAudit(env, req, {
		actor,
		server: { id, name: t.name! },
		category: 'server',
		action: 'server.create',
		outcome: 'ok',
		target: `${t.host}:${t.port}`,
		detail: { scheme: t.scheme, orgId }
	});
	return id;
}

export async function updateServer(
	env: Env,
	req: Request,
	actor: SessionUser,
	server: ServerRow,
	body: Record<string, unknown>
): Promise<void> {
	const t = validateTarget(env, body, true);
	const set: Partial<typeof servers.$inferInsert> = { ...t };
	if (typeof body.password === 'string' && body.password)
		set.passwordEnc = encryptSecret(env, body.password);
	if (!Object.keys(set).length) throw new ApiError(400, 'Nothing to update.');
	set.updatedAt = new Date();
	await env.db.update(servers).set(set).where(eq(servers.id, server.id));
	await writeAudit(env, req, {
		actor,
		server: { id: server.id, name: t.name || server.name },
		category: 'server',
		action: 'server.update',
		outcome: 'ok',
		detail: { ...t, credentialRotated: !!body.password }
	});
}

export async function deleteServer(
	env: Env,
	req: Request,
	actor: SessionUser,
	server: ServerRow
): Promise<void> {
	await env.db.delete(servers).where(eq(servers.id, server.id)); // grants cascade
	await writeAudit(env, req, {
		actor,
		server: { id: server.id, name: server.name },
		category: 'server',
		action: 'server.delete',
		outcome: 'ok',
		target: `${server.host}:${server.port}`
	});
}

export interface TestResult {
	ok: boolean;
	status?: unknown;
	capabilities?: unknown;
	durationMs: number;
	error?: { message: string; status: number };
}

/** Connectivity check: hits /v1/status and reports what came back. */
export async function testServer(
	env: Env,
	req: Request,
	actor: SessionUser,
	server: ServerRow
): Promise<TestResult> {
	const started = Date.now();
	try {
		const client = await WardogsClient.forServer(env, server);
		const status = await ACTIONS.status.run(client, {});
		let capabilities: unknown = null;
		try {
			capabilities = await ACTIONS.capabilities.run(client, {});
		} catch {
			/* older plugin builds lack it */
		}
		const durationMs = Date.now() - started;
		await writeAudit(env, req, {
			actor,
			server: { id: server.id, name: server.name },
			category: 'server',
			action: 'server.test',
			outcome: 'ok',
			durationMs
		});
		return { ok: true, status, capabilities, durationMs };
	} catch (err) {
		const durationMs = Date.now() - started;
		const status = err instanceof GameError ? err.status : 500;
		const raw = publicMessage(err);
		const message =
			status === 401 ? `The game server rejected the stored RCON password: ${raw}` : raw;
		await writeAudit(env, req, {
			actor,
			server: { id: server.id, name: server.name },
			category: 'server',
			action: 'server.test',
			outcome: 'error',
			status,
			message,
			durationMs
		});
		return { ok: false, error: { message, status }, durationMs };
	}
}

export interface GrantView {
	userId: string;
	username: string | null;
	name: string;
	role: ServerRole;
	createdAt: Date;
}

export const serverGrantsFor = (env: Env, serverId: string): Promise<GrantView[]> =>
	env.db
		.select({
			userId: serverGrants.userId,
			username: user.username,
			name: user.name,
			role: serverGrants.role,
			createdAt: serverGrants.createdAt
		})
		.from(serverGrants)
		.innerJoin(user, eq(user.id, serverGrants.userId))
		.where(eq(serverGrants.serverId, serverId))
		.orderBy(asc(user.username));

export async function setServerGrants(
	env: Env,
	req: Request,
	actor: SessionUser,
	server: ServerRow,
	grants: unknown
) {
	const wanted = Array.isArray(grants) ? (grants as { userId?: unknown; role?: unknown }[]) : [];
	const users = new Set((await env.db.select({ id: user.id }).from(user)).map((u) => u.id));
	const applied: { userId: string; role: ServerRole }[] = [];
	for (const g of wanted) {
		const userId = str(g.userId, 64);
		const role = g.role as ServerRole;
		if (!users.has(userId) || !SERVER_ROLES.includes(role)) continue;
		if (!applied.some((a) => a.userId === userId)) applied.push({ userId, role });
	}
	await env.db.transaction(async (tx) => {
		await tx.delete(serverGrants).where(eq(serverGrants.serverId, server.id));
		if (applied.length)
			await tx.insert(serverGrants).values(
				applied.map((a) => ({
					serverId: server.id,
					userId: a.userId,
					role: a.role,
					grantedBy: actor.id
				}))
			);
		await ensureMemberships(
			tx,
			applied.map((a) => ({ orgId: server.orgId, userId: a.userId }))
		);
	});
	await writeAudit(env, req, {
		actor,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: 'server.grants',
		outcome: 'ok',
		detail: { grants: applied }
	});
	return applied;
}
