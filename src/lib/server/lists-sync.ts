// The org-list sync: pushes each org's ban and reserved-slot lists to its game servers. The
// worker runs it on a schedule inside its observations (planning against the snapshot it keeps in
// server_bans and server_reserved, and re-reading the server before it changes anything); the API
// runs it right after an admin edits a list, so the toast can say where the change landed.
//
// Rules of the road: the panel adds what the lists want and removes only what it added itself
// (server_list_state). Every game call is idempotent in the panel's reading of it ("already
// banned" is a success, "not banned" on delete is a success), so two replicas working the same
// server at once do no harm; the in-process lock below only keeps the poller and an API call in
// one process from interleaving.
import { and, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { Env } from './env';
import { publicMessage } from './http';
import { writeAudit } from './audit';
import { ACTIONS } from './actions';
import { withServer, type Priority } from './dispatcher';
import { GameError, WardogsClient } from './rcon';
import {
	listEntries,
	lists,
	organizations,
	orgMembers,
	serverBans,
	serverListState,
	serverListSync,
	serverLists,
	serverReserved,
	servers,
	user,
	type OrgRow,
	type ServerRow
} from './db/schema';
import {
	activeEntries,
	isAlreadyApplied,
	isGone,
	isUnreachable,
	parseMaxReservedSlots,
	planHasWork,
	planSync,
	RESERVED_FULL,
	type Kind,
	type PlanInput,
	type SyncPlan
} from './lists-plan';
import type { Ban, ListSyncServer, ListSyncSummary } from '$lib/types';

/** A failed add or remove is not retried for this long (cap overflows are recomputed every run). */
const RETRY_AFTER_MS = 5 * 60_000;
/** How long an API-triggered fan-out waits for each server before reporting it as still syncing. */
const FANOUT_WAIT_MS = 15_000;

export interface Observed {
	bans: Ban[];
	reserved: string[];
}

export interface SyncResult extends ListSyncServer {
	/** why nothing ran, when nothing ran */
	skipped?: 'busy' | 'suspended';
	/** the server's lists after the run; the poller keeps its in-memory copy from this */
	observed?: { bans: string[]; reserved: string[] };
}

// ---- per-server lock ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

/** Runs fn while holding this process's lock on the server; undefined if it was busy for longer than waitMs. */
export async function withServerLock<T>(
	serverId: string,
	waitMs: number,
	fn: () => Promise<T>
): Promise<T | undefined> {
	const deadline = Date.now() + waitMs;
	for (;;) {
		const held = locks.get(serverId);
		if (!held) break;
		const left = deadline - Date.now();
		if (left <= 0) return undefined;
		const outcome = await Promise.race([
			held.then(() => 'free' as const),
			new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), left))
		]);
		if (outcome === 'timeout') return undefined;
	}
	let release!: () => void;
	locks.set(serverId, new Promise<void>((r) => (release = r)));
	try {
		return await fn();
	} finally {
		locks.delete(serverId);
		release();
	}
}

// ---- desired and observed ----------------------------------------------------------------------

/** What the lists this server subscribes to want on it right now. */
export async function desiredFor(
	env: Env,
	server: Pick<ServerRow, 'id' | 'orgId'>,
	org: Pick<OrgRow, 'membersReserved'>,
	now = new Date()
): Promise<PlanInput['desired']> {
	const rows = await env.db
		.select({ e: listEntries, kind: lists.kind })
		.from(serverLists)
		.innerJoin(lists, eq(lists.id, serverLists.listId))
		.innerJoin(listEntries, eq(listEntries.listId, lists.id))
		.where(and(eq(serverLists.serverId, server.id), isNull(listEntries.removedAt)));
	const active = activeEntries(
		rows.map((r) => ({ ...r.e, kind: r.kind })),
		now
	);
	const bans = active
		.filter((r) => r.kind === 'ban')
		.map((r) => ({ steamId: r.steamId, reason: r.reason, listId: r.listId }));
	const reserved = active
		.filter((r) => r.kind === 'reserve')
		.map((r) => ({
			steamId: r.steamId,
			listId: r.listId,
			priority: r.priority,
			addedAt: r.addedAt
		}));
	if (org.membersReserved) {
		// Members who set a SteamID get a slot from the org's reserve list, below every explicit
		// entry when a server is full, unless the org has banned them.
		const [reserveList] = await env.db
			.select({ id: lists.id })
			.from(serverLists)
			.innerJoin(lists, eq(lists.id, serverLists.listId))
			.where(and(eq(serverLists.serverId, server.id), eq(lists.kind, 'reserve')))
			.limit(1);
		if (reserveList) {
			const banned = new Set(bans.map((b) => b.steamId));
			const have = new Set(reserved.map((r) => r.steamId));
			for (const m of await memberSlots(env, server.orgId))
				if (!banned.has(m.steamId) && !have.has(m.steamId))
					reserved.push({
						steamId: m.steamId,
						listId: reserveList.id,
						priority: MEMBER_PRIORITY,
						addedAt: m.since
					});
		}
	}
	return { bans, reserved };
}

