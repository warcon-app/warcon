// Organisation lists: the ban list and reserved-slot list an org keeps in the panel and pushes to
// every server it runs, and each server's own ban and reserved-slot lists, which only that server
// takes.
// This module owns the records, their validation and the views; the per-server sync (what to add
// or remove on a game server) is in lists-sync.ts.
//
// Entries are never hard-deleted: removal stamps removed_at so history and the audit trail stay
// intact, and re-adding inserts a fresh row. Every org has exactly one list per kind and every
// server one of each of its own; the lists table and server_lists join exist so a
// later "subscribe to another org's list" is new rows, not a schema change.
import { and, asc, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, newId, str } from './http';
import { writeAudit } from './audit';
import {
	getOrg,
	listsRoleFor,
	type ListsRole,
	type OrgRow,
	type ServerAccess,
	type ServerRow,
	type SessionUser
} from './access';
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
import { DEFAULT_BAN_MESSAGE } from '$lib/ban-message';
import { requireSteamId } from './steam';
import { desiredFor, memberSlots, summaryOf } from './lists-sync';
import { gateway } from './gateway';
import type {
	ImportCandidate,
	ListEntryState,
	ListEntryView,
	ListKind,
	ListServerStateView,
	ListSyncServer,
	ListSyncSummary,
	OrgListsView,
	BanState,
	ReservedSlotState,
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

/**
 * Subscribes a server to every list of its org and gives it a ban and a reserved-slot list of
 * its own (createServer runs this in its transaction; serverListOf repairs older servers).
 */
export async function ensureServerLists(
	db: DbLike,
	serverId: string,
	orgId: string
): Promise<void> {
	const rows = await db
		.select({ id: lists.id })
		.from(lists)
		.where(and(eq(lists.orgId, orgId), isNull(lists.serverId)));
	if (rows.length)
		await db
			.insert(serverLists)
			.values(rows.map((l) => ({ serverId, listId: l.id })))
			.onConflictDoNothing();
	for (const kind of LIST_KINDS) await ensureServerOwnList(db, serverId, orgId, kind);
}

async function ensureServerOwnList(
	db: DbLike,
	serverId: string,
	orgId: string,
	kind: Kind
): Promise<ListRow> {
	const load = () =>
		db
			.select()
			.from(lists)
			.where(and(eq(lists.serverId, serverId), eq(lists.kind, kind)))
			.limit(1);
	let [row] = await load();
	if (!row) {
		await db
			.insert(lists)
			.values({ id: newId(), orgId, serverId, kind, name: 'Server' })
			.onConflictDoNothing();
		[row] = await load();
	}
	await db.insert(serverLists).values({ serverId, listId: row.id }).onConflictDoNothing();
	return row;
}

/** The org's own lists, one per kind; the servers' lists are not among them. */
export async function orgLists(env: Env, orgId: string): Promise<ListRow[]> {
	const load = () =>
		env.db
			.select()
			.from(lists)
			.where(and(eq(lists.orgId, orgId), isNull(lists.serverId)))
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

/** A server's own list of a kind, which only that server takes; created on first use. */
export async function serverListOf(
	env: Env,
	server: Pick<ServerRow, 'id' | 'orgId'>,
	kind: Kind
): Promise<ListRow> {
	return ensureServerOwnList(env.db, server.id, server.orgId, kind);
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
 * Where each SteamID stands on each server. A reserved slot: a state row means Warcon put it
 * there (applied or failed); otherwise present on the server means local, absent means pending.
 * A ban is applied everywhere: the panel enforces it, nothing is placed on the server.
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
	// A ban is the panel's to enforce (kickBanned): it is in force on every server of the list
	// the moment it is on the list, whatever the game's own ban list holds.
	if (kind === 'ban') {
		for (const standing of out.values())
			for (const steamId of steamIds)
				standing.set(steamId, { state: 'applied', error: '', managed: true });
		return out;
	}
	const observed = env.db
		.select({ serverId: serverReserved.serverId, steamId: serverReserved.steamId })
		.from(serverReserved)
		.where(
			and(inArray(serverReserved.serverId, serverIds), inArray(serverReserved.steamId, steamIds))
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

/**
 * The org's lists as one person may see them: the lists they edit with their counts, where the
 * sync stands on each server (it pushes every list), and the ban message for the ban list's
 * editors.
 */
export async function orgListsView(env: Env, org: OrgRow, role: ListsRole): Promise<OrgListsView> {
	const rows = (await orgLists(env, org.id)).filter((l) => role.kinds.includes(l.kind));
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
		role: role.owner ? 'owner' : 'editor',
		kinds: role.kinds,
		membersReserved: org.membersReserved,
		banMessage: role.kinds.includes('ban') ? org.banMessage : null,
		servers: srv.map((s) => {
			const y = syncOf.get(s.id);
			return {
				id: s.id,
				name: s.name,
				syncedAt: iso(y?.syncedAt),
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
	// Members-reserved: slots the org hands its members are shown like entries, but come from
	// the membership rather than a row someone added.
	const members =
		kind === 'reserve' && org.membersReserved && !opts.includeRemoved
			? (await memberSlots(env, org.id)).filter(
					(m) => !rows.some((r) => !r.removedAt && r.steamId === m.steamId)
				)
			: [];
	const srv = await orgServerRefs(env, org.id);
	const ids = [
		...new Set([
			...rows.filter((r) => !r.removedAt).map((r) => r.steamId),
			...members.map((m) => m.steamId)
		])
	];
	const serverIds = srv.map((s) => s.id);
	const [names, byServer] = await Promise.all([
		namesFor(env, serverIds, [...rows.map((r) => r.steamId), ...members.map((m) => m.steamId)]),
		standings(env, kind, serverIds, ids)
	]);
	const now = new Date();
	const perServer = (steamId: string) =>
		srv.map((s) => ({
			serverId: s.id,
			serverName: s.name,
			...standingOf(byServer.get(s.id), steamId)
		}));
	const out = rows.map((r) =>
		shapeEntry(r, kind, names.get(r.steamId) ?? null, r.removedAt ? [] : perServer(r.steamId), now)
	);
	for (const m of members)
		out.push({
			id: `member:${m.userId}`,
			kind,
			steamId: m.steamId,
			name: names.get(m.steamId) ?? (m.username ? `@${m.username}` : null),
			reason: m.username ? `member @${m.username}` : 'member',
			expiresAt: null,
			expired: false,
			addedByName: '',
			addedAt: m.since.toISOString(),
			removedAt: null,
			removedByName: '',
			removal: null,
			member: true,
			servers: perServer(m.steamId)
		});
	return out;
}

// ---- mutations ---------------------------------------------------------------------------------

const MAX_EXPIRY_MS = 10 * 365.25 * 86400_000;

/** An optional ISO timestamp for an entry to lift itself; at least ten seconds out, at most ten years. */
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

interface NewEntry {
	steamId: string;
	reason: string;
	expiresAt: Date | null;
	addedBy: string | null;
	addedByName: string;
}

/** Inserts an active entry; optionally soft-removes an active duplicate before inserting. */
async function insertEntry(
	env: Env,
	list: ListRow,
	entry: NewEntry,
	replaceExisting = false
): Promise<{ id: string; added: boolean; replaced: boolean }> {
	const id = newId();
	return env.db.transaction(async (tx) => {
		// Serialise adds to one list so two writers cannot race past the duplicate check; the
		// partial unique index on (list_id, steam_id) where removed_at is null is the backstop.
		await tx.execute(sql`SELECT 1 FROM ${lists} WHERE ${lists.id} = ${list.id} FOR UPDATE`);
		const [dup] = await tx
			.select({ id: listEntries.id })
			.from(listEntries)
			.where(
				and(
					eq(listEntries.listId, list.id),
					eq(listEntries.steamId, entry.steamId),
					isNull(listEntries.removedAt)
				)
			)
			.limit(1);
		if (dup && !replaceExisting) return { id: dup.id, added: false, replaced: false };
		if (dup)
			await tx
				.update(listEntries)
				.set({
					removedAt: new Date(),
					removedBy: null,
					removedByName: entry.addedByName,
					removal: 'manual'
				})
				.where(eq(listEntries.id, dup.id));
		await tx.insert(listEntries).values({ id, listId: list.id, ...entry });
		await touch(tx, list.id);
		return { id, added: true, replaced: !!dup };
	});
}

/**
 * An entry a rule adds (the Seeding reward) to an org list or a server's own: no request, no
 * signed-in actor; the caller records the outcome. `added` is false when the player already
 * holds an active entry on that list and replacement was not requested.
 */
export async function grantEntry(
	env: Env,
	list: ListRow,
	entry: { steamId: string; reason: string; expiresAt: Date | null; addedByName: string },
	opts: { replaceExisting?: boolean } = {}
): Promise<{ id: string; added: boolean; replaced: boolean }> {
	return insertEntry(env, list, { ...entry, addedBy: null }, !!opts.replaceExisting);
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
	const expiresAt = parseExpiry(body.expiresAt);
	const list = await listOf(env, org.id, kind);
	const { id, added } = await insertEntry(env, list, {
		steamId,
		reason,
		expiresAt,
		addedBy: actor.id,
		addedByName: actor.username
	});
	if (!added)
		throw new ApiError(409, `${steamId} is already on the ${KIND_LABEL[kind]}.`, 'duplicate');
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.add',
		target: steamId,
		outcome: 'ok',
		message:
			(kind === 'ban' ? `Banned across ${org.name}` : `Reserved slot across ${org.name}`) +
			(reason ? `: ${reason}` : '') +
			(expiresAt ? ` (until ${expiresAt.toISOString()})` : ''),
		detail: {
			orgId: org.id,
			org: org.name,
			kind,
			listId: list.id,
			reason,
			expiresAt: iso(expiresAt)
		}
	});
	const sync = await gateway().syncOrg(env, org);
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
	const sync = await gateway().syncOrg(env, org);
	return { sync };
}

// ---- a server's own bans and reserved slots ----------------------------------------------------

/**
 * Bans a player or reserves a slot on one server through its own list: the panel applies it to
 * the server now and lifts it at the expiry, unlike one written straight to the server, which it
 * never touches. A ban the game refuses because the player is not connected stays on the list,
 * and lands the moment they are seen (banOnSight).
 */
export async function addServerEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	server: ServerRow,
	org: OrgRow,
	kind: Kind,
	body: Record<string, unknown>
): Promise<{ sync: ListSyncServer }> {
	const steamId = requireSteamId(body.steamId);
	const reason = str(body.reason, 200);
	const expiresAt = parseExpiry(body.expiresAt);
	const list = await serverListOf(env, server, kind);
	const { added } = await insertEntry(env, list, {
		steamId,
		reason,
		expiresAt,
		addedBy: actor.id,
		addedByName: actor.username
	});
	if (!added)
		throw new ApiError(
			409,
			kind === 'ban'
				? `${steamId} is already on ${server.name}'s ban list.`
				: `${steamId} already holds a reserved slot on ${server.name}.`,
			'duplicate'
		);
	await writeAudit(env, req, {
		actor,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: 'list.add',
		target: steamId,
		outcome: 'ok',
		message:
			`${kind === 'ban' ? 'Banned' : 'Reserved slot'} on ${server.name}` +
			(reason ? `: ${reason}` : '') +
			(expiresAt ? ` (until ${expiresAt.toISOString()})` : ''),
		detail: { kind, listId: list.id, reason, expiresAt: iso(expiresAt) }
	});
	const sync = summaryOf(await gateway().syncServer(env, server, org, 15_000));
	return { sync };
}

/** Withdraws a ban or slot the server's own list holds; the sync takes it off the server. */
export async function removeServerEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	server: ServerRow,
	org: OrgRow,
	kind: Kind,
	steamIdIn: unknown
): Promise<{ sync: ListSyncServer }> {
	const steamId = requireSteamId(steamIdIn);
	const list = await serverListOf(env, server, kind);
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
		.returning({ id: listEntries.id });
	if (!row)
		throw new ApiError(
			404,
			kind === 'ban'
				? `${steamId} is not on ${server.name}'s own ban list.`
				: `${steamId} holds no reserved slot of ${server.name}'s own.`,
			'not_found'
		);
	await touch(env.db, list.id);
	await writeAudit(env, req, {
		actor,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: 'list.remove',
		target: steamId,
		outcome: 'ok',
		message:
			kind === 'ban' ? `Unbanned on ${server.name}` : `Reserved slot withdrawn on ${server.name}`,
		detail: { kind, listId: list.id, entryId: row.id }
	});
	const sync = summaryOf(await gateway().syncServer(env, server, org, 15_000));
	return { sync };
}

/**
 * Changes the reason or the expiry of an active entry, on the org's list or (with `server`) on
 * that server's own. The row keeps who added it and when. No game call follows: the panel lifts
 * an entry at its expiry whenever that comes, and the reason shown is the panel's.
 */
export async function updateEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	server: ServerRow | null,
	kind: Kind,
	steamIdIn: unknown,
	body: Record<string, unknown>
): Promise<{ entry: { steamId: string; reason: string; expiresAt: string | null } }> {
	const steamId = requireSteamId(steamIdIn);
	const set: { reason?: string; expiresAt?: Date | null } = {};
	if ('reason' in body) set.reason = str(body.reason, 200);
	if ('expiresAt' in body) set.expiresAt = parseExpiry(body.expiresAt);
	if (!('reason' in set) && !('expiresAt' in set))
		throw new ApiError(400, 'Nothing to change: send reason, expiresAt or both.');
	const list = server ? await serverListOf(env, server, kind) : await listOf(env, org.id, kind);
	const [row] = await env.db
		.update(listEntries)
		.set(set)
		.where(
			and(
				eq(listEntries.listId, list.id),
				eq(listEntries.steamId, steamId),
				isNull(listEntries.removedAt)
			)
		)
		.returning({
			id: listEntries.id,
			reason: listEntries.reason,
			expiresAt: listEntries.expiresAt
		});
	const where = server ? server.name : org.name;
	if (!row)
		throw new ApiError(
			404,
			`${steamId} is not on the ${KIND_LABEL[kind]} of ${where}.`,
			'not_found'
		);
	await touch(env.db, list.id);
	await writeAudit(env, req, {
		actor,
		...(server ? { server: { id: server.id, name: server.name } } : {}),
		orgId: org.id,
		category: server ? 'server' : 'org',
		action: 'list.update',
		target: steamId,
		outcome: 'ok',
		message:
			`${kind === 'ban' ? 'Ban' : 'Reserved slot'} changed ${server ? 'on' : 'across'} ${where}` +
			('expiresAt' in set
				? set.expiresAt
					? ` (until ${set.expiresAt.toISOString()})`
					: ' (permanent)'
				: ''),
		detail: {
			kind,
			listId: list.id,
			entryId: row.id,
			...('reason' in set ? { reason: set.reason } : {}),
			...('expiresAt' in set ? { expiresAt: iso(set.expiresAt ?? null) } : {})
		}
	});
	return { entry: { steamId, reason: row.reason, expiresAt: iso(row.expiresAt) } };
}

// ---- import: adopt what servers already hold -----------------------------------------------------

/**
 * Bans and reserved slots found on the org's servers that the panel did not put there and that are
 * not on the org list yet, grouped by player, so an owner can review and adopt them.
 */
export async function importCandidates(env: Env, org: OrgRow): Promise<ImportCandidate[]> {
	const srv = await orgServerRefs(env, org.id);
	if (!srv.length) return [];
	const serverIds = srv.map((s) => s.id);
	const nameOf = new Map(srv.map((s) => [s.id, s.name]));
	const [bans, reserved, state, listRows] = await Promise.all([
		env.db.select().from(serverBans).where(inArray(serverBans.serverId, serverIds)),
		env.db.select().from(serverReserved).where(inArray(serverReserved.serverId, serverIds)),
		env.db.select().from(serverListState).where(inArray(serverListState.serverId, serverIds)),
		orgLists(env, org.id)
	]);
	const active = await env.db
		.select({ listId: listEntries.listId, steamId: listEntries.steamId })
		.from(listEntries)
		.where(
			and(
				inArray(
					listEntries.listId,
					listRows.map((l) => l.id)
				),
				isNull(listEntries.removedAt)
			)
		);
	const kindOf = new Map(listRows.map((l) => [l.id, l.kind]));
	const listed = new Set(active.map((a) => `${kindOf.get(a.listId)}:${a.steamId}`));
	const managed = new Set(state.map((s) => `${s.kind}:${s.steamId}:${s.serverId}`));
	const groups = new Map<string, ImportCandidate>();
	const add = (kind: Kind, serverId: string, steamId: string, reason: string, bannedBy: string) => {
		if (listed.has(`${kind}:${steamId}`) || managed.has(`${kind}:${steamId}:${serverId}`)) return;
		const key = `${kind}:${steamId}`;
		let g = groups.get(key);
		if (!g) {
			g = { kind, steamId, name: null, servers: [] };
			groups.set(key, g);
		}
		g.servers.push({ serverId, serverName: nameOf.get(serverId) || serverId, reason, bannedBy });
	};
	for (const b of bans) add('ban', b.serverId, b.steamId, b.reason, b.bannedBy);
	for (const r of reserved) add('reserve', r.serverId, r.steamId, '', '');
	const out = [...groups.values()];
	const names = await namesFor(
		env,
		serverIds,
		out.map((c) => c.steamId)
	);
	for (const c of out) c.name = names.get(c.steamId) ?? null;
	return out.sort(
		(a, b) => b.servers.length - a.servers.length || a.steamId.localeCompare(b.steamId)
	);
}

/**
 * Adopts server entries into the org list: each pick becomes a list entry (reason as given, else
 * the first reason a server recorded) and the servers that already hold it are marked as managed,
 * so the panel will lift it there when the entry is removed. Other servers get it on the fan-out.
 */
export async function importEntries(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	picksIn: unknown
): Promise<{ imported: number; skipped: number; sync: ListSyncSummary }> {
	const picks = (Array.isArray(picksIn) ? picksIn : []).slice(0, 500).map((p) => {
		const o = (p ?? {}) as Record<string, unknown>;
		return {
			kind: parseKind(o.kind),
			steamId: requireSteamId(o.steamId),
			reason: str(o.reason, 200)
		};
	});
	if (!picks.length) throw new ApiError(400, 'Nothing to import.');
	const candidates = await importCandidates(env, org);
	const byKey = new Map(candidates.map((c) => [`${c.kind}:${c.steamId}`, c]));
	const listRows = await orgLists(env, org.id);
	const listOfKind = new Map(listRows.map((l) => [l.kind, l]));
	const now = new Date();
	let imported = 0;
	const adopted: string[] = [];
	await env.db.transaction(async (tx) => {
		for (const p of picks) {
			const c = byKey.get(`${p.kind}:${p.steamId}`);
			if (!c) continue;
			const list = listOfKind.get(p.kind)!;
			const reason = p.reason || c.servers.find((s) => s.reason)?.reason || '';
			await tx.insert(listEntries).values({
				id: newId(),
				listId: list.id,
				steamId: p.steamId,
				reason,
				addedBy: actor.id,
				addedByName: actor.username
			});
			for (const s of c.servers)
				await tx
					.insert(serverListState)
					.values({
						serverId: s.serverId,
						kind: p.kind,
						steamId: p.steamId,
						sourceListId: list.id,
						state: 'applied',
						error: '',
						attemptedAt: now,
						updatedAt: now
					})
					.onConflictDoUpdate({
						target: [serverListState.serverId, serverListState.kind, serverListState.steamId],
						set: { sourceListId: list.id, state: 'applied', error: '', updatedAt: now }
					});
			await touch(tx, list.id);
			imported++;
			adopted.push(`${p.kind}:${p.steamId}`);
		}
	});
	if (imported)
		await writeAudit(env, req, {
			actor,
			orgId: org.id,
			category: 'org',
			action: 'list.import',
			target: `${imported} entr${imported === 1 ? 'y' : 'ies'}`,
			outcome: 'ok',
			message: `Imported ${imported} server entr${imported === 1 ? 'y' : 'ies'} into ${org.name}'s lists`,
			detail: { orgId: org.id, org: org.name, entries: adopted }
		});
	const sync = imported ? await gateway().syncOrg(env, org) : { servers: [] };
	return { imported, skipped: picks.length - imported, sync };
}

/** The player's active entries on the org lists named (those the reader edits), for the dossier. */
export async function orgListMembership(
	env: Env,
	org: OrgRow,
	steamId: string,
	kinds: ListKind[]
): Promise<{ ban: ListEntryView | null; reserve: ListEntryView | null }> {
	const [bans, reserved] = await Promise.all([
		kinds.includes('ban') ? entriesView(env, org, 'ban') : [],
		kinds.includes('reserve') ? entriesView(env, org, 'reserve') : []
	]);
	return {
		ban: bans.find((e) => e.steamId === steamId) ?? null,
		reserve: reserved.find((e) => e.steamId === steamId) ?? null
	};
}

// ---- per-server view (players page) ------------------------------------------------------------

/** Which of a server's bans and reserved slots the org lists manage, plus what is still pending. */
export async function serverListsState(
	env: Env,
	server: ServerRow,
	user: SessionUser,
	access: ServerAccess
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
	const orgBans = !!role?.kinds.includes('ban');
	const orgSlots = !!role?.kinds.includes('reserve');
	// who placed a ban, and the message the org wraps its bans in, are for those who manage bans
	// here or edit the org's ban list
	const staff = orgBans || access.caps.has('bans.manage');
	const out: ServerListsState = {
		canEditOrgBans: orgBans,
		canEditOrgSlots: orgSlots,
		orgOwner: !!role?.owner,
		orgId: server.orgId,
		banMessage: null,
		bans: {},
		reserved: {},
		sync: sync
			? {
					syncedAt: iso(sync.syncedAt),
					lastError: sync.lastError
				}
			: null
	};
	const slot = (state: ListEntryState, managed: boolean): ReservedSlotState => ({
		state,
		managed,
		name: null,
		note: '',
		member: false,
		scope: 'org',
		expiresAt: null
	});
	const ban = (state: ListEntryState, managed: boolean): BanState => ({
		state,
		managed,
		scope: 'org',
		reason: '',
		addedByName: '',
		addedAt: null,
		expiresAt: null
	});
	for (const b of bans) out.bans[b.steamId] = ban('local', false);
	for (const r of reserved) out.reserved[r.steamId] = slot('local', false);
	for (const s of state) if (s.kind === 'reserve') out.reserved[s.steamId] = slot(s.state, true);
	// wanted but not yet on the server
	const org = (await getOrg(env, server.orgId)) ?? {
		membersReserved: false,
		banMessage: DEFAULT_BAN_MESSAGE
	};
	if (staff) out.banMessage = org.banMessage;
	const desired = await desiredFor(env, server, org);
	// a ban on the lists is in force: the panel removes the player itself. One the game also
	// holds in its own list shows as the panel's.
	for (const d of desired.bans) out.bans[d.steamId] = ban('applied', true);
	// The entry behind each ban the lists want: which list it is on (the org's, or this server's
	// own), the reason and when it lifts. Who is banned and why is View (the game's own ban list
	// says as much); who placed it is for those who manage bans here or edit the org's ban list.
	if (desired.bans.length) {
		const ownBans = await serverListOf(env, server, 'ban');
		const sourceOf = new Map(desired.bans.map((d) => [d.steamId, d.listId]));
		const entries = await env.db
			.select({
				listId: listEntries.listId,
				steamId: listEntries.steamId,
				reason: listEntries.reason,
				addedByName: listEntries.addedByName,
				addedAt: listEntries.addedAt,
				expiresAt: listEntries.expiresAt
			})
			.from(listEntries)
			.where(
				and(
					inArray(listEntries.listId, [...new Set(sourceOf.values())]),
					inArray(listEntries.steamId, [...sourceOf.keys()]),
					isNull(listEntries.removedAt)
				)
			);
		for (const e of entries) {
			if (sourceOf.get(e.steamId) !== e.listId) continue;
			const b = out.bans[e.steamId];
			if (e.listId === ownBans.id) b.scope = 'server';
			b.expiresAt = iso(e.expiresAt);
			b.addedAt = iso(e.addedAt);
			b.reason = e.reason;
			if (staff) b.addedByName = e.addedByName;
		}
	}
	for (const d of desired.reserved) {
		const s = (out.reserved[d.steamId] ??= slot('pending', true));
		s.member = d.member;
	}
	// what the page shows for each slot: the player's name, and the note, expiry and list the
	// entry is on (the org's, or this server's own; an org entry wins when a player is on both)
	const slotIds = Object.keys(out.reserved);
	if (slotIds.length) {
		const listIds = [...new Set(desired.reserved.map((d) => d.listId))];
		const own = await serverListOf(env, server, 'reserve');
		const [names, entries] = await Promise.all([
			namesFor(
				env,
				(await orgServerRefs(env, server.orgId)).map((s) => s.id),
				slotIds
			),
			listIds.length
				? env.db
						.select({
							listId: listEntries.listId,
							steamId: listEntries.steamId,
							reason: listEntries.reason,
							expiresAt: listEntries.expiresAt
						})
						.from(listEntries)
						.where(
							and(
								inArray(listEntries.listId, listIds),
								inArray(listEntries.steamId, slotIds),
								isNull(listEntries.removedAt)
							)
						)
				: []
		]);
		for (const [steamId, name] of names) out.reserved[steamId].name = name;
		const sourceOf = new Map(desired.reserved.map((d) => [d.steamId, d.listId]));
		for (const e of entries) {
			if (sourceOf.get(e.steamId) !== e.listId) continue;
			const s = out.reserved[e.steamId];
			// Who holds a slot is View; what staff wrote about it is for those who manage slots here
			// or edit the org's reserved-slot list.
			s.note = orgSlots || access.caps.has('slots.manage') ? e.reason : '';
			s.expiresAt = iso(e.expiresAt);
			if (e.listId === own.id) s.scope = 'server';
		}
	}
	return out;
}
