// Reserved-slot groups: an organisation's reserved-slot lists beside its default one, each on in a
// window set by hand or ahead of time, on every server or chosen ones. A group is a row of `lists`
// (an org list that is not the default), so its entries, their history and the sync work as for
// any list; this module owns what is a group's own: its name, its window, its servers and its
// archive. Whether a group is on is isListOn / listOnAt and nothing else, judged by each server's
// sync every minute, so nothing is written when a window opens or closes.
//
// Every function here takes a group already found with groupOf, under the org the caller was
// checked against: a group of another org, the default list, a server's own list, a ban list or an
// archived group is never reached.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, newId, str } from './http';
import { writeAudit } from './audit';
import type { OrgRow, SessionUser } from './access';
import type { Tx } from './db';
import { listEntries, lists, serverLists, servers, type ListRow } from './db/schema';
import {
	insertEntry,
	lockOrg,
	orgServerRefs,
	parseExpiry,
	rosterOf,
	slotGroupsView,
	touch,
	type ServerRef
} from './lists';
import { isListOn } from './lists-plan';
import { requireSteamId } from './steam';
import { gateway } from './gateway';
import type { ListEntryView, ListSyncSummary, SlotGroupView } from '$lib/types';

const NAME_MAX = 40;
/** A window may be set up to a year ahead, and must last past the next minute. */
const AHEAD_MAX_MS = 366 * 86400_000;
const AHEAD_MIN_MS = 60_000;
/** How many servers one request may name. */
const SERVERS_MAX = 1000;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function groupName(v: unknown): string {
	const name = str(v, NAME_MAX).trim();
	if (!name) throw new ApiError(400, 'Give the group a name.');
	return name;
}

/**
 * One of the org's groups, by id. Anything else under that id (another org's group, the default
 * list, a server's own list, a ban list, an archived group) is "Group not found.", before anything
 * is read from it or written to it.
 */
export async function groupOf(env: Env, org: OrgRow, groupId: unknown): Promise<ListRow> {
	const id = str(groupId, 64);
	const [row] = id
		? await env.db
				.select()
				.from(lists)
				.where(
					and(
						eq(lists.id, id),
						eq(lists.orgId, org.id),
						isNull(lists.serverId),
						eq(lists.kind, 'reserve'),
						eq(lists.isDefault, false),
						isNull(lists.archivedAt)
					)
				)
				.limit(1)
		: [];
	if (!row) throw new ApiError(404, 'Group not found.', 'not_found');
	return row;
}

/** A write to a group taken away since it was looked up changed nothing: the group is gone. */
async function stillThere(write: Promise<{ id: string }[]>): Promise<void> {
	if (!(await write).length) throw new ApiError(404, 'Group not found.', 'not_found');
}

/** The org's groups as their editors see them. */
export async function groupsView(env: Env, org: OrgRow): Promise<SlotGroupView[]> {
	return slotGroupsView(env, org.id, await orgServerRefs(env, org.id));
}

async function viewOf(env: Env, org: OrgRow, groupId: string): Promise<SlotGroupView> {
	return (await groupsView(env, org)).find((g) => g.id === groupId)!;
}

/** The servers a group reaches: every server of the org when it is for every server. */
async function groupServers(env: Env, group: ListRow): Promise<ServerRef[]> {
	const all = await orgServerRefs(env, group.orgId);
	if (group.everyServer) return all;
	const given = await env.db
		.select({ serverId: serverLists.serverId })
		.from(serverLists)
		.where(eq(serverLists.listId, group.id));
	const ids = new Set(given.map((g) => g.serverId));
	return all.filter((s) => ids.has(s.id));
}

type ServerChoice = { every: true } | { every: false; ids: string[] };

/** `servers`: "every", or a list of the org's server ids. Read under the org's lock. */
async function serverChoice(tx: Tx, orgId: string, v: unknown): Promise<ServerChoice> {
	if (v === 'every') return { every: true };
	if (!Array.isArray(v))
		throw new ApiError(400, 'servers must be "every" or a list of server ids.');
	const ids = [...new Set(v.slice(0, SERVERS_MAX).map((x) => str(x, 64)))].filter(Boolean);
	if (!ids.length) throw new ApiError(400, 'Choose at least one server, or every server.');
	const found = await tx
		.select({ id: servers.id })
		.from(servers)
		.where(and(eq(servers.orgId, orgId), inArray(servers.id, ids)));
	// no id is echoed: one that is not this org's is not to be told apart from one that is no one's
	if (found.length !== ids.length)
		throw new ApiError(400, 'One of those servers is not in this organisation.');
	return { every: false, ids };
}