/** Explicit entries always outrank member-derived slots when a server's cap bites. */
export const MEMBER_PRIORITY = -1_000_000;

/** Members of the org who linked a SteamID on their account and are not disabled. */
export async function memberSlots(
	env: Env,
	orgId: string
): Promise<{ steamId: string; userId: string; username: string; since: Date }[]> {
	const rows = await env.db
		.select({
			steamId: user.steamId,
			userId: user.id,
			username: user.username,
			since: orgMembers.createdAt
		})
		.from(orgMembers)
		.innerJoin(user, eq(user.id, orgMembers.userId))
		.where(
			and(
				eq(orgMembers.orgId, orgId),
				isNotNull(user.steamId),
				or(isNull(user.banned), eq(user.banned, false))
			)
		)
		.orderBy(orgMembers.createdAt);
	return rows.map((r) => ({
		steamId: r.steamId!,
		userId: r.userId,
		username: r.username || '',
		since: r.since
	}));
}

/**
 * Lifts bans whose expiry has passed: the row is marked removed (so history keeps it) and the
 * next reconcile takes it off every server the panel applied it to. The poller runs this every
 * tick and fanOut before pushing, so an install without a poller still catches up on edit.
 */
export async function expireEntries(env: Env): Promise<{ lifted: number; orgIds: string[] }> {
	const now = new Date();
	const rows = await env.db
		.update(listEntries)
		.set({ removedAt: now, removedByName: 'expiry', removal: 'expired' })
		.where(
			and(
				isNull(listEntries.removedAt),
				isNotNull(listEntries.expiresAt),
				lte(listEntries.expiresAt, now)
			)
		)
		.returning({ listId: listEntries.listId, steamId: listEntries.steamId });
	if (!rows.length) return { lifted: 0, orgIds: [] };
	const listIds = [...new Set(rows.map((r) => r.listId))];
	const owners = await env.db
		.select({ listId: lists.id, orgId: lists.orgId, orgName: organizations.name })
		.from(lists)
		.innerJoin(organizations, eq(organizations.id, lists.orgId))
		.where(inArray(lists.id, listIds));
	await env.db.update(lists).set({ updatedAt: now }).where(inArray(lists.id, listIds));
	for (const o of owners) {
		const ids = rows.filter((r) => r.listId === o.listId).map((r) => r.steamId);
		await writeAudit(env, null, {
			actorName: 'list sync',
			orgId: o.orgId,
			category: 'system',
			action: 'list.expire',
			target: ids.join(', '),
			outcome: 'ok',
			message: `${ids.length} ban${ids.length === 1 ? '' : 's'} expired in ${o.orgName}`,
			detail: { orgId: o.orgId, org: o.orgName, steamIds: ids }
		}).catch((err) => console.error('[warcon] list.expire audit', err));
	}
	return { lifted: rows.length, orgIds: [...new Set(owners.map((o) => o.orgId))] };
}

async function snapshotObserved(env: Env, serverId: string): Promise<Observed> {
	const [bans, reserved] = await Promise.all([
		env.db.select().from(serverBans).where(eq(serverBans.serverId, serverId)),
		env.db
			.select({ steamId: serverReserved.steamId })
			.from(serverReserved)
			.where(eq(serverReserved.serverId, serverId))
	]);
	return {
		bans: bans.map((b) => ({
			steamId: b.steamId,
			reason: b.reason,
			bannedBy: b.bannedBy,
			bannedAtUtc: b.bannedAtUtc
		})),
		reserved: reserved.map((r) => r.steamId)
	};
}

