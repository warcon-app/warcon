// Organisation lists: the ban list and reserved-slot list an org keeps in the panel and pushes to
// every server it runs. This module owns the records, their validation and the views; the
// per-server sync (what to add or remove on a game server) is in lists-sync.ts.
//
// Entries are never hard-deleted: removal stamps removed_at so history and the audit trail stay
// intact, and re-adding inserts a fresh row. Every org has exactly one list per kind today; the
// lists table and server_lists join exist so a later "subscribe to another org's list" is new rows,
// not a schema change.
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, int, newId, str } from './http';
import { writeAudit } from './audit';
import { listsRoleFor, type OrgRow, type ServerRow, type SessionUser } from './access';
import type { Db } from './db';
import {
	listEntries,
	lists,
	serverBans,
	serverListState,
	serverListSync,
	serverLists,
	serverReserved,
	servers,
	steamProfiles,
	type ListEntryRow,
	type ListRow
} from './db/schema';
import { requireSteamId } from './steam';
import { desiredFor, fanOut } from './lists-sync';
import type {
	ListEntryState,
	ListEntryView,
	ListKind,
	ListServerStateView,
	ListSyncSummary,
	OrgListsView,
	ServerListsState
} from '$lib/types';

export { fanOut, reconcileServer } from './lists-sync';

export type Kind = ListKind;
export const LIST_KINDS: Kind[] = ['ban', 'reserve'];
export const KIND_LABEL: Record<Kind, string> = { ban: 'ban list', reserve: 'reserved-slot list' };

/** A path segment that must name a list kind. */
export function parseKind(v: unknown): Kind {
	if (v === 'ban' || v === 'reserve') return v;
	throw new ApiError(404, 'No such list.', 'not_found');
}

/** The db or a transaction handle: the ensure* helpers run inside the caller's transaction. */
type DbLike = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

const iso = (v: Date | null | undefined): string | null => (v ? v.toISOString() : null);

// ---- records -----------------------------------------------------------------------------------

/** Every org has one list per kind. Created with the org; this also repairs anything older. */
export async function ensureOrgLists(
	db: DbLike,
	orgId: string,
	createdBy: string | null = null
): Promise<void> {
	await db
		.insert(lists)
		.values(LIST_KINDS.map((kind) => ({ id: newId(), orgId, kind, createdBy })))
		.onConflictDoNothing();
}

/** Subscribes a server to every list of its org (createServer runs this in its transaction). */
export async function ensureServerLists(
	db: DbLike,
	serverId: string,
	orgId: string
): Promise<void> {
	const rows = await db.select({ id: lists.id }).from(lists).where(eq(lists.orgId, orgId));
	if (rows.length)
		await db
			.insert(serverLists)
			.values(rows.map((l) => ({ serverId, listId: l.id })))
			.onConflictDoNothing();
}

export async function orgLists(env: Env, orgId: string): Promise<ListRow[]> {
	const load = () =>
		env.db
			.select()
			.from(lists)
			.where(eq(lists.orgId, orgId))
			.orderBy(asc(lists.kind), asc(lists.name));
	let rows = await load();
	if (LIST_KINDS.some((k) => !rows.some((l) => l.kind === k))) {
		await ensureOrgLists(env.db, orgId);
		rows = await load();
		const srv = await env.db
			.select({ id: servers.id })
			.from(servers)
			.where(eq(servers.orgId, orgId));
		for (const s of srv) await ensureServerLists(env.db, s.id, orgId);
	}
	return rows;
}

export async function listOf(env: Env, orgId: string, kind: Kind): Promise<ListRow> {
	const row = (await orgLists(env, orgId)).find((l) => l.kind === kind);
	if (!row) throw new ApiError(500, `The organisation has no ${KIND_LABEL[kind]}.`);
	return row;
}

interface ServerRef {
	id: string;
	name: string;
}

/** Every server of the org, unfiltered by who is asking (the lists apply to all of them). */
export async function orgServerRefs(env: Env, orgId: string): Promise<ServerRef[]> {
	return env.db
		.select({ id: servers.id, name: servers.name })
		.from(servers)
		.where(eq(servers.orgId, orgId))
		.orderBy(asc(servers.sortOrder), asc(servers.name));
}