/** Gives the group to the servers chosen (to every server of the org, for every server). */
async function setServers(tx: Tx, groupId: string, orgId: string, c: ServerChoice): Promise<void> {
	await tx.delete(serverLists).where(eq(serverLists.listId, groupId));
	const ids = c.every
		? (await tx.select({ id: servers.id }).from(servers).where(eq(servers.orgId, orgId))).map(
				(s) => s.id
			)
		: c.ids;
	if (ids.length)
		await tx
			.insert(serverLists)
			.values(ids.map((serverId) => ({ serverId, listId: groupId })))
			.onConflictDoNothing();
}

/** Refuses a name another of the org's lists has (in any case): the default list's too. */
async function assertNameFree(tx: Tx, orgId: string, name: string, exceptId?: string) {
	const [taken] = await tx
		.select({ id: lists.id })
		.from(lists)
		.where(
			and(
				eq(lists.orgId, orgId),
				isNull(lists.serverId),
				isNull(lists.archivedAt),
				sql`lower(${lists.name}) = lower(${name})`,
				exceptId ? sql`${lists.id} <> ${exceptId}` : undefined
			)
		)
		.limit(1);
	if (taken) throw new ApiError(409, `The name "${name}" is taken.`, 'duplicate');
}

/** A new group, off until it is switched on, on every server unless servers are chosen. */
export async function createGroup(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<{ group: SlotGroupView }> {
	const name = groupName(body.name);
	const id = newId();
	const now = new Date();
	const choice = await env.db.transaction(async (tx) => {
		await lockOrg(tx, org.id);
		const choice = await serverChoice(tx, org.id, body.servers ?? 'every');
		await assertNameFree(tx, org.id, name);
		await tx.insert(lists).values({
			id,
			orgId: org.id,
			kind: 'reserve',
			name,
			isDefault: false,
			onUntil: now,
			everyServer: choice.every,
			createdBy: actor.id,
			createdAt: now,
			updatedAt: now
		});
		await setServers(tx, id, org.id, choice);
		return choice;
	});
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.group.create',
		target: name,
		outcome: 'ok',
		message: `Reserved-slot group ${name} made in ${org.name}`,
		detail: {
			orgId: org.id,
			groupId: id,
			group: name,
			servers: choice.every ? 'every' : choice.ids
		}
	});
	return { group: await viewOf(env, org, id) };
}

/** Renames a group or changes its servers; a change of servers takes effect on them at once. */
export async function updateGroup(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	group: ListRow,
	body: Record<string, unknown>
): Promise<{ group: SlotGroupView; sync: ListSyncSummary }> {
	const name = body.name !== undefined ? groupName(body.name) : null;
	if (name === null && body.servers === undefined)
		throw new ApiError(400, 'Nothing to change: send name, servers or both.');
	const c = await env.db.transaction(async (tx) => {
		await lockOrg(tx, org.id);
		if (name !== null) await assertNameFree(tx, org.id, name, group.id);
		const choice = body.servers !== undefined ? await serverChoice(tx, org.id, body.servers) : null;
		await stillThere(
			tx
				.update(lists)
				.set({
					...(name !== null ? { name } : {}),
					...(choice ? { everyServer: choice.every } : {}),
					updatedAt: new Date()
				})
				.where(and(eq(lists.id, group.id), isNull(lists.archivedAt)))
				.returning({ id: lists.id })
		);
		if (choice) await setServers(tx, group.id, org.id, choice);
		return choice;
	});
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.group.update',
		target: name ?? group.name,
		outcome: 'ok',
		message:
			`Reserved-slot group ${group.name}` +
			(name !== null && name !== group.name ? ` renamed ${name}` : '') +
			(c ? ` given to ${c.every ? 'every server' : `${c.ids.length} server(s)`}` : ''),
		detail: {
			orgId: org.id,
			groupId: group.id,
			group: name ?? group.name,
			...(c ? { servers: c.every ? 'every' : c.ids } : {})
		}
	});
	// a group that is on reaches other servers now; a rename changes nothing on a server
	const sync =
		c && isListOn(group, new Date())
			? await gateway().syncOrg(env, org)
			: ({ servers: [] } as ListSyncSummary);
	return { group: await viewOf(env, org, group.id), sync };
}