/** Reads the server's ban list and reserved slots, one request at a time (one in flight per server). */
export async function liveObserved(client: WardogsClient): Promise<Observed> {
	const bans = (await ACTIONS.bans.run(client, {})) as { bans: Ban[] };
	const reserved = (await ACTIONS.reserved.run(client, {})) as { reserved: string[] };
	return {
		bans: bans.bans.filter((b) => /^\d{17}$/.test(b.steamId)),
		reserved: reserved.reserved.filter((id) => /^\d{17}$/.test(id))
	};
}

/** Rewrites the poller's copies of a server's ban list and reserved slots. */
export async function writeSnapshot(
	env: Env,
	serverId: string,
	observed: Observed,
	ts = new Date()
): Promise<void> {
	await env.db.transaction(async (tx) => {
		const banIds = observed.bans.map((b) => b.steamId);
		await tx
			.delete(serverBans)
			.where(
				banIds.length
					? and(eq(serverBans.serverId, serverId), notInArray(serverBans.steamId, banIds))
					: eq(serverBans.serverId, serverId)
			);
		if (banIds.length)
			await tx
				.insert(serverBans)
				.values(
					observed.bans.map((b) => ({
						serverId,
						steamId: b.steamId,
						reason: b.reason || '',
						bannedBy: b.bannedBy || '',
						bannedAtUtc: b.bannedAtUtc || '',
						seenAt: ts
					}))
				)
				.onConflictDoUpdate({
					target: [serverBans.serverId, serverBans.steamId],
					set: {
						reason: sql`excluded.reason`,
						bannedBy: sql`excluded.banned_by`,
						bannedAtUtc: sql`excluded.banned_at_utc`,
						seenAt: ts
					}
				});
		await tx
			.delete(serverReserved)
			.where(
				observed.reserved.length
					? and(
							eq(serverReserved.serverId, serverId),
							notInArray(serverReserved.steamId, observed.reserved)
						)
					: eq(serverReserved.serverId, serverId)
			);
		if (observed.reserved.length)
			await tx
				.insert(serverReserved)
				.values(observed.reserved.map((steamId) => ({ serverId, steamId, seenAt: ts })))
				.onConflictDoUpdate({
					target: [serverReserved.serverId, serverReserved.steamId],
					set: { seenAt: ts }
				});
	});
}

// ---- the run -----------------------------------------------------------------------------------

export interface ReconcileOptions {
	reason: 'poll' | 'api';
	/** how long to wait for this process's lock on the server; 0 = skip if busy */
	waitMs: number;
	client?: WardogsClient;
	/** the server's lists as just read by the caller (the poller's periodic refresh) */
	observed?: Observed;
	/**
	 * How to get at the server: a dispatcher priority to queue for its lane, or 'held' when the
	 * caller already holds the lane (the worker, inside an observation).
	 */
	lane: Priority | 'held';
}

const failure = (err: unknown) => {
	const g = err instanceof GameError ? err : null;
	return { status: g?.status ?? 500, code: g?.code, message: publicMessage(err, 'Failed.') };
};

/** Brings one server in line with its lists. Never throws for game-side trouble; records it instead. */
export async function reconcileServer(
	env: Env,
	server: ServerRow,
	org: OrgRow,
	opts: ReconcileOptions
): Promise<SyncResult> {
	const base: SyncResult = {
		serverId: server.id,
		serverName: server.name,
		ok: false,
		added: 0,
		removed: 0,
		failed: 0,
		pending: false,
		error: ''
	};
	if (org.suspendedAt) return { ...base, skipped: 'suspended', error: 'Organisation suspended.' };
	const locked = () =>
		withServerLock(server.id, opts.waitMs, () => run(env, server, org, opts, base));
	const ran =
		opts.lane === 'held' ? await locked() : await withServer(server.id, opts.lane, locked);
	return ran ?? { ...base, pending: true, skipped: 'busy', error: 'Sync already running.' };
}

