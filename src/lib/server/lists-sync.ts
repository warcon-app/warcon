// The list sync: pushes each org's ban and reserved-slot lists, and each server's own reserved
// slots, to its game servers. The worker runs it on a schedule inside its observations (planning
// against the snapshot it keeps in server_bans and server_reserved, and re-reading the server
// before it changes anything); the API runs it right after an admin edits a list, so the toast
// can say where the change landed.
//
// Rules of the road: the panel adds what the lists want and removes only what it added itself
// (server_list_state). Every game call is idempotent in the panel's reading of it ("already
// banned" is a success, "not banned" on delete is a success), so two replicas working the same
// server at once do no harm; the in-process lock below only keeps the poller and an API call in
// one process from interleaving.
import { and, eq, gt, inArray, isNotNull, isNull, lte, notInArray, or, sql } from 'drizzle-orm';
import type { Env } from './env';
import { banUid, renderBanMessage } from '$lib/ban-message';
import { ApiError, forLog } from './http';
import { writeAudit } from './audit';
import { ACTIONS, configResult, liveReservedIds, readConfig } from './actions';
import { withServer, type Priority } from './dispatcher';
import { classifyGameError, GameError, WardogsClient } from './rcon';
import { RESERVED_KEY, reservedFromText, reservedIntoText } from '$lib/reserved-doc';
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
	desiredOf,
	isAlreadyApplied,
	isGone,
	isUnreachable,
	planHasWork,
	planSync,
	PRIORITY,
	type Kind,
	type PlanAdd,
	type PlanInput,
	type PanelBan,
	type SyncPlan
} from './lists-plan';
import type { DbOrTx } from './db';
import { storableText } from './db/storable';
import type { Ban, Features, ListSyncServer, ListSyncSummary } from '$lib/types';

/** A failed add or remove is not retried for this long. */
const RETRY_AFTER_MS = 5 * 60_000;
/** How long an API-triggered fan-out waits for each server before reporting it as still syncing. */
const FANOUT_WAIT_MS = 15_000;

export interface Observed {
	bans: Ban[];
	/** the running server's reserved list: whom it holds a slot for now */
	reserved: string[];
	/**
	 * The list in the config document, which the server takes up when it next starts (the running
	 * list, on a build that has no document or edits both at once). The sync plans against this.
	 */
	configured: string[];
}

export interface SyncResult extends ListSyncServer {
	/** why nothing ran, when nothing ran */
	skipped?: 'busy' | 'suspended';
	/** the server's lists after the run; the poller keeps its in-memory copy from this */
	observed?: { bans: string[]; reserved: string[]; configured: string[] };
	/** the bans the lists put on this server; the worker removes these players on sight */
	bans?: PanelBan[];
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

/**
 * isListOn (lists-plan.ts) as a condition on `lists`, with `now` the caller's clock (the worker's,
 * as for an entry's expiry: the database is on another box).
 */
export const listOnAt = (now: Date) =>
	and(
		isNull(lists.archivedAt),
		or(isNull(lists.onFrom), lte(lists.onFrom, now)),
		or(isNull(lists.onUntil), gt(lists.onUntil, now))
	);

/**
 * What the lists this server subscribes to want on it right now: the default lists, its own, and
 * the groups given to it that are on at `now`. A group's window needs nothing written when it
 * opens or closes: the per-minute sync reads it here.
 */
export async function desiredFor(
	env: Env,
	server: Pick<ServerRow, 'id' | 'orgId'>,
	org: Pick<OrgRow, 'membersReserved' | 'banMessage'>,
	now = new Date()
): Promise<PlanInput['desired']> {
	const rows = await env.db
		.select({
			e: listEntries,
			kind: lists.kind,
			listServerId: lists.serverId,
			isDefault: lists.isDefault,
			listName: lists.name
		})
		.from(serverLists)
		.innerJoin(lists, eq(lists.id, serverLists.listId))
		.innerJoin(listEntries, eq(listEntries.listId, lists.id))
		.where(and(eq(serverLists.serverId, server.id), isNull(listEntries.removedAt), listOnAt(now)));
	const active = activeEntries(
		rows.map((r) => ({
			...r.e,
			kind: r.kind,
			serverId: r.listServerId,
			isDefault: r.isDefault,
			listName: r.listName
		})),
		now
	);
	const { bans, reserved } = desiredOf(active);
	if (org.membersReserved) {
		// Members who set a SteamID get a slot from the org's default reserve list, unless the org
		// has banned them.
		const [reserveList] = await env.db
			.select({ id: lists.id })
			.from(serverLists)
			.innerJoin(lists, eq(lists.id, serverLists.listId))
			.where(
				and(
					eq(serverLists.serverId, server.id),
					eq(lists.kind, 'reserve'),
					eq(lists.isDefault, true)
				)
			)
			.limit(1);
		if (reserveList) {
			const banned = new Set(bans.map((b) => b.steamId));
			const have = new Set(reserved.map((r) => r.steamId));
			for (const m of await memberSlots(env, server.orgId))
				if (!banned.has(m.steamId) && !have.has(m.steamId))
					reserved.push({
						steamId: m.steamId,
						listId: reserveList.id,
						member: true,
						priority: PRIORITY.member
					});
		}
	}
	return { bans, reserved };
}

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
 * Lifts bans and reserved slots whose expiry has passed: the row is marked removed (so history
 * keeps it) and the next reconcile takes it off every server the panel applied it to. The poller runs this every
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
		.select({ listId: lists.id, kind: lists.kind, orgId: lists.orgId, orgName: organizations.name })
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
			message: `${ids.length} ${o.kind === 'ban' ? 'ban' : 'reserved slot'}${ids.length === 1 ? '' : 's'} expired in ${o.orgName}`,
			detail: { orgId: o.orgId, org: o.orgName, steamIds: ids }
		}).catch((err) => console.error('[warcon] list.expire audit', forLog(err)));
	}
	return { lifted: rows.length, orgIds: [...new Set(owners.map((o) => o.orgId))] };
}