/**
 * Takes a group away: it is off for good and its name is free again, while its entries, its
 * servers and their history stay. Its slots come off the servers as for a switch off.
 */
export async function archiveGroup(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	group: ListRow
): Promise<{ sync: ListSyncSummary }> {
	const now = new Date();
	await stillThere(
		env.db
			.update(lists)
			.set({ archivedAt: now, updatedAt: now })
			.where(and(eq(lists.id, group.id), isNull(lists.archivedAt)))
			.returning({ id: lists.id })
	);
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.group.archive',
		target: group.name,
		outcome: 'ok',
		message: `Reserved-slot group ${group.name} removed from ${org.name}`,
		detail: { orgId: org.id, groupId: group.id, group: group.name }
	});
	const sync = isListOn(group, now)
		? await gateway().syncOrg(env, org)
		: ({ servers: [] } as ListSyncSummary);
	return { sync };
}

/** A time a window is set to, as the browser sent it (UTC). */
function instant(v: unknown, what: string, now: number): Date {
	const d = new Date(str(v, 40));
	if (Number.isNaN(d.getTime())) throw new ApiError(400, `${what} must be an ISO 8601 timestamp.`);
	if (d.getTime() > now + AHEAD_MAX_MS)
		throw new ApiError(400, `${what} must be within a year from now.`);
	return d;
}

const blank = (v: unknown) => v === undefined || v === null || v === '';

/**
 * Switches a group on or off, or sets the window it is on in:
 * `{ on: false }` ends it now; `{ on: true, until }` starts it now, until then or (null) until
 * switched off; `{ on: true, from, until }` sets a window ahead. Each starts a new window in place
 * of the one there was. The servers it reaches change at once when it goes on or off now; a window
 * ahead opens and closes by itself, at each server's next sync after the time.
 */
export async function switchGroup(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	group: ListRow,
	body: Record<string, unknown>
): Promise<{ group: SlotGroupView; sync: ListSyncSummary }> {
	if (typeof body.on !== 'boolean') throw new ApiError(400, 'on must be true or false.');
	const now = new Date();
	const t = now.getTime();
	let onFrom: Date | null = null;
	let onUntil: Date | null = now;
	if (body.on) {
		onUntil = blank(body.until) ? null : instant(body.until, 'until', t);
		onFrom = blank(body.from) ? null : instant(body.from, 'from', t);
		if (onUntil && onUntil.getTime() < t + AHEAD_MIN_MS)
			throw new ApiError(400, 'The end must be at least a minute from now.');
		if (onFrom && !onUntil) throw new ApiError(400, 'A window that opens later needs an end too.');
		if (onFrom && onUntil && onFrom.getTime() >= onUntil.getTime())
			throw new ApiError(400, 'The start must be before the end.');
		// a start already past is a window open now
		if (onFrom && onFrom.getTime() <= t) onFrom = null;
	}
	await stillThere(
		env.db
			.update(lists)
			.set({ onFrom, onUntil, updatedAt: now })
			.where(and(eq(lists.id, group.id), isNull(lists.archivedAt)))
			.returning({ id: lists.id })
	);
	const message = !body.on
		? `${group.name} switched off`
		: onFrom
			? `${group.name} on from ${onFrom.toISOString()} until ${onUntil!.toISOString()}`
			: onUntil
				? `${group.name} on until ${onUntil.toISOString()}`
				: `${group.name} switched on`;
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.group.switch',
		target: group.name,
		outcome: 'ok',
		message,
		detail: {
			orgId: org.id,
			groupId: group.id,
			group: group.name,
			on: body.on,
			from: iso(onFrom),
			until: iso(onUntil)
		}
	});
	const was = isListOn(group, now);
	const is = isListOn({ archivedAt: null, onFrom, onUntil }, now);
	const sync =
		was !== is ? await gateway().syncOrg(env, org) : ({ servers: [] } as ListSyncSummary);
	return { group: await viewOf(env, org, group.id), sync };
}

// ---- a group's players ---------------------------------------------------------------------------

/** A group's entries, with where each stands on the servers the group reaches. */
export async function groupEntriesView(
	env: Env,
	org: OrgRow,
	group: ListRow,
	opts: { includeRemoved?: boolean } = {}
): Promise<ListEntryView[]> {
	return rosterOf(env, org, group, await groupServers(env, group), opts);
}