async function run(
	env: Env,
	server: ServerRow,
	org: OrgRow,
	opts: ReconcileOptions,
	base: SyncResult
): Promise<SyncResult> {
	const now = new Date();
	const desired = await desiredFor(env, server, org, now);
	const state = await env.db
		.select()
		.from(serverListState)
		.where(eq(serverListState.serverId, server.id));
	const [syncRow] = await env.db
		.select()
		.from(serverListSync)
		.where(eq(serverListSync.serverId, server.id))
		.limit(1);
	let cap = syncRow?.reservedCap ?? null;
	let capCheckedAt = syncRow?.capCheckedAt ?? null;

	const planWith = (observed: Observed) =>
		planSync({
			now,
			cap,
			retryAfterMs: RETRY_AFTER_MS,
			desired,
			observed: { bans: observed.bans.map((b) => b.steamId), reserved: observed.reserved },
			state
		});

	// Plan against what we last saw; before touching the server, look again.
	let observed = opts.observed ?? (await snapshotObserved(env, server.id));
	let fresh = !!opts.observed;
	let plan = planWith(observed);
	let client = opts.client;
	let reservedRoutes = true;
	const wantsReserve = desired.reserved.some((d) => !observed.reserved.includes(d.steamId));
	if (
		!planHasWork(plan) &&
		!plan.overflow.length &&
		!wantsReserve &&
		plan.confirms.length === 0 &&
		plan.deletes.length === 0
	) {
		await bookkeep(env, server.id, {
			syncedAt: now,
			reservedCap: cap,
			reservedUsed: plan.reservedUsed,
			capCheckedAt,
			lastError: ''
		});
		return { ...base, ok: true, observed: flat(observed) };
	}
	try {
		client ??= await WardogsClient.forServer(env, server);
		if (!fresh) {
			observed = await liveObserved(client);
			fresh = true;
			await writeSnapshot(env, server.id, observed, now);
		}
		// The cap matters only when there are reserved slots to hand out; read it each time then,
		// since an admin may have just changed MaxReservedSlots to make room.
		if (wantsReserve) {
			try {
				const cfg = (await ACTIONS.config.run(client, {})) as { text?: string };
				cap = parseMaxReservedSlots(cfg.text || '');
			} catch {
				cap = null;
			}
			capCheckedAt = now;
		}
		plan = planWith(observed);
		// Live build CL-499480 has no reserved-slot routes and answers those calls 404, which would
		// otherwise read as "already gone". Ask the build once before touching reserved slots.
		if ([...plan.adds, ...plan.removes].some((x) => x.kind === 'reserve')) {
			try {
				const caps = (await ACTIONS.capabilities.run(client, {})) as {
					features: { reservedSlots: boolean };
				};
				reservedRoutes = caps.features.reservedSlots;
			} catch {
				/* a build too old to report capabilities still has the routes */
			}
		}
	} catch (err) {
		const message = publicMessage(err, 'Could not reach the server.');
		await bookkeep(env, server.id, {
			syncedAt: syncRow?.syncedAt ?? null,
			reservedCap: cap,
			reservedUsed: syncRow?.reservedUsed ?? 0,
			capCheckedAt,
			lastError: message
		});
		return { ...base, error: message };
	}

	const outcome = await execute(client, plan, observed, reservedRoutes);
	await record(env, server.id, plan, outcome, now, {
		syncedAt: now,
		reservedCap: cap,
		reservedUsed: plan.reservedUsed - outcome.failedAdds.filter((f) => f.kind === 'reserve').length,
		capCheckedAt,
		lastError: outcome.aborted ?? ''
	});

	const failedNow = [
		...outcome.failedAdds,
		...outcome.failedRemoves,
		...plan.overflow.map((o) => ({ ...o, error: o.error }))
	];
	const previous = new Map(state.map((s) => [`${s.kind}:${s.steamId}`, s.error]));
	const newFailures = failedNow.filter((f) => previous.get(`${f.kind}:${f.steamId}`) !== f.error);
	if (outcome.added.length || outcome.removed.length || newFailures.length || outcome.aborted) {
		const parts: string[] = [];
		if (outcome.added.length) parts.push(`${outcome.added.length} added`);
		if (outcome.removed.length) parts.push(`${outcome.removed.length} removed`);
		if (failedNow.length) parts.push(`${failedNow.length} failed`);
		if (outcome.aborted) parts.push(`stopped: ${outcome.aborted}`);
		await writeAudit(env, null, {
			actorName: 'list sync',
			server: { id: server.id, name: server.name },
			orgId: server.orgId,
			category: 'system',
			action: 'lists.sync',
			target: org.name,
			outcome: failedNow.length || outcome.aborted ? 'error' : 'ok',
			status: failedNow.length || outcome.aborted ? 502 : 200,
			message: parts.join(', '),
			detail: {
				reason: opts.reason,
				added: outcome.added.map(refOf),
				removed: outcome.removed.map(refOf),
				failed: failedNow.map((f) => ({ kind: f.kind, steamId: f.steamId, error: f.error }))
			}
		}).catch((err) => console.error('[warcon] lists.sync audit', err));
	}
	return {
		...base,
		ok: true,
		added: outcome.added.length,
		removed: outcome.removed.length,
		failed: failedNow.length,
		error: outcome.aborted ?? '',
		observed: flat(outcome.observed)
	};
}