// ---- names and per-server state ----------------------------------------------------------------

/** Last name each SteamID was seen with on these servers, else its cached Steam persona. */
export async function namesFor(
	env: Env,
	serverIds: string[],
	steamIds: string[]
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const ids = [...new Set(steamIds)];
	if (!ids.length) return out;
	if (serverIds.length) {
		const rows = await env.db.execute<{ steamId: string; name: string }>(sql`
			SELECT DISTINCT ON (steam_id) steam_id AS "steamId", name
			  FROM player_sessions
			 WHERE server_id IN ${serverIds} AND steam_id IN ${ids}
			 ORDER BY steam_id, last_seen DESC`);
		for (const r of rows) out.set(r.steamId, r.name);
	}
	const missing = ids.filter((id) => !out.has(id));
	if (missing.length) {
		const rows = await env.db
			.select({ steamId: steamProfiles.steamId, persona: steamProfiles.persona })
			.from(steamProfiles)
			.where(inArray(steamProfiles.steamId, missing));
		for (const r of rows) if (r.persona) out.set(r.steamId, r.persona);
	}
	return out;
}

type Standing = { state: ListEntryState; error: string; managed: boolean };

/**
 * Where each SteamID stands on each server: a state row means Warcon put it there (applied or
 * failed); otherwise present on the server means local, absent means pending.
 */
export async function standings(
	env: Env,
	kind: Kind,
	serverIds: string[],
	steamIds: string[]
): Promise<Map<string, Map<string, Standing>>> {
	const out = new Map<string, Map<string, Standing>>();
	for (const id of serverIds) out.set(id, new Map());
	if (!serverIds.length || !steamIds.length) return out;
	const observed =
		kind === 'ban'
			? env.db
					.select({ serverId: serverBans.serverId, steamId: serverBans.steamId })
					.from(serverBans)
					.where(
						and(inArray(serverBans.serverId, serverIds), inArray(serverBans.steamId, steamIds))
					)
			: env.db
					.select({ serverId: serverReserved.serverId, steamId: serverReserved.steamId })
					.from(serverReserved)
					.where(
						and(
							inArray(serverReserved.serverId, serverIds),
							inArray(serverReserved.steamId, steamIds)
						)
					);
	const [seen, state] = await Promise.all([
		observed,
		env.db
			.select()
			.from(serverListState)
			.where(
				and(
					eq(serverListState.kind, kind),
					inArray(serverListState.serverId, serverIds),
					inArray(serverListState.steamId, steamIds)
				)
			)
	]);
	for (const r of seen)
		out.get(r.serverId)?.set(r.steamId, { state: 'local', error: '', managed: false });
	for (const r of state)
		out.get(r.serverId)?.set(r.steamId, { state: r.state, error: r.error, managed: true });
	return out;
}

const standingOf = (
	s: Map<string, Standing> | undefined,
	steamId: string
): Pick<Standing, 'state' | 'error'> => s?.get(steamId) ?? { state: 'pending', error: '' };

function shapeEntry(
	r: ListEntryRow,
	kind: Kind,
	name: string | null,
	perServer: ListServerStateView[],
	now: Date
): ListEntryView {
	return {
		id: r.id,
		kind,
		steamId: r.steamId,
		name,
		reason: r.reason,
		expiresAt: iso(r.expiresAt),
		expired: !!r.expiresAt && r.expiresAt.getTime() <= now.getTime() && !r.removedAt,
		priority: r.priority,
		addedByName: r.addedByName,
		addedAt: r.addedAt.toISOString(),
		removedAt: iso(r.removedAt),
		removedByName: r.removedByName,
		removal: r.removal,
		member: false,
		servers: perServer
	};
}

// ---- views -------------------------------------------------------------------------------------