/** While a group is on, a change to its players reaches its servers at once; while off, never. */
const syncIfOn = async (env: Env, org: OrgRow, group: ListRow): Promise<ListSyncSummary> =>
	isListOn(group, new Date()) ? gateway().syncOrg(env, org) : { servers: [] };

export async function addGroupEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	group: ListRow,
	body: Record<string, unknown>
): Promise<{ entry: ListEntryView; sync: ListSyncSummary }> {
	const steamId = requireSteamId(body.steamId);
	const reason = str(body.reason, 200);
	const expiresAt = parseExpiry(body.expiresAt);
	const { id, added } = await insertEntry(env, group, {
		steamId,
		reason,
		expiresAt,
		addedBy: actor.id,
		addedByName: actor.username
	});
	if (!added) throw new ApiError(409, `${steamId} is already in ${group.name}.`, 'duplicate');
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.add',
		target: steamId,
		outcome: 'ok',
		message:
			`Reserved slot in ${group.name} across ${org.name}` +
			(reason ? `: ${reason}` : '') +
			(expiresAt ? ` (until ${expiresAt.toISOString()})` : ''),
		detail: {
			orgId: org.id,
			org: org.name,
			kind: 'reserve',
			listId: group.id,
			groupId: group.id,
			group: group.name,
			reason,
			expiresAt: iso(expiresAt)
		}
	});
	const sync = await syncIfOn(env, org, group);
	const entry = (await groupEntriesView(env, org, group)).find((e) => e.id === id)!;
	return { entry, sync };
}

export async function removeGroupEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	group: ListRow,
	steamIdIn: unknown
): Promise<{ sync: ListSyncSummary }> {
	const steamId = requireSteamId(steamIdIn);
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
				eq(listEntries.listId, group.id),
				eq(listEntries.steamId, steamId),
				isNull(listEntries.removedAt)
			)
		)
		.returning({ id: listEntries.id });
	if (!row) throw new ApiError(404, `${steamId} is not in ${group.name}.`, 'not_found');
	await touch(env.db, group.id);
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.remove',
		target: steamId,
		outcome: 'ok',
		message: `Reserved slot in ${group.name} withdrawn across ${org.name}`,
		detail: {
			orgId: org.id,
			org: org.name,
			kind: 'reserve',
			listId: group.id,
			groupId: group.id,
			group: group.name,
			entryId: row.id
		}
	});
	return { sync: await syncIfOn(env, org, group) };
}

/** Changes the note or the expiry of a group's entry; nothing is sent to a server. */
export async function updateGroupEntry(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	group: ListRow,
	steamIdIn: unknown,
	body: Record<string, unknown>
): Promise<{ entry: { steamId: string; reason: string; expiresAt: string | null } }> {
	const steamId = requireSteamId(steamIdIn);
	const set: { reason?: string; expiresAt?: Date | null } = {};
	if ('reason' in body) set.reason = str(body.reason, 200);
	if ('expiresAt' in body) set.expiresAt = parseExpiry(body.expiresAt);
	if (!('reason' in set) && !('expiresAt' in set))
		throw new ApiError(400, 'Nothing to change: send reason, expiresAt or both.');
	const [row] = await env.db
		.update(listEntries)
		.set(set)
		.where(
			and(
				eq(listEntries.listId, group.id),
				eq(listEntries.steamId, steamId),
				isNull(listEntries.removedAt)
			)
		)
		.returning({
			id: listEntries.id,
			reason: listEntries.reason,
			expiresAt: listEntries.expiresAt
		});
	if (!row) throw new ApiError(404, `${steamId} is not in ${group.name}.`, 'not_found');
	await touch(env.db, group.id);
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'list.update',
		target: steamId,
		outcome: 'ok',
		message:
			`Reserved slot in ${group.name} changed across ${org.name}` +
			('expiresAt' in set
				? set.expiresAt
					? ` (until ${set.expiresAt.toISOString()})`
					: ' (permanent)'
				: ''),
		detail: {
			kind: 'reserve',
			listId: group.id,
			groupId: group.id,
			group: group.name,
			entryId: row.id,
			...('reason' in set ? { reason: set.reason } : {}),
			...('expiresAt' in set ? { expiresAt: iso(set.expiresAt ?? null) } : {})
		}
	});
	return { entry: { steamId, reason: row.reason, expiresAt: iso(row.expiresAt) } };
}