const refOf = (r: { kind: Kind; steamId: string }) => `${r.kind}:${r.steamId}`;
const flat = (o: Observed) => ({ bans: o.bans.map((b) => b.steamId), reserved: o.reserved });

interface Failed {
	kind: Kind;
	steamId: string;
	listId?: string;
	error: string;
}

interface Outcome {
	added: SyncPlan['adds'];
	removed: SyncPlan['removes'];
	failedAdds: (Failed & { listId: string })[];
	failedRemoves: Failed[];
	/** the server stopped answering part-way; the rest was not attempted */
	aborted: string | null;
	observed: Observed;
}

const NO_RESERVED_ROUTES =
	'This server build has no reserved-slot routes; add the slot to its config document instead.';

/** Removes, then adds, one call at a time; stops at the first sign the server is gone. */
async function execute(
	client: WardogsClient,
	plan: SyncPlan,
	before: Observed,
	reservedRoutes = true
): Promise<Outcome> {
	const out: Outcome = {
		added: [],
		removed: [],
		failedAdds: [],
		failedRemoves: [],
		aborted: null,
		observed: { bans: [...before.bans], reserved: [...before.reserved] }
	};
	const dropObserved = (kind: Kind, steamId: string) => {
		if (kind === 'ban') out.observed.bans = out.observed.bans.filter((b) => b.steamId !== steamId);
		else out.observed.reserved = out.observed.reserved.filter((id) => id !== steamId);
	};
	const addObserved = (kind: Kind, steamId: string, reason: string) => {
		if (kind === 'ban') {
			if (!out.observed.bans.some((b) => b.steamId === steamId))
				out.observed.bans.push({
					steamId,
					reason,
					bannedBy: 'Warcon',
					bannedAtUtc: new Date().toISOString()
				});
		} else if (!out.observed.reserved.includes(steamId)) out.observed.reserved.push(steamId);
	};
	for (const r of plan.removes) {
		if (r.kind === 'reserve' && !reservedRoutes) {
			out.failedRemoves.push({ ...r, error: `Could not remove: ${NO_RESERVED_ROUTES}` });
			continue;
		}
		try {
			await (r.kind === 'ban' ? ACTIONS.unban : ACTIONS.reservedRemove).run(client, {
				steamId: r.steamId
			});
			out.removed.push(r);
			dropObserved(r.kind, r.steamId);
		} catch (err) {
			const f = failure(err);
			if (isGone(f)) {
				out.removed.push(r);
				dropObserved(r.kind, r.steamId);
			} else if (isUnreachable(f)) {
				out.aborted = f.message;
				return out;
			} else out.failedRemoves.push({ ...r, error: `Could not remove: ${f.message}` });
		}
	}
	for (const a of plan.adds) {
		if (a.kind === 'reserve' && !reservedRoutes) {
			out.failedAdds.push({ ...a, error: `Could not add: ${NO_RESERVED_ROUTES}` });
			continue;
		}
		try {
			await (a.kind === 'ban' ? ACTIONS.ban : ACTIONS.reservedAdd).run(client, {
				steamId: a.steamId,
				reason: a.reason || undefined
			});
			out.added.push(a);
			addObserved(a.kind, a.steamId, a.reason);
		} catch (err) {
			const f = failure(err);
			if (isAlreadyApplied(f)) {
				out.added.push(a);
				addObserved(a.kind, a.steamId, a.reason);
			} else if (isUnreachable(f)) {
				out.aborted = f.message;
				return out;
			} else
				out.failedAdds.push({
					...a,
					error: f.code === 'reserved_full' ? `${RESERVED_FULL}: ${f.message}` : f.message
				});
		}
	}
	return out;
}

