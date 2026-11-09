// Organisation lists: the ban list and reserved-slot list an org keeps in the panel and pushes to
// every server it runs, and each server's own ban and reserved-slot lists, which only that server
// takes.
// This module owns the records, their validation and the views; the per-server sync (what to add
// or remove on a game server) is in lists-sync.ts.
//
// Entries are never hard-deleted: removal stamps removed_at so history and the audit trail stay
// intact, and re-adding inserts a fresh row. Every org has exactly one default list per kind and
// every server one of each of its own; an org's other reserved-slot lists are its groups
// (slot-groups.ts), which reach the servers they are given to while they are switched on.
import { and, asc, count, desc, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
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
import type { Db, Tx } from './db';
import {
	listEntries,
	lists,
	organizations,
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
import { banReasonsFor } from './ban-reasons';
import { requireSteamId } from './steam';
import { desiredFor, memberSlots, summaryOf } from './lists-sync';
import { isListOn } from './lists-plan';
import { latestNames } from './sessions';
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
	PlayerBanView,
	ReservedSlotState,
	ServerListsState,
	SlotGroupView
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

/** Every org has one default list per kind. Created with the org; this also repairs anything older. */
export async function ensureOrgLists(
	db: DbLike,
	orgId: string,
	createdBy: string | null = null
): Promise<void> {
	await db
		.insert(lists)
		.values(LIST_KINDS.map((kind) => ({ id: newId(), orgId, kind, isDefault: true, createdBy })))
		.onConflictDoNothing();
}

/**
 * Holds the org's row to the end of the transaction, so adding a server and handing lists to the
 * org's servers take turns and neither misses the other's write. Readers are not held up.
 */
export async function lockOrg(tx: DbLike, orgId: string): Promise<void> {
	await tx.execute(
		sql`SELECT 1 FROM ${organizations} WHERE ${organizations.id} = ${orgId} FOR NO KEY UPDATE`
	);
}

/**
 * Subscribes a server to its org's default lists and to the groups for every server, and gives
 * it a ban and a reserved-slot list of its own (createServer runs this in its transaction;
 * serverListOf repairs older servers). A group of chosen servers is not touched.
 */
export async function ensureServerLists(
	db: DbLike,
	serverId: string,
	orgId: string
): Promise<void> {
	const rows = await db
		.select({ id: lists.id })
		.from(lists)
		.where(
			and(
				eq(lists.orgId, orgId),
				isNull(lists.serverId),
				isNull(lists.archivedAt),
				or(eq(lists.isDefault, true), eq(lists.everyServer, true))
			)
		);
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

/** The org's default lists, one per kind; neither its groups nor the servers' lists are among them. */
export async function orgLists(env: Env, orgId: string): Promise<ListRow[]> {
	const load = () =>
		env.db
			.select()
			.from(lists)
			.where(and(eq(lists.orgId, orgId), eq(lists.isDefault, true)))
			.orderBy(asc(lists.kind));
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

export interface ServerRef {
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
	for (const [steamId, name] of await latestNames(env.db, serverIds, ids)) out.set(steamId, name);
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
 * there (applied or failed; applied but not yet in the server's config document is pending);
 * otherwise in the document means local, absent means pending. A slot the panel withdrew that the
 * running server keeps until its restart is neither. A ban is applied everywhere: the panel
 * enforces it, nothing is placed on the server.
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
			and(
				inArray(serverReserved.serverId, serverIds),
				inArray(serverReserved.steamId, steamIds),
				eq(serverReserved.configured, true)
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
	const configured = new Set(seen.map((r) => `${r.serverId}:${r.steamId}`));
	for (const r of seen)
		out.get(r.serverId)?.set(r.steamId, { state: 'local', error: '', managed: false });
	for (const r of state)
		out.get(r.serverId)?.set(r.steamId, {
			state: placedState(r.state, configured.has(`${r.serverId}:${r.steamId}`)),
			error: r.error,
			managed: true
		});
	return out;
}

/** A slot the panel claimed is applied once the server's document holds it; till then it is pending. */
const placedState = (state: 'applied' | 'failed', inDocument: boolean): ListEntryState =>
	state === 'applied' && !inDocument ? 'pending' : state;

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
 * sync stands on each server (it pushes every list), and the ban message and quick reasons for
 * the ban list's editors.
 */
export async function orgListsView(env: Env, org: OrgRow, role: ListsRole): Promise<OrgListsView> {
	const rows = (await orgLists(env, org.id)).filter((l) => role.kinds.includes(l.kind));
	const bans = role.kinds.includes('ban');
	const [counts, srv, banReasons] = await Promise.all([
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
		orgServerRefs(env, org.id),
		bans ? banReasonsFor(env, org.id) : null
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
		banMessage: bans ? org.banMessage : null,
		banReasons,
		servers: srv.map((s) => {
			const y = syncOf.get(s.id);
			return {
				id: s.id,
				name: s.name,
				syncedAt: iso(y?.syncedAt),
				lastError: y?.lastError ?? ''
			};
		}),
		lists: rows.map((l) => ({
			id: l.id,
			kind: l.kind,
			name: l.name,
			entryCount: n.get(l.id) ?? 0
		})),
		groups: role.kinds.includes('reserve') ? await slotGroupsView(env, org.id, srv) : []
	};
}

/** The org's reserved-slot groups not archived, by name; for those who edit reserved slots. */
export async function slotGroupsView(
	env: Env,
	orgId: string,
	srv: ServerRef[],
	now = new Date()
): Promise<SlotGroupView[]> {
	const groups = await env.db
		.select()
		.from(lists)
		.where(
			and(
				eq(lists.orgId, orgId),
				isNull(lists.serverId),
				eq(lists.isDefault, false),
				isNull(lists.archivedAt)
			)
		)
		.orderBy(sql`lower(${lists.name})`);
	if (!groups.length) return [];
	const ids = groups.map((g) => g.id);
	const [counts, subs, leaving] = await Promise.all([
		env.db
			.select({ listId: listEntries.listId, n: count() })
			.from(listEntries)
			.where(and(inArray(listEntries.listId, ids), isNull(listEntries.removedAt)))
			.groupBy(listEntries.listId),
		env.db
			.select({ listId: serverLists.listId, serverId: serverLists.serverId })
			.from(serverLists)
			.where(inArray(serverLists.listId, ids)),
		// out of a server's document and still held by the running server, until it restarts
		env.db
			.select({
				listId: listEntries.listId,
				n: sql<number>`count(distinct ${listEntries.steamId})::int`
			})
			.from(listEntries)
			.innerJoin(serverLists, eq(serverLists.listId, listEntries.listId))
			.innerJoin(
				serverReserved,
				and(
					eq(serverReserved.serverId, serverLists.serverId),
					eq(serverReserved.steamId, listEntries.steamId)
				)
			)
			.where(
				and(
					inArray(listEntries.listId, ids),
					isNull(listEntries.removedAt),
					eq(serverReserved.live, true),
					eq(serverReserved.configured, false)
				)
			)
			.groupBy(listEntries.listId)
	]);
	const n = new Map(counts.map((c) => [c.listId, c.n]));
	const out = new Map(leaving.map((c) => [c.listId, c.n]));
	const given = new Set(subs.map((s) => `${s.listId}:${s.serverId}`));
	return groups.map((g) => ({
		id: g.id,
		name: g.name,
		on: isListOn(g, now),
		onFrom: iso(g.onFrom),
		onUntil: iso(g.onUntil),
		everyServer: g.everyServer,
		servers: g.everyServer ? srv : srv.filter((s) => given.has(`${g.id}:${s.id}`)),
		entryCount: n.get(g.id) ?? 0,
		leaving: out.get(g.id) ?? 0,
		createdAt: g.createdAt.toISOString()
	}));
}

/** The entries of one of the org's default lists with names and where each stands on every org server. */
export async function entriesView(
	env: Env,
	org: OrgRow,
	kind: Kind,
	opts: { includeRemoved?: boolean } = {}
): Promise<ListEntryView[]> {
	const list = await listOf(env, org.id, kind);
	return rosterOf(env, org, list, await orgServerRefs(env, org.id), {
		includeRemoved: opts.includeRemoved,
		members: kind === 'reserve' && org.membersReserved && !opts.includeRemoved
	});
}

/**
 * The entries of a list with names and where each stands on the servers given; with `members`,
 * the slots the org hands its members too (they ride on its default reserve list).
 */
export async function rosterOf(
	env: Env,
	org: OrgRow,
	list: ListRow,
	srv: ServerRef[],
	opts: { includeRemoved?: boolean; members?: boolean } = {}
): Promise<ListEntryView[]> {
	const kind = list.kind;
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
	const members = opts.members
		? (await memberSlots(env, org.id)).filter(
				(m) => !rows.some((r) => !r.removedAt && r.steamId === m.steamId)
			)
		: [];
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

export async function touch(db: DbLike, listId: string): Promise<void> {
	await db.update(lists).set({ updatedAt: new Date() }).where(eq(lists.id, listId));
}

interface NewEntry {
	steamId: string;
	reason: string;
	expiresAt: Date | null;
	addedBy: string | null;
	addedByName: string;
}

/** Inserts an active entry; `added` is false when the player is already on the list. */
export async function insertEntry(
	env: Env,
	list: ListRow,
	entry: NewEntry
): Promise<{ id: string; added: boolean }> {
	return env.db.transaction((tx) => insertInto(tx, list, entry));
}

/** How much longer an entry must make an existing one last to lengthen it. */
const LENGTHEN_MIN_MS = 3600_000;

/**
 * The insert itself, in the caller's transaction. With `lengthen`, a player already on the list
 * until at least an hour sooner than this entry would last is kept there as long as it would (for
 * good, or to its expiry): the entry keeps who added it and its reason.
 */
async function insertInto(
	tx: Tx,
	list: ListRow,
	entry: NewEntry,
	lengthen = false
): Promise<{ id: string; added: boolean; lengthened: boolean }> {
	const id = newId();
	// Serialise adds to one list so two writers cannot race past the duplicate check; the
	// partial unique index on (list_id, steam_id) where removed_at is null is the backstop.
	await tx.execute(sql`SELECT 1 FROM ${lists} WHERE ${lists.id} = ${list.id} FOR UPDATE`);
	const found = tx
		.select({ id: listEntries.id, expiresAt: listEntries.expiresAt })
		.from(listEntries)
		.where(
			and(
				eq(listEntries.listId, list.id),
				eq(listEntries.steamId, entry.steamId),
				isNull(listEntries.removedAt)
			)
		)
		.limit(1);
	// Lengthening decides from the entry's expiry: an edit of it by hand is seen, or waits.
	const [dup] = lengthen ? await found.for('update') : await found;
	if (dup) {
		// Longer by an hour at least: the same ban given again a moment later is not a longer one.
		const longer =
			dup.expiresAt !== null &&
			(entry.expiresAt === null ||
				entry.expiresAt.getTime() - dup.expiresAt.getTime() >= LENGTHEN_MIN_MS);
		if (!lengthen || !longer) return { id: dup.id, added: false, lengthened: false };
		await tx
			.update(listEntries)
			.set({ expiresAt: entry.expiresAt })
			.where(eq(listEntries.id, dup.id));
		await touch(tx, list.id);
		return { id: dup.id, added: false, lengthened: true };
	}
	await tx.insert(listEntries).values({ id, listId: list.id, ...entry });
	await touch(tx, list.id);
	return { id, added: true, lengthened: false };
}

/**
 * An entry a rule adds (the Seeding reward, a rule's ban) to an org list or a server's own: no
 * request, no signed-in actor; the caller records the outcome. `added` is false when the player
 * already holds an active entry on that list; with `lengthen` such an entry that would end sooner
 * is made to last as long (`lengthened`). With `tx` it is written in that transaction (the
 * worker's owned one), else in one of its own.
 */
export async function grantEntry(
	env: Env,
	list: ListRow,
	entry: { steamId: string; reason: string; expiresAt: Date | null; addedByName: string },
	opts: { tx?: Tx; lengthen?: boolean } = {}
): Promise<{ id: string; added: boolean; lengthened: boolean }> {
	const row = { ...entry, addedBy: null };
	return opts.tx
		? insertInto(opts.tx, list, row, opts.lengthen)
		: env.db.transaction((tx) => insertInto(tx, list, row, opts.lengthen));
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
		// what the servers' documents hold: a slot the panel withdrew that a server keeps running
		// until its restart is not one to adopt
		env.db
			.select()
			.from(serverReserved)
			.where(and(inArray(serverReserved.serverId, serverIds), eq(serverReserved.configured, true))),
		env.db.select().from(serverListState).where(inArray(serverListState.serverId, serverIds)),
		// a player the default list or a group (switched on or not) holds is not offered
		env.db
			.select()
			.from(lists)
			.where(and(eq(lists.orgId, org.id), isNull(lists.serverId), isNull(lists.archivedAt)))
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

/**
 * Every ban that holds a player on the servers the reader can open, for the dossier: the org's
 * list (once, where a server takes it), each server's own list and the game's own list. Who is
 * banned and why is View, as each server's Bans tab says it; who placed a panel ban is for those
 * who manage bans on that server or edit the org's ban list, as there, and so is lifting it.
 */
export async function playerBans(
	env: Env,
	orgId: string,
	visible: { id: string; name: string; caps: readonly string[] }[],
	steamId: string,
	orgBanEditor: boolean,
	now = new Date()
): Promise<PlayerBanView[]> {
	if (!visible.length) return [];
	const ids = visible.map((s) => s.id);
	const nameOf = new Map(visible.map((s) => [s.id, s.name]));
	const bansHere = new Set(visible.filter((s) => s.caps.includes('bans.manage')).map((s) => s.id));
	const [entries, game] = await Promise.all([
		env.db
			.select({
				serverId: serverLists.serverId,
				own: lists.serverId,
				reason: listEntries.reason,
				addedByName: listEntries.addedByName,
				addedAt: listEntries.addedAt,
				expiresAt: listEntries.expiresAt
			})
			.from(serverLists)
			.innerJoin(lists, eq(lists.id, serverLists.listId))
			.innerJoin(listEntries, eq(listEntries.listId, lists.id))
			.where(
				and(
					inArray(serverLists.serverId, ids),
					eq(lists.orgId, orgId),
					eq(lists.kind, 'ban'),
					eq(listEntries.steamId, steamId),
					isNull(listEntries.removedAt),
					or(isNull(listEntries.expiresAt), gt(listEntries.expiresAt, now))
				)
			),
		env.db
			.select({
				serverId: serverBans.serverId,
				reason: serverBans.reason,
				bannedBy: serverBans.bannedBy,
				bannedAtUtc: serverBans.bannedAtUtc
			})
			.from(serverBans)
			.where(and(inArray(serverBans.serverId, ids), eq(serverBans.steamId, steamId)))
	]);
	const order = (id: string | null) => (id === null ? -1 : ids.indexOf(id));
	const out: PlayerBanView[] = [];
	const org = entries.filter((e) => e.own === null);
	if (org.length) {
		const e = org[0];
		out.push({
			source: 'org',
			serverId: null,
			serverName: '',
			reason: e.reason,
			addedAt: iso(e.addedAt),
			expiresAt: iso(e.expiresAt),
			by: orgBanEditor || org.some((t) => bansHere.has(t.serverId)) ? e.addedByName : '',
			canUnban: orgBanEditor
		});
	}
	for (const e of entries)
		if (e.own !== null && e.own === e.serverId)
			out.push({
				source: 'server',
				serverId: e.serverId,
				serverName: nameOf.get(e.serverId) ?? '',
				reason: e.reason,
				addedAt: iso(e.addedAt),
				expiresAt: iso(e.expiresAt),
				by: orgBanEditor || bansHere.has(e.serverId) ? e.addedByName : '',
				canUnban: bansHere.has(e.serverId)
			});
	// The game's own list: kept apart from the panel's, since lifting one leaves the other.
	for (const g of game)
		out.push({
			source: 'game',
			serverId: g.serverId,
			serverName: nameOf.get(g.serverId) ?? '',
			reason: g.reason,
			addedAt: g.bannedAtUtc || null,
			expiresAt: null,
			by: g.bannedBy,
			canUnban: bansHere.has(g.serverId)
		});
	return out.sort((a, b) => order(a.serverId) - order(b.serverId));
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
			.where(and(eq(serverReserved.serverId, server.id), eq(serverReserved.configured, true))),
		env.db.select().from(serverListState).where(eq(serverListState.serverId, server.id)),
		env.db.select().from(serverListSync).where(eq(serverListSync.serverId, server.id)).limit(1),
		listsRoleFor(env, user, server.orgId)
	]);
	const orgBans = !!role?.kinds.includes('ban');
	const orgSlots = !!role?.kinds.includes('reserve');
	// who placed a ban, the message the org wraps its bans in and its quick reasons are for those
	// who manage bans here or edit the org's ban list
	const staff = orgBans || access.caps.has('bans.manage');
	const out: ServerListsState = {
		canEditOrgBans: orgBans,
		canEditOrgSlots: orgSlots,
		orgOwner: !!role?.owner,
		orgId: server.orgId,
		banMessage: null,
		banReasons: null,
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
		group: null,
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
	const inDocument = new Set(reserved.map((r) => r.steamId));
	for (const r of reserved) out.reserved[r.steamId] = slot('local', false);
	for (const s of state)
		if (s.kind === 'reserve')
			out.reserved[s.steamId] = slot(placedState(s.state, inDocument.has(s.steamId)), true);
	// wanted but not yet on the server
	const org = (await getOrg(env, server.orgId)) ?? {
		membersReserved: false,
		banMessage: DEFAULT_BAN_MESSAGE
	};
	if (staff) {
		out.banMessage = org.banMessage;
		out.banReasons = await banReasonsFor(env, server.orgId);
	}
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
	// entry is on (the org's, a group of the org's, or this server's own; see desiredOf for which
	// one a player on several shows)
	const slotIds = Object.keys(out.reserved);
	if (slotIds.length) {
		const listIds = [...new Set(desired.reserved.map((d) => d.listId))];
		const own = await serverListOf(env, server, 'reserve');
		// Who holds a slot is View; what staff wrote about it, and the group it comes from, are for
		// those who manage slots here or edit the org's reserved slots.
		const slotStaff = orgSlots || access.caps.has('slots.manage');
		const groupName = new Map(
			slotStaff && listIds.length
				? (
						await env.db
							.select({ id: lists.id, name: lists.name })
							.from(lists)
							.where(
								and(inArray(lists.id, listIds), isNull(lists.serverId), eq(lists.isDefault, false))
							)
					).map((l) => [l.id, l.name])
				: []
		);
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
			s.note = slotStaff ? e.reason : '';
			s.group = groupName.get(e.listId) ?? null;
			s.expiresAt = iso(e.expiresAt);
			if (e.listId === own.id) s.scope = 'server';
		}
	}
	return out;
}