async function snapshotObserved(env: Env, serverId: string): Promise<Observed> {
	const [bans, reserved] = await Promise.all([
		env.db.select().from(serverBans).where(eq(serverBans.serverId, serverId)),
		env.db
			.select({
				steamId: serverReserved.steamId,
				configured: serverReserved.configured,
				live: serverReserved.live
			})
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
		reserved: reserved.filter((r) => r.live).map((r) => r.steamId),
		configured: reserved.filter((r) => r.configured).map((r) => r.steamId)
	};
}

const isSteamId = (id: string) => /^\d{17}$/.test(id);

/**
 * Reads the server's ban list and reserved slots, one request at a time (one in flight per
 * server). On a build that takes reserved slots through its config document, the document is read
 * too: the running list only catches up with it at the next restart, so a slot withdrawn and given
 * back before then would read as already there. Only the reserved ids leave the document; its text
 * (which carries the RCON password) is never kept.
 */
export async function liveObserved(
	client: WardogsClient,
	features: Features | null = null
): Promise<Observed> {
	const bans = (await ACTIONS.bans.run(client, {})) as { bans: Ban[] };
	const reserved = (
		(await ACTIONS.reserved.run(client, {})) as { reserved: string[] }
	).reserved.filter(isSteamId);
	let configured = reserved;
	if (!features?.reservedSlots) {
		try {
			configured = reservedFromText((await readConfig(client)).text).filter(isSteamId);
		} catch (err) {
			// a build too old to serve the document keeps its list in the running server alone
			if (!(err instanceof GameError && err.code === 'no_route')) throw err;
		}
	}
	return { bans: bans.bans.filter((b) => isSteamId(b.steamId)), reserved, configured };
}

/** Rewrites the poller's copies of a server's ban list and reserved slots. */
export async function writeSnapshot(
	env: Env,
	serverId: string,
	observed: Observed,
	ts = new Date()
): Promise<void> {
	await env.db.transaction(async (tx) => {
		// one row per player: a ban list naming one twice would fail the upsert, and with it every sync
		const bans = [...new Map(observed.bans.map((b) => [b.steamId, b])).values()];
		const banIds = bans.map((b) => b.steamId);
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
					// the game's text can hold what Postgres refuses: a NUL in a reason someone sent it
					bans.map((b) => ({
						serverId,
						steamId: b.steamId,
						reason: storableText(b.reason || ''),
						bannedBy: storableText(b.bannedBy || ''),
						bannedAtUtc: storableText(b.bannedAtUtc || ''),
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
		const live = new Set(observed.reserved);
		const configured = new Set(observed.configured);
		const ids = [...new Set([...live, ...configured])];
		await tx
			.delete(serverReserved)
			.where(
				ids.length
					? and(eq(serverReserved.serverId, serverId), notInArray(serverReserved.steamId, ids))
					: eq(serverReserved.serverId, serverId)
			);
		if (ids.length)
			await tx
				.insert(serverReserved)
				.values(
					ids.map((steamId) => ({
						serverId,
						steamId,
						configured: configured.has(steamId),
						live: live.has(steamId),
						seenAt: ts
					}))
				)
				.onConflictDoUpdate({
					target: [serverReserved.serverId, serverReserved.steamId],
					set: { configured: sql`excluded.configured`, live: sql`excluded.live`, seenAt: ts }
				});
	});
}

/**
 * A ban or reserved slot someone just added or removed by hand through the rcon actions: the
 * copies in server_bans and server_reserved are brought in line at once, rather than at the
 * worker's next re-read (five minutes by default), so no page keeps showing a slot the server no
 * longer has, or misses one it just got. The worker's own re-read still follows and is the
 * authority; this only closes the gap. A slot written to the config document of a build that reads
 * it at start (`pendingRestart`) is in the document now and in the running list at the restart,
 * or the other way about for one taken out.
 */
export async function noteLocalEdit(
	env: Env,
	serverId: string,
	kind: Kind,
	op: 'add' | 'remove',
	steamId: string,
	opts: { reason?: string; pendingRestart?: boolean; ts?: Date } = {}
): Promise<void> {
	const { pendingRestart = false, ts = new Date() } = opts;
	const reason = storableText(opts.reason ?? '');
	if (kind === 'ban') {
		if (op === 'remove') {
			await env.db
				.delete(serverBans)
				.where(and(eq(serverBans.serverId, serverId), eq(serverBans.steamId, steamId)));
			return;
		}
		await env.db
			.insert(serverBans)
			.values({ serverId, steamId, reason, seenAt: ts })
			.onConflictDoUpdate({
				target: [serverBans.serverId, serverBans.steamId],
				set: { reason, seenAt: ts }
			});
		return;
	}
	const configured = op === 'add';
	const live = op === 'add' ? !pendingRestart : pendingRestart;
	if (!configured && !live) {
		await env.db
			.delete(serverReserved)
			.where(and(eq(serverReserved.serverId, serverId), eq(serverReserved.steamId, steamId)));
		return;
	}
	await env.db
		.insert(serverReserved)
		.values({ serverId, steamId, configured, live, seenAt: ts })
		.onConflictDoUpdate({
			target: [serverReserved.serverId, serverReserved.steamId],
			set: { configured, live, seenAt: ts }
		});
}

// ---- the run -----------------------------------------------------------------------------------

export interface ReconcileOptions {
	/** the worker's cached feature flags, so the run need not ask the build again; null = unknown */
	features?: Features | null;
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

/**
 * What the sync stores, records and answers for a failure: a fixed phrase chosen by its status and
 * code. The game's own words, and the panel's (a refused address names the host and what it
 * resolved to), go to the log only.
 */
export function syncPhrase(err: unknown): string {
	if (!(err instanceof ApiError)) {
		console.warn('[warcon] list sync:', forLog(err));
		return 'The sync failed.';
	}
	const code = err.code ?? '';
	if (code === 'unreachable') return 'Could not reach the server.';
	if (code === 'rate_limited') return 'The server asked the panel to slow down.';
	if (code === 'blocked_host' || code === 'unresolvable')
		return "The panel no longer accepts the server's address.";
	if (code === 'no_route' || err.status === 405) return 'This server build does not serve it.';
	if (code === 'config_readonly') return "The server's config document is read-only.";
	if (code === 'revision_conflict')
		return 'The config document kept changing during the write; it is tried again.';
	if (code === 'bad_response') return 'The server did not answer as expected.';
	if (err.status === 401 || err.status === 403) return 'The server refused the RCON password.';
	if (err.status >= 500) return 'The server failed to answer.';
	return `Refused by the server (${err.status}${/^[a-z_]{1,40}$/.test(code) ? `, ${code}` : ''}).`;
}

const failure = (err: unknown) => {
	const g = err instanceof GameError ? err : null;
	return {
		status: g?.status ?? 500,
		code: g?.code,
		// read by the checks for "already there" and "already gone" only, never stored
		message: g?.message ?? '',
		phrase: syncPhrase(err)
	};
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
	const panelBans = desired.bans.map(({ steamId, listId }) => ({ steamId, listId }));
	const state = await env.db
		.select()
		.from(serverListState)
		.where(eq(serverListState.serverId, server.id));
	const [syncRow] = await env.db
		.select()
		.from(serverListSync)
		.where(eq(serverListSync.serverId, server.id))
		.limit(1);

	const planWith = (observed: Observed) =>
		planSync({
			now,
			retryAfterMs: RETRY_AFTER_MS,
			desired,
			observed: { reserved: observed.configured },
			state
		});

	// Plan against what we last saw; before touching the server, look again.
	let observed = opts.observed ?? (await snapshotObserved(env, server.id));
	let fresh = !!opts.observed;
	let plan = planWith(observed);
	let client = opts.client;
	let reserve: ReserveMode = { writable: true, viaConfig: false };
	if (!planHasWork(plan) && plan.confirms.length === 0 && plan.deletes.length === 0) {
		await bookkeep(env, server.id, { syncedAt: now, lastError: '' });
		return {
			...base,
			ok: true,
			observed: flat(observed),
			bans: panelBans
		};
	}
	try {
		client ??= await WardogsClient.forServer(env, server);
		if (!fresh) {
			observed = await liveObserved(client, opts.features ?? null);
			fresh = true;
			await writeSnapshot(env, server.id, observed, now);
		}
		plan = planWith(observed);
		// Live builds since CL-499480 have no reserved-slot routes and answer those calls 404, which
		// would otherwise read as "already gone"; there the slots go through the config document.
		// Ask the build once before touching reserved slots.
		if (planHasWork(plan)) {
			try {
				const features =
					opts.features ??
					((await ACTIONS.capabilities.run(client, {})) as { features: Features }).features;
				reserve = {
					writable: features.reservedSlots || features.configDocument,
					viaConfig: !features.reservedSlots
				};
			} catch {
				/* a build too old to report capabilities still has the routes */
			}
		}
	} catch (err) {
		const message = syncPhrase(err);
		await bookkeep(env, server.id, { syncedAt: syncRow?.syncedAt ?? null, lastError: message });
		return { ...base, error: message };
	}

	await claim(env, server.id, plan.adds, now);
	const outcome = await execute(client, plan, observed, reserve);
	await record(env, server.id, plan, outcome, now, {
		syncedAt: now,
		lastError: outcome.aborted ?? ''
	});

	const failedNow = [...outcome.failedAdds, ...outcome.failedRemoves];
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
		}).catch((err) => console.error('[warcon] lists.sync audit', forLog(err)));
	}
	return {
		...base,
		ok: true,
		added: outcome.added.length,
		removed: outcome.removed.length,
		failed: failedNow.length,
		error: outcome.aborted ?? '',
		observed: flat(outcome.observed),
		bans: panelBans
	};
}

const refOf = (r: { kind: Kind; steamId: string }) => `${r.kind}:${r.steamId}`;
const flat = (o: Observed) => ({
	bans: o.bans.map((b) => b.steamId),
	reserved: o.reserved,
	configured: o.configured
});

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
	'This server build has no reserved-slot routes and its config document is not writable, so the panel cannot place reserved slots on it.';

/** How reserved slots reach this server: live routes, the config document, or not at all. */
interface ReserveMode {
	writable: boolean;
	/** no live routes: tell the actions to go straight to the document */
	viaConfig: boolean;
}

/** Every reserved-slot change the plan holds, the way this build takes them. */
async function execute(
	client: WardogsClient,
	plan: SyncPlan,
	before: Observed,
	reserve: ReserveMode = { writable: true, viaConfig: false }
): Promise<Outcome> {
	const out: Outcome = {
		added: [],
		removed: [],
		failedAdds: [],
		failedRemoves: [],
		aborted: null,
		observed: {
			bans: before.bans,
			reserved: [...before.reserved],
			configured: [...before.configured]
		}
	};
	if (!planHasWork(plan)) return out;
	if (!reserve.writable) {
		for (const r of plan.removes)
			out.failedRemoves.push({ ...r, error: `Could not remove: ${NO_RESERVED_ROUTES}` });
		for (const a of plan.adds)
			out.failedAdds.push({ ...a, error: `Could not add: ${NO_RESERVED_ROUTES}` });
		return out;
	}
	return reserve.viaConfig ? throughDocument(client, plan, out) : oneByOne(client, plan, out);
}

/**
 * On a build with the live routes: removes, then adds, one call at a time, each changing the
 * running list and the document together; stops at the first sign the server is gone.
 */
async function oneByOne(client: WardogsClient, plan: SyncPlan, out: Outcome): Promise<Outcome> {
	const lists = () => [out.observed.reserved, out.observed.configured];
	const drop = (steamId: string) => {
		out.observed.reserved = out.observed.reserved.filter((id) => id !== steamId);
		out.observed.configured = out.observed.configured.filter((id) => id !== steamId);
	};
	const put = (steamId: string) => {
		for (const l of lists()) if (!l.includes(steamId)) l.push(steamId);
	};
	for (const r of plan.removes) {
		try {
			await ACTIONS.reservedRemove.run(client, { steamId: r.steamId, viaConfig: false });
			out.removed.push(r);
			drop(r.steamId);
		} catch (err) {
			const f = failure(err);
			if (isGone(f)) {
				out.removed.push(r);
				drop(r.steamId);
			} else if (isUnreachable(f)) {
				out.aborted = f.phrase;
				return out;
			} else out.failedRemoves.push({ ...r, error: `Could not remove: ${f.phrase}` });
		}
	}
	for (const a of plan.adds) {
		try {
			await ACTIONS.reservedAdd.run(client, { steamId: a.steamId, viaConfig: false });
			out.added.push(a);
			put(a.steamId);
		} catch (err) {
			const f = failure(err);
			if (isAlreadyApplied(f)) {
				out.added.push(a);
				put(a.steamId);
			} else if (isUnreachable(f)) {
				out.aborted = f.phrase;
				return out;
			} else out.failedAdds.push({ ...a, error: `Could not add: ${f.phrase}` });
		}
	}
	return out;
}

/**
 * The listener refuses a request body over 64 KB (`limits.maxBodyBytes` on every build seen), and
 * the whole document goes in one; this much of it is left for the reserved list to grow into.
 */
const DOCUMENT_BUDGET_BYTES = 65_536 - 2048;
const DOCUMENT_FULL = "The server's config document is full.";

const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * The adds that fit, in the order given: the document with `kept` must stay within the budget.
 * Each add is one more `.DefaultReservedPlayerIds=<id>` line.
 */
export function fitting(text: string, kept: string[], adds: string[]): string[] {
	const eol = text.includes('\r\n') ? 2 : 1;
	let size = bytes(reservedIntoText(text, kept));
	const placed: string[] = [];
	for (const id of adds) {
		const cost = bytes(`.${RESERVED_KEY}=${id}`) + eol;
		if (size + cost > DOCUMENT_BUDGET_BYTES) break;
		size += cost;
		placed.push(id);
	}
	return placed;
}

/**
 * On a build that takes reserved slots through its config document: every change for the server in
 * one write. One read, one PUT against the revision read, one look at the running list. On a
 * revision conflict the document is read again and the same changes made to what it now holds (an
 * add already there and a removal already gone change nothing), so the other writer's edit stays; a
 * second conflict fails the run's changes. Removals always go in; adds go in by priority while the
 * document stays within the budget, and the rest wait as failed until there is room. The document's
 * text never leaves this function and no error of the game's is kept (see syncPhrase).
 */
async function throughDocument(
	client: WardogsClient,
	plan: SyncPlan,
	out: Outcome
): Promise<Outcome> {
	const adds = [...plan.adds].sort((a, b) => a.priority - b.priority);
	const removing = new Set(plan.removes.map((r) => r.steamId));
	try {
		for (let attempt = 0; ; attempt++) {
			const doc = await readConfig(client);
			if (!doc.writable) throw new GameError(400, 'The document is read-only.', 'config_readonly');
			const before = reservedFromText(doc.text);
			const kept = before.filter((id) => !removing.has(id));
			const fresh = adds.map((a) => a.steamId).filter((id) => !kept.includes(id));
			const ids = [...kept, ...fitting(doc.text, kept, fresh)];
			const changed = ids.length !== before.length || ids.some((id, i) => id !== before[i]);
			if (changed) {
				const { status, body, etag } = await client.configCall(
					'PUT',
					'/v1/config',
					reservedIntoText(doc.text, ids),
					doc.revision
				);
				const r = configResult(status, body, etag);
				if (r.conflict) {
					if (attempt === 0) continue;
					throw new GameError(412, 'The document kept changing.', 'revision_conflict');
				}
				if (!r.ok) throw classifyGameError('PUT', '/v1/config', status, '', body);
			}
			const placed = new Set(ids);
			out.removed.push(...plan.removes);
			for (const a of adds)
				if (placed.has(a.steamId)) out.added.push(a);
				else out.failedAdds.push({ ...a, error: `Could not add: ${DOCUMENT_FULL}` });
			out.observed.configured = ids.filter(isSteamId);
			if (changed) {
				const live = await liveReservedIds(client).catch(() => null);
				if (live) out.observed.reserved = live.filter(isSteamId);
			}
			return out;
		}
	} catch (err) {
		const f = failure(err);
		if (isUnreachable(f)) {
			out.aborted = f.phrase;
			return out;
		}
		for (const r of plan.removes)
			out.failedRemoves.push({ ...r, error: `Could not remove: ${f.phrase}` });
		for (const a of adds) out.failedAdds.push({ ...a, error: `Could not add: ${f.phrase}` });
		return out;
	}
}

interface Bookkeeping {
	syncedAt: Date | null;
	lastError: string;
}

async function bookkeep(env: Env, serverId: string, b: Bookkeeping): Promise<void> {
	await env.db
		.insert(serverListSync)
		.values({ serverId, ...b, updatedAt: new Date() })
		.onConflictDoUpdate({ target: serverListSync.serverId, set: { ...b, updatedAt: new Date() } });
}

/**
 * Ownership before the write: each add is recorded as the panel's before the server is touched, so
 * a crash between the write and the record cannot leave an id the panel placed looking like
 * someone else's (local, which the panel never removes). Until the server holds it, such a row
 * reads as pending and the next run adds it again; a removal's row goes only after the write.
 */
async function claim(env: Env, serverId: string, adds: PlanAdd[], now: Date): Promise<void> {
	if (!adds.length) return;
	await env.db.transaction(async (tx) => {
		for (const a of adds)
			await upsertState(tx, {
				serverId,
				kind: a.kind,
				steamId: a.steamId,
				sourceListId: a.listId,
				state: 'applied',
				error: '',
				attemptedAt: now,
				updatedAt: now
			});
	});
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
	const applied = (r: { kind: Kind; steamId: string; listId: string }): StateUpsert => ({
		serverId,
		kind: r.kind,
		steamId: r.steamId,
		sourceListId: r.listId,
		state: 'applied',
		error: '',
		attemptedAt: now,
		updatedAt: now
	});
	const failed = (r: {
		kind: Kind;
		steamId: string;
		listId?: string;
		error: string;
	}): StateUpsert => ({
		serverId,
		kind: r.kind,
		steamId: r.steamId,
		sourceListId: r.listId ?? null,
		state: 'failed',
		error: r.error.slice(0, 300),
		attemptedAt: now,
		updatedAt: now
	});
	const upserts: StateUpsert[] = [
		...o.added.map(applied),
		...plan.confirms.map(applied),
		...o.failedAdds.map(failed),
		...o.failedRemoves.map((f) => failed({ ...f }))
	];
	const drops = [...o.removed, ...plan.deletes];
	await env.db.transaction(async (tx) => {
		for (const u of upserts) await upsertState(tx, u);
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

type StateUpsert = typeof serverListState.$inferInsert;

async function upsertState(db: DbOrTx, u: StateUpsert): Promise<void> {
	await db
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
}

// ---- bans, enforced by the panel -----------------------------------------------------------------

/** How long a kick the game refused waits before it is tried again on the same player. */
const KICK_RETRY_MS = 30_000;

/**
 * A server's bans are the panel's alone: nothing is written to the game's ban list (some hosts
 * keep that list in a file an unban never leaves). The worker holds the bans its lists put on the
 * server (`bans`, from the last sync) and this removes any of those players found on it: one kick,
 * with the org's ban message as it reads now, on the connection the observation already holds.
 * Nothing at all happens on a server whose players are not banned.
 *
 * The worker's copy is as old as the last sync, so the entry is read again before the kick: one
 * taken off its list or run out since then removes nobody. That is one query, and only when such
 * a player is actually on the server.
 */
export async function kickBanned(
	env: Env,
	server: ServerRow,
	org: OrgRow,
	client: WardogsClient,
	present: string[],
	bans: Map<string, PanelBan>
): Promise<void> {
	for (const steamId of present) {
		const b = bans.get(steamId);
		if (!b) continue;
		const now = new Date();
		if (b.retryAt && b.retryAt > now.getTime()) continue;
		const entry = await liveEntry(env, server.id, b, now);
		if (!entry) {
			bans.delete(steamId);
			continue;
		}
		let error = '';
		try {
			await ACTIONS.kick.run(client, {
				steamId,
				reason: renderBanMessage(org.banMessage, { ...entry, entryId: entry.id })
			});
		} catch (err) {
			const f = failure(err);
			// gone between the look and the kick: that is what was wanted
			if (isGone(f)) continue;
			if (isUnreachable(f)) return;
			b.retryAt = now.getTime() + KICK_RETRY_MS;
			error = f.phrase;
		}
		await writeAudit(env, null, {
			actorName: 'ban list',
			server: { id: server.id, name: server.name },
			orgId: server.orgId,
			category: 'system',
			action: 'ban.enforce',
			target: steamId,
			outcome: error ? 'error' : 'ok',
			status: error ? 502 : 200,
			message: error ? `Could not remove a banned player: ${error}` : 'Banned player removed',
			detail: { banId: banUid(entry.id) }
		}).catch((err) => console.error('[warcon] ban.enforce audit', forLog(err)));
	}
}

/** The entry behind a ban, if it is still live on a list the server subscribes to. */
async function liveEntry(env: Env, serverId: string, b: PanelBan, now: Date) {
	const [row] = await env.db
		.select({ entry: listEntries })
		.from(serverLists)
		.innerJoin(listEntries, eq(listEntries.listId, serverLists.listId))
		.where(
			and(
				eq(serverLists.serverId, serverId),
				eq(serverLists.listId, b.listId),
				eq(listEntries.steamId, b.steamId),
				isNull(listEntries.removedAt),
				or(isNull(listEntries.expiresAt), gt(listEntries.expiresAt, now))
			)
		)
		.limit(1);
	return row?.entry ?? null;
}

// ---- fan-out from the API ----------------------------------------------------------------------

/**
 * Pushes an org's lists to every one of its servers now. Waits up to FANOUT_WAIT_MS per server so
 * the caller's toast can be specific; anything slower carries on in the background and is
 * reported as still syncing.
 */
export async function fanOut(env: Env, org: OrgRow): Promise<ListSyncSummary> {
	await expireEntries(env).catch((err) => console.error('[warcon] list expiry', forLog(err)));
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
				error: syncPhrase(err)
			}));
			const timer = new Promise<SyncResult>((r) => setTimeout(() => r(pending), FANOUT_WAIT_MS));
			return Promise.race([work, timer]);
		})
	);
	return { servers: results.map(summaryOf) };
}

/**
 * What an API answer says of a sync: where it landed, in counts. The rest of a SyncResult is the
 * worker's own (the server's lists, and the bans the worker enforces) and never leaves.
 */
export function summaryOf(r: SyncResult): ListSyncServer {
	const { serverId, serverName, ok, added, removed, failed, pending, error } = r;
	return { serverId, serverName, ok, added, removed, failed, pending, error };
}