export async function orgListsView(
	env: Env,
	org: OrgRow,
	role: 'owner' | 'editor'
): Promise<OrgListsView> {
	const rows = await orgLists(env, org.id);
	const [counts, srv] = await Promise.all([
		env.db
			.select({ listId: listEntries.listId, n: count() })
			.from(listEntries)
			.where(
				and(
					inArray(
						listEntries.listId,
						rows.map((l) => l.id)
					),
					isNull(listEntries.removedAt)
				)
			)
			.groupBy(listEntries.listId),
		orgServerRefs(env, org.id)
	]);
	const syncRows = srv.length
		? await env.db
				.select()
				.from(serverListSync)
				.where(
					inArray(
						serverListSync.serverId,
						srv.map((s) => s.id)
					)
				)
		: [];
	const syncOf = new Map(syncRows.map((s) => [s.serverId, s]));
	const n = new Map(counts.map((c) => [c.listId, c.n]));
	return {
		role,
		membersReserved: org.membersReserved,
		servers: srv.map((s) => {
			const y = syncOf.get(s.id);
			return {
				id: s.id,
				name: s.name,
				syncedAt: iso(y?.syncedAt),
				reservedCap: y?.reservedCap ?? null,
				reservedUsed: y?.reservedUsed ?? 0,
				lastError: y?.lastError ?? ''
			};
		}),
		lists: rows.map((l) => ({ id: l.id, kind: l.kind, name: l.name, entryCount: n.get(l.id) ?? 0 }))
	};
}

/** The entries of one org list with names and where each stands on every org server. */
export async function entriesView(
	env: Env,
	org: OrgRow,
	kind: Kind,
	opts: { includeRemoved?: boolean } = {}
): Promise<ListEntryView[]> {
	const list = await listOf(env, org.id, kind);
	const rows = await env.db
		.select()
		.from(listEntries)
		.where(
			opts.includeRemoved
				? eq(listEntries.listId, list.id)
				: and(eq(listEntries.listId, list.id), isNull(listEntries.removedAt))
		)
		.orderBy(desc(listEntries.addedAt))
		.limit(2000);
	const srv = await orgServerRefs(env, org.id);
	const ids = [...new Set(rows.filter((r) => !r.removedAt).map((r) => r.steamId))];
	const serverIds = srv.map((s) => s.id);
	const [names, byServer] = await Promise.all([
		namesFor(
			env,
			serverIds,
			rows.map((r) => r.steamId)
		),
		standings(env, kind, serverIds, ids)
	]);
	const now = new Date();
	return rows.map((r) =>
		shapeEntry(
			r,
			kind,
			names.get(r.steamId) ?? null,
			r.removedAt
				? []
				: srv.map((s) => ({
						serverId: s.id,
						serverName: s.name,
						...standingOf(byServer.get(s.id), r.steamId)
					})),
			now
		)
	);
}

// ---- mutations ---------------------------------------------------------------------------------

const MAX_EXPIRY_MS = 10 * 365.25 * 86400_000;

/** An optional ISO timestamp for a ban to lift itself; at least ten seconds out, at most ten years. */
export function parseExpiry(v: unknown, now = Date.now()): Date | null {
	const text = str(v, 40);
	if (!text) return null;
	const d = new Date(text);
	if (Number.isNaN(d.getTime()))
		throw new ApiError(400, 'expiresAt must be an ISO 8601 timestamp, or empty for permanent.');
	if (d.getTime() < now + 10_000) throw new ApiError(400, 'expiresAt must be in the future.');
	if (d.getTime() > now + MAX_EXPIRY_MS)
		throw new ApiError(400, 'expiresAt must be within ten years.');
	return d;
}

async function touch(db: DbLike, listId: string): Promise<void> {
	await db.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, listId));
}