interface Bookkeeping {
	syncedAt: Date | null;
	reservedCap: number | null;
	reservedUsed: number;
	capCheckedAt: Date | null;
	lastError: string;
}

async function bookkeep(env: Env, serverId: string, b: Bookkeeping): Promise<void> {
	await env.db
		.insert(serverListSync)
		.values({ serverId, ...b, updatedAt: new Date() })
		.onConflictDoUpdate({ target: serverListSync.serverId, set: { ...b, updatedAt: new Date() } });
}

/** One transaction: state rows for what happened, the snapshot as it now stands, the sync row. */
async function record(
	env: Env,
	serverId: string,
	plan: SyncPlan,
	o: Outcome,
	now: Date,
	b: Bookkeeping
): Promise<void> {
	type Upsert = typeof serverListState.$inferInsert;
	const applied = (r: { kind: Kind; steamId: string; listId: string }): Upsert => ({
		serverId,
		kind: r.kind,
		steamId: r.steamId,
		sourceListId: r.listId,
		state: 'applied',
		error: '',
		attemptedAt: now,
		updatedAt: now
	});
	const failed = (r: { kind: Kind; steamId: string; listId?: string; error: string }): Upsert => ({
		serverId,
		kind: r.kind,
		steamId: r.steamId,
		sourceListId: r.listId ?? null,
		state: 'failed',
		error: r.error.slice(0, 300),
		attemptedAt: now,
		updatedAt: now
	});
	const upserts: Upsert[] = [
		...o.added.map(applied),
		...plan.confirms.map(applied),
		...o.failedAdds.map(failed),
		...plan.overflow.map(failed),
		...o.failedRemoves.map((f) => failed({ ...f }))
	];
	const drops = [...o.removed, ...plan.deletes];
	await env.db.transaction(async (tx) => {
		for (const u of upserts)
			await tx
				.insert(serverListState)
				.values(u)
				.onConflictDoUpdate({
					target: [serverListState.serverId, serverListState.kind, serverListState.steamId],
					set: {
						sourceListId: u.sourceListId,
						state: u.state,
						error: u.error,
						attemptedAt: u.attemptedAt,
						updatedAt: u.updatedAt
					}
				});
		for (const d of drops)
			await tx
				.delete(serverListState)
				.where(
					and(
						eq(serverListState.serverId, serverId),
						eq(serverListState.kind, d.kind),
						eq(serverListState.steamId, d.steamId)
					)
				);
		await tx
			.insert(serverListSync)
			.values({ serverId, ...b, updatedAt: now })
			.onConflictDoUpdate({ target: serverListSync.serverId, set: { ...b, updatedAt: now } });
	});
	await writeSnapshot(env, serverId, o.observed, now);
}

// ---- fan-out from the API ----------------------------------------------------------------------

/**
 * Pushes an org's lists to every one of its servers now. Waits up to FANOUT_WAIT_MS per server so
 * the caller's toast can be specific; anything slower carries on in the background and is
 * reported as still syncing.
 */
export async function fanOut(env: Env, org: OrgRow): Promise<ListSyncSummary> {
	await expireEntries(env).catch((err) => console.error('[warcon] list expiry', err));
	const rows = await env.db
		.select({ server: servers })
		.from(servers)
		.innerJoin(organizations, eq(organizations.id, servers.orgId))
		.where(eq(servers.orgId, org.id));
	const results = await Promise.all(
		rows.map(async ({ server }) => {
			const pending: SyncResult = {
				serverId: server.id,
				serverName: server.name,
				ok: false,
				added: 0,
				removed: 0,
				failed: 0,
				pending: true,
				error: ''
			};
			const work = reconcileServer(env, server, org, {
				reason: 'api',
				waitMs: FANOUT_WAIT_MS,
				lane: 0
			}).catch((err): SyncResult => ({
				...pending,
				pending: false,
				error: publicMessage(err, 'Sync failed.')
			}));
			const timer = new Promise<SyncResult>((r) => setTimeout(() => r(pending), FANOUT_WAIT_MS));
			return Promise.race([work, timer]);
		})
	);
	return {
		servers: results.map(
			({ serverId, serverName, ok, added, removed, failed, pending, error }) => ({
				serverId,
				serverName,
				ok,
				added,
				removed,
				failed,
				pending,
				error
			})
		)
	};
}