export async function addEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	kind: Kind,
	body: Record<string, unknown>
): Promise<{ entry: ListEntryView; sync: ListSyncSummary }> {
	const steamId = requireSteamId(body.steamId);
	const reason = str(body.reason, 200);
	const priority = kind === 'reserve' ? int(body.priority, 0, -1000, 1000) : 0;
	const expiresAt = kind === 'ban' ? parseExpiry(body.expiresAt) : null;
	const list = await listOf(env, org.id, kind);
	const id = newId();
	await env.db.transaction(async (tx) => {
		// Serialise adds to one list so two admins cannot race past the duplicate check; the
		// partial unique index on (list_id, steam_id) where removed_at is null is the backstop.
		await tx.execute(sql`SELECT 1 FROM ${lists} WHERE ${lists.id} = ${list.id} FOR UPDATE`);
		const [dup] = await tx
			.select({ id: listEntries.id })
			.from(listEntries)
			.where(
				and(
					eq(listEntries.listId, list.id),
					eq(listEntries.steamId, steamId),
					isNull(listEntries.removedAt)
				)
			)
			.limit(1);
		if (dup)
			throw new ApiError(409, `${steamId} is already on the ${KIND_LABEL[kind]}.`, 'duplicate');
		await tx.insert(listEntries).values({
			id,
			listId: list.id,
			steamId,
			reason,
			expiresAt,
			priority,
			addedBy: actor.id,
			addedByName: actor.username
		});
		await touch(tx, list.id);
	});
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.add',
		target: steamId,
		outcome: 'ok',
		message:
			kind === 'ban'
				? `Banned across ${org.name}${reason ? `: ${reason}` : ''}${expiresAt ? ` (until ${expiresAt.toISOString()})` : ''}`
				: `Reserved slot across ${org.name}${reason ? `: ${reason}` : ''}`,
		detail: {
			orgId: org.id,
			org: org.name,
			kind,
			listId: list.id,
			reason,
			expiresAt: iso(expiresAt),
			priority
		}
	});
	const sync = await fanOut(env, org);
	const entry = (await entriesView(env, org, kind)).find((e) => e.id === id)!;
	return { entry, sync };
}

export async function removeEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	kind: Kind,
	steamIdIn: unknown
): Promise<{ sync: ListSyncSummary }> {
	const steamId = requireSteamId(steamIdIn);
	const list = await listOf(env, org.id, kind);
	const [row] = await env.db
		.update(listEntries)
		.set({
			removedAt: new Date(),
			removedBy: actor.id,
			removedByName: actor.username,
			removal: 'manual'
		})
		.where(
			and(
				eq(listEntries.listId, list.id),
				eq(listEntries.steamId, steamId),
				isNull(listEntries.removedAt)
			)
		)
		.returning({ id: listEntries.id, reason: listEntries.reason });
	if (!row) throw new ApiError(404, `${steamId} is not on the ${KIND_LABEL[kind]}.`, 'not_found');
	await touch(env.db, list.id);
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.remove',
		target: steamId,
		outcome: 'ok',
		message:
			kind === 'ban' ? `Unbanned across ${org.name}` : `Reserved slot withdrawn across ${org.name}`,
		detail: { orgId: org.id, org: org.name, kind, listId: list.id, entryId: row.id }
	});
	const sync = await fanOut(env, org);
	return { sync };
}

// ---- per-server view (players page) ------------------------------------------------------------

/** Which of a server's bans and reserved slots the org lists manage, plus what is still pending. */
export async function serverListsState(
	env: Env,
	server: ServerRow,
	user: SessionUser
): Promise<ServerListsState> {
	const [bans, reserved, state, [sync], role] = await Promise.all([
		env.db
			.select({ steamId: serverBans.steamId })
			.from(serverBans)
			.where(eq(serverBans.serverId, server.id)),
		env.db
			.select({ steamId: serverReserved.steamId })
			.from(serverReserved)
			.where(eq(serverReserved.serverId, server.id)),
		env.db.select().from(serverListState).where(eq(serverListState.serverId, server.id)),
		env.db.select().from(serverListSync).where(eq(serverListSync.serverId, server.id)).limit(1),
		listsRoleFor(env, user, server.orgId)
	]);
	const out: ServerListsState = {
		canEditOrg: role !== null,
		orgId: server.orgId,
		bans: {},
		reserved: {},
		sync: sync
			? {
					syncedAt: iso(sync.syncedAt),
					reservedCap: sync.reservedCap,
					reservedUsed: sync.reservedUsed,
					lastError: sync.lastError
				}
			: null
	};
	for (const b of bans) out.bans[b.steamId] = { state: 'local', managed: false };
	for (const r of reserved) out.reserved[r.steamId] = { state: 'local', managed: false };
	for (const s of state) {
		const bucket = s.kind === 'ban' ? out.bans : out.reserved;
		bucket[s.steamId] = { state: s.state, managed: true };
	}
	// wanted but not yet on the server
	const org = { membersReserved: false };
	const desired = await desiredFor(env, server, org);
	for (const d of desired.bans) out.bans[d.steamId] ??= { state: 'pending', managed: true };
	for (const d of desired.reserved) out.reserved[d.steamId] ??= { state: 'pending', managed: true };
	return out;
}
