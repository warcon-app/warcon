// Trigger delivery. Intents are written to the outbox inside the observation's transaction;
// this loop claims them (FOR UPDATE SKIP LOCKED, with a lease), a few of each server's at a time,
// sends each server's rows in a chain of their own through that server's lane behind any human
// command, and records exactly what happened: delivered, failed (the game said no), skipped (the
// player had already left, or the intent went stale), or unknown (sent, no answer). Unknown is
// never retried on its own: a second whisper is harmless, a second kick is not, and the audit row
// says what is known. A server that refuses the panel for sending too fast gets no more trigger
// actions until the time it gave has passed (observations and people's commands are not held;
// the hold is this worker's, and a worker that takes over starts without it).
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Env } from './env';
import type { DbOrTx } from './db';
import { outbox, triggers, type OutboxRow } from './db/schema';
import { ACTIONS } from './actions';
import { GameError, WardogsClient } from './rcon';
import { ApiError, forLog, str } from './http';
import { LaneFull, LaneTimeout, PRIORITY, withServer } from './dispatcher';
import { emit } from './events';
import { isOwner, LostOwnership, ownedSince, withOwnedTransaction } from './leadership';
import { settings } from './settings';
import {
	recordDelivery,
	SETTINGS_KEYS,
	twoTeamsMoveVerdict,
	type Intent,
	type TriggerUpdate
} from './triggers';
import { allMemory, memoryOf } from './observe';
import { grantEntry, listOf, serverListOf } from './lists';
import { getOrg, getServer } from './access';
import { gateway } from './gateway';
import { deliveries } from './metrics';
import { NAME_FLAG } from './name-filter';
import { KILL_RATE_FLAG } from './kill-rate';
import { KILL_DISTANCE_FLAG } from './kill-distance';
import { writeAudit } from './audit';
import { PANEL_BAN, type PanelBanParams } from './rule-ban';
import { killAndTell, RULE_KILL, RULE_KILL_MAX_AGE_MS } from './rule-kill';
import { queueEvent } from './json-webhook-queue';
import { seedRewardGranted } from './json-webhook-events';
import {
	AFK_ROUND,
	AFK_ROUND_MAX_AGE_MS,
	AFK_ROUND_MAX_MS,
	AFK_ROUND_MAX_PLAYERS
} from './afk-protection';
import { MAX_CHAT } from '$lib/chat';
import type { OutboxView } from '$lib/types';

/** Actions delivered without a game request: they need no roster, only the server's row. */
const PANEL_ACTIONS = new Set([
	'seed_reward',
	PANEL_BAN,
	NAME_FLAG,
	KILL_RATE_FLAG,
	KILL_DISTANCE_FLAG
]);

/** The most rows one claim takes, oldest first. */
const CLAIM_LIMIT = 50;
/** The most rows one claim takes of one server, so a burst on one server never fills a claim. */
const PER_SERVER = 5;
const PASS_MS = 1000;

/**
 * Writes intents; a dedupe key seen before is dropped silently. Returns how many were new. A watch
 * only row is written as skipped: its id goes into `watched`, for the caller to announce once the
 * write is committed.
 */
export async function enqueueIntents(
	db: DbOrTx,
	serverId: string,
	intents: Intent[],
	watched?: number[]
): Promise<number> {
	if (!intents.length) return 0;
	const rows = await db
		.insert(outbox)
		.values(
			intents.map((i) => ({
				serverId,
				triggerId: i.trigger.id,
				triggerName: i.trigger.name,
				triggerKind: i.trigger.kind,
				action: i.action,
				params: i.params,
				target: i.target.slice(0, 300),
				detail: i.detail,
				steamId: i.steamId,
				okMessage: i.okMessage,
				dedupeKey: i.dedupeKey,
				...(i.watchOnly
					? { state: 'skipped', outcome: i.watchOnly.slice(0, 300), doneAt: new Date() }
					: {})
			}))
		)
		.onConflictDoNothing({ target: outbox.dedupeKey })
		.returning({ id: outbox.id, state: outbox.state });
	if (watched) for (const r of rows) if (r.state === 'skipped') watched.push(r.id);
	return rows.length;
}

export async function applyTriggerUpdates(db: DbOrTx, updates: TriggerUpdate[]): Promise<void> {
	for (const u of updates)
		await db
			.update(triggers)
			.set({
				lastFiredAt: u.lastFiredAt,
				lastResult: u.lastResult?.slice(0, 300),
				state: u.state === undefined ? undefined : u.state
			})
			.where(eq(triggers.id, u.id));
}

// ---- the loop -----------------------------------------------------------------------------------

declare global {
	// All three survive Vite HMR re-evaluation in dev so an old delivery loop never keeps running:
	// the timer; the generation of the loop that may claim (a replaced module's chains still wake
	// their own pass when they end); and the loop's state, which the new module must share.
	var __warconDelivery: ReturnType<typeof setInterval> | undefined;
	var __warconDeliveryGen: number | undefined;
	var __warconDeliveryChains:
		| { claiming: boolean; busy: Set<string>; mine: Set<number>; held?: Map<string, number> }
		| undefined;
}
let wanted = false;
/** Settles when this module's claim in progress, if any, has finished (see stopDelivery). */
let claimDone: Promise<void> = Promise.resolve();
let envRef: Env | null = null;
let generation = 0;
const stats = { delivered: 0, failed: 0, skipped: 0, unknown: 0, lastPassAt: 0, inFlight: 0 };
globalThis.__warconDeliveryChains ??= { claiming: false, busy: new Set(), mine: new Set() };
/** One claim at a time, whichever module's loop makes it. */
const loop = globalThis.__warconDeliveryChains;
/** Servers whose chain is still running here: a claim passes over them until it ends. */
const busy = loop.busy;
/** Rows claimed here and not yet done: the lease sweep leaves them to their chain. */
const mine = loop.mine;
/** Servers that refused the panel for sending too fast, and until when: not claimed until then. */
const held = (loop.held ??= new Map());

export function startDelivery(env: Env): void {
	envRef = env;
	generation = globalThis.__warconDeliveryGen = (globalThis.__warconDeliveryGen ?? 0) + 1;
	if (globalThis.__warconDelivery) clearInterval(globalThis.__warconDelivery);
	globalThis.__warconDelivery = setInterval(() => void pass(), PASS_MS);
}

/**
 * No pass starts after this. The promise settles once a pass that was claiming has put its rows
 * back, so a caller about to give the lease up awaits it first (the put-back needs the lease). A
 * chain already running goes on while the lease lasts; rows it has not reached when the lease ends
 * stay claimed, and the next worker counts them unknown.
 */
export function stopDelivery(): Promise<void> {
	envRef = null;
	globalThis.__warconDeliveryGen = (globalThis.__warconDeliveryGen ?? 0) + 1;
	if (globalThis.__warconDelivery) clearInterval(globalThis.__warconDelivery);
	globalThis.__warconDelivery = undefined;
	return claimDone;
}

/** Runs a pass now (after intents were written) instead of waiting for the next tick. */
export function wakeDelivery(): void {
	wanted = true;
	void pass();
}

/** `chains` and `claimed` show a server whose chain never ends (its rows would sit pending). */
export const deliveryStats = () => ({
	...stats,
	chains: busy.size,
	claimed: mine.size,
	held: held.size
});

/** A list as one JSON parameter: one statement text whatever its length (see pass). */
const jsonList = (values: Iterable<string | number>) => JSON.stringify([...values]);

/** The servers a claim passes over now: a chain of theirs is running, or they are held. */
function passedOver(now: number): string[] {
	for (const [id, until] of held) if (until <= now) held.delete(id);
	return [...busy, ...held.keys()];
}

async function pass(): Promise<void> {
	const env = envRef;
	const mineGen = generation;
	if (!env || loop.claiming || !isOwner() || mineGen !== globalThis.__warconDeliveryGen) return;
	loop.claiming = true;
	let claimFinished!: () => void;
	claimDone = new Promise<void>((resolve) => (claimFinished = resolve));
	wanted = false;
	try {
		stats.lastPassAt = Date.now();
		const lease = settings().outboxLeaseMs;
		const claimed = await withOwnedTransaction(env, async (tx) => {
			// A send whose lease lapsed may have reached the game: it is unknown, never sent again.
			// A row still waiting in a chain here has not lapsed, however long its chain has taken.
			await tx.execute(sql`
			UPDATE outbox SET state = 'unknown', outcome = 'The worker stopped while sending; the game may have acted.', done_at = now(), lease_until = NULL
			 WHERE state = 'sending' AND lease_until < now()
			   AND id NOT IN (SELECT v::bigint FROM jsonb_array_elements_text(${jsonList(mine)}::text::jsonb) AS v
			                   WHERE v IS NOT NULL)`);
			// Claiming moves the row to "sending" durably before anything is sent: the oldest due
			// rows, at most PER_SERVER of any one server, none of a server whose chain is running or that
			// is held.
			return (await tx.execute(sql`
			UPDATE outbox SET state = 'sending', lease_until = now() + (${lease} || ' milliseconds')::interval, attempts = attempts + 1
			 WHERE id IN (SELECT id FROM outbox
			               WHERE state = 'pending'
			                 AND id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY server_id ORDER BY id) AS n
			                                              FROM outbox
			                                             WHERE state = 'pending' AND not_before <= now()
			                                               AND server_id NOT IN (SELECT v FROM jsonb_array_elements_text(${jsonList(passedOver(Date.now()))}::text::jsonb) AS v
			                                                                      WHERE v IS NOT NULL)) due
			                             WHERE n <= ${PER_SERVER} ORDER BY id LIMIT ${CLAIM_LIMIT})
			               FOR UPDATE SKIP LOCKED)
			 RETURNING id, server_id AS "serverId", trigger_id AS "triggerId", trigger_name AS "triggerName",
			           trigger_kind AS "triggerKind", action, params, target, detail, steam_id AS "steamId",
			           ok_message AS "okMessage", dedupe_key AS "dedupeKey", state, attempts, not_before AS "notBefore",
			           lease_until AS "leaseUntil", outcome, created_at AS "createdAt", done_at AS "doneAt"`)) as unknown as OutboxRow[];
		});
		// Stopped, or replaced by a new module, while this pass was claiming: nobody is left to
		// deliver these, so they go back unsent rather than wait for the sweep to call them unknown.
		if (mineGen !== globalThis.__warconDeliveryGen) return await putBack(env, claimed);
		// One chain per server, oldest first (its lane serialises them anyway), and the pass does not
		// wait for them: a server whose game is slow, or whose rule queued a hundred moves at once,
		// holds up its own rows and nobody else's. A server is claimed again once its chain ends.
		const byServer = new Map<string, OutboxRow[]>();
		// RETURNING keeps no order: oldest first is put back here.
		for (const r of claimed.sort((a, b) => a.id - b.id))
			(byServer.get(r.serverId) ?? byServer.set(r.serverId, []).get(r.serverId)!).push(r);
		for (const [serverId, rows] of byServer) {
			busy.add(serverId);
			for (const r of rows) mine.add(r.id);
			void deliverChain(env, rows).finally(() => {
				busy.delete(serverId);
				for (const r of rows) mine.delete(r.id);
				wakeDelivery();
			});
		}
	} catch (err) {
		if (!(err instanceof LostOwnership)) console.error('[warcon] delivery pass', err);
	} finally {
		loop.claiming = false;
		claimFinished();
		if (wanted) void pass();
	}
}

/**
 * One server's claimed rows, one at a time in the order they were queued. Once the server is held,
 * the rows not yet sent go back as they are, to be claimed in the same order when the hold ends.
 */
async function deliverChain(env: Env, rows: OutboxRow[]): Promise<void> {
	for (let i = 0; i < rows.length; i++) {
		const after = await deliverOne(env, rows[i]).catch((err) => {
			console.error('[warcon] delivery', err);
		});
		if (after === 'held') return putBack(env, rows.slice(i), WAITING);
		if (after === 'refused') return putBack(env, rows.slice(i + 1), WAITING);
	}
}

/** What a held server's rows say while they wait. */
const WAITING = 'Waiting: the server asked the panel to slow down.';

/** Claimed rows that were not sent, back to pending as they are, oldest still first. */
async function putBack(env: Env, rows: OutboxRow[], why?: string): Promise<void> {
	if (!rows.length) return;
	try {
		await withOwnedTransaction(env, (tx) =>
			tx.execute(sql`
			UPDATE outbox SET state = 'pending', lease_until = NULL${why ? sql`, outcome = ${why}` : sql``}
			 WHERE state = 'sending'
			   AND id IN (SELECT v::bigint FROM jsonb_array_elements_text(${jsonList(rows.map((r) => r.id))}::text::jsonb) AS v)`)
		);
	} catch (err) {
		if (err instanceof LostOwnership) return; // the lease sweep marks them unknown
		console.error('[warcon] outbox update', err);
		return;
	}
	for (const r of rows) emit({ type: 'outbox', serverId: r.serverId, id: r.id, state: 'pending' });
}

type Outcome = 'delivered' | 'failed' | 'skipped' | 'unknown';

/** Why a row must not be sent right now, or null. Checked again inside the lane, right before sending. */
function skipReason(row: OutboxRow, m: ReturnType<typeof memoryOf>): string | null {
	if (!m) return 'Server no longer polled.';
	const age = Date.now() - new Date(row.createdAt).getTime();
	if (age > settings().outboxMaxAgeMs) return `Stale (${Math.round(age / 1000)}s old).`;
	if (
		row.steamId &&
		m.playersAt &&
		!m.players.some((p) => p.steamId === row.steamId) &&
		!m.presence.open.has(row.steamId)
	)
		return 'Player already left.';
	if (row.action === 'empty_reset' && (m.players.length > 0 || (m.status?.playerCount ?? 0) > 0))
		return 'Players arrived before the reset.';
	// A rule's kill goes soon or not at all (a player off the list at a map change waits for no
	// longer than this either).
	if (row.action === RULE_KILL && age > RULE_KILL_MAX_AGE_MS)
		return `Stale (${Math.round(age / 1000)}s old).`;
	// An AFK protection round goes only while what the worker last saw still says the server seeds:
	// a round in a live match kills everyone mid-fight. It goes soon or not at all.
	if (row.action === AFK_ROUND) {
		if (age > AFK_ROUND_MAX_AGE_MS) return `Stale (${Math.round(age / 1000)}s old).`;
		if (!m.status || !m.playersAt) return 'The server has not been looked at yet.';
		const goal = Number((row.params as { goal?: unknown } | null)?.goal);
		const count = Math.max(m.status.playerCount || 0, m.players.length);
		if (m.status.scores.some((s) => s.score > 0) || !(count < goal))
			return 'The match started before this was sent.';
	}
	// A Team balance move for a player already off the side it was decided from: the move before it
	// landed, or they changed side themselves. Moving (and killing) someone twice is not harmless.
	if (row.triggerKind === 'two_teams' && row.action === 'changeTeam') {
		const from = (row.params as { from?: string } | null)?.from;
		const p = m.players.find((q) => q.steamId === row.steamId);
		if (from && p && p.faction !== from) return `Already off ${from}.`;
		const verdict = twoTeamsMoveVerdict(row);
		if (verdict !== 'send' && verdict !== 'wait') return verdict;
	}
	return null;
}

/**
 * True when the row's player is off the list but their session is still open: the list empties
 * for half a minute at a map change, so they may be back. The row waits (until the session
 * closes, then it is skipped, or the stale cut-off) rather than being dropped or sent now.
 */
function mustWait(row: OutboxRow, m: ReturnType<typeof memoryOf>): boolean {
	return (
		(!!row.steamId &&
			!!m?.playersAt &&
			!m.players.some((p) => p.steamId === row.steamId) &&
			m.presence.open.has(row.steamId)) ||
		// a Team balance move whose deciding look is not written yet here
		(row.triggerKind === 'two_teams' &&
			row.action === 'changeTeam' &&
			twoTeamsMoveVerdict(row) === 'wait')
	);
}

/**
 * When a Team balance move was last sent for a player, by server and SteamID. The check above can only
 * tell a move landed from a player list taken after it, so a second move for the same player waits
 * for one (a retry claimed right behind the first would otherwise read the same list and go too).
 */
const movesSent = new Map<string, number>();
const moveOf = (row: OutboxRow) =>
	row.triggerKind === 'two_teams' && row.action === 'changeTeam' && row.steamId
		? `${row.serverId}:${row.steamId}`
		: null;

/** True while a Team balance move for this row's player went out after the last player list. */
function moveUnconfirmed(row: OutboxRow, m: ReturnType<typeof memoryOf>): boolean {
	const key = moveOf(row);
	if (!key) return false;
	// No player list since this process became the owner: the move may have been queued, or sent, by
	// the process before it, and nothing seen here says where the player is now.
	if ((m?.playersAt ?? 0) < ownedSince()) return true;
	const sentAt = movesSent.get(key);
	if (sentAt === undefined) return false;
	if (sentAt >= (m?.playersAt ?? 0)) return true;
	movesSent.delete(key!);
	return false;
}

let movesSweptAt = 0;

function noteMoveSent(row: OutboxRow): void {
	const key = moveOf(row);
	if (!key) return;
	const now = Date.now();
	// Once a minute, what is too old to matter goes: the map holds the last few minutes' moves.
	if (now - movesSweptAt > 60_000) {
		movesSweptAt = now;
		for (const [k, at] of movesSent) if (now - at > 5 * 60_000) movesSent.delete(k);
	}
	movesSent.set(key, now);
}

/**
 * True while the rule is on, with the settings the row was decided under for kinds that keep them
 * (SETTINGS_KEYS): an edit, a switch-off or a delete can land while a look or a kill batch that
 * read the old rule is still running, and its rows reach the outbox after the edit dropped the ones
 * before them.
 */
function holdsFor(
	row: OutboxRow,
	rule: { enabled: boolean; config: unknown; state?: unknown } | undefined
): boolean {
	if (!rule?.enabled) return false;
	const key = SETTINGS_KEYS[row.triggerKind];
	const params = row.params as { rule?: string; on?: number | null } | null;
	if (key && params?.rule !== key(rule.config)) return false;
	// A Team balance move carries the switch-on it was decided under: switched off and on again
	// since, the rule has started over and the move is not its decision.
	if (row.triggerKind === 'two_teams' && params?.on !== undefined && 'state' in rule)
		return params.on === ((rule.state as { enabledAt?: number } | null)?.enabledAt ?? null);
	return true;
}

/**
 * Whether the row's rule still holds its settings (true for kinds that do not ask). Read from the
 * table, not the worker's cache of rules, which can hold the old rule for a moment. Null when the
 * table could not be read: the row waits, and the error goes to the log, never to the row.
 */
async function stillHolds(env: Env, row: OutboxRow): Promise<boolean | null> {
	if (!SETTINGS_KEYS[row.triggerKind]) return true;
	if (!row.triggerId) return false;
	let rule: { enabled: boolean; config: unknown; state: unknown } | undefined;
	try {
		[rule] = await env.db
			.select({ enabled: triggers.enabled, config: triggers.config, state: triggers.state })
			.from(triggers)
			.where(eq(triggers.id, row.triggerId))
			.limit(1);
	} catch (err) {
		console.error('[warcon] rule check', forLog(err));
		return null;
	}
	return holdsFor(row, rule);
}

/** What a row decided under settings its rule no longer holds says. */
const CHANGED = 'The rule was changed before this was sent.';

/** How long a row whose player is off the list waits before it is looked at again. */
const WAIT_MS = 5000;

class Skipped extends Error {}
class Waiting extends Error {}
/** The server is held: nothing is sent to it until the hold ends. */
class Held extends Error {}

/** Until when (ms) the server has asked the panel to wait: its hold here, or its observation's. */
const holdOf = (serverId: string, m: ReturnType<typeof memoryOf>): number =>
	Math.max(held.get(serverId) ?? 0, m?.holdUntil ?? 0);

/** Puts a claimed row back to pending, to be claimed again after WAIT_MS. */
async function release(env: Env, row: OutboxRow): Promise<void> {
	try {
		await withOwnedTransaction(env, (tx) =>
			tx
				.update(outbox)
				.set({
					state: 'pending',
					leaseUntil: null,
					notBefore: sql`now() + (${WAIT_MS} || ' milliseconds')::interval`
				})
				.where(and(eq(outbox.id, row.id), eq(outbox.state, 'sending')))
		);
	} catch (err) {
		if (err instanceof LostOwnership) return; // the lease sweep marks it unknown
		console.error('[warcon] outbox update', err);
	}
}

/**
 * Sends one row and records what happened. 'held': the server is held and this row was not sent;
 * 'refused': the game refused this row, or a later step of it, for sending too fast (a refused row
 * is failed; a move whose kill was refused is delivered) and the server is now held. Either way
 * the chain puts the rest back.
 */
async function deliverOne(env: Env, row: OutboxRow): Promise<'held' | 'refused' | void> {
	if (row.action === 'seed_reward') return deliverSeedReward(env, row);
	if (row.action === PANEL_BAN) return deliverPanelBan(env, row);
	// An alert-only Name filter match or a Kill rate or Kill distance flag: the audit row (and its
	// Discord card) is the whole delivery.
	if (
		row.action === NAME_FLAG ||
		row.action === KILL_RATE_FLAG ||
		row.action === KILL_DISTANCE_FLAG
	) {
		const holds = await stillHolds(env, row);
		if (holds === null) return release(env, row);
		if (!holds) return finish(env, row, 'skipped', CHANGED);
		return finish(env, row, 'delivered', row.okMessage);
	}
	const early = skipReason(row, memoryOf(row.serverId));
	if (early) return finish(env, row, 'skipped', early);
	// A hold is for the whole server: looked at before a player's own wait, so it is noticed.
	const until = holdOf(row.serverId, memoryOf(row.serverId));
	if (until > Date.now()) {
		held.set(row.serverId, until);
		return 'held';
	}
	if (mustWait(row, memoryOf(row.serverId)) || moveUnconfirmed(row, memoryOf(row.serverId)))
		return release(env, row);
	stats.inFlight++;
	try {
		const result = await withServer(
			row.serverId,
			PRIORITY.delivery,
			async () => {
				// The wait for the lane may have changed things: look again before sending.
				const m = memoryOf(row.serverId);
				const late = skipReason(row, m);
				if (late) throw new Skipped(late);
				if (holdOf(row.serverId, m) > Date.now()) throw new Held();
				if (mustWait(row, m) || moveUnconfirmed(row, m)) throw new Waiting();
				const holds = await stillHolds(env, row);
				if (holds === null) throw new Waiting();
				if (!holds) throw new Skipped(CHANGED);
				if (!isOwner()) throw new LostOwnership();
				const client = await WardogsClient.forServer(env, m!.server);
				noteMoveSent(row);
				return execute(client, row);
			},
			settings().outboxLeaseMs
		);
		await finish(
			env,
			row,
			'delivered',
			((row.action === RULE_KILL || !OWN_WORDS.has(row.action)) && messageOf(result)) ||
				row.okMessage
		);
		// Done, but a later step was refused for sending too fast (changeTeam's kill, a rule kill's
		// whisper): hold the rest.
		const wait = retryAfterOf(result);
		if (wait) {
			held.set(row.serverId, Math.max(held.get(row.serverId) ?? 0, Date.now() + wait));
			return 'refused';
		}
	} catch (err) {
		if (err instanceof Skipped) return finish(env, row, 'skipped', err.message);
		if (err instanceof Held) {
			held.set(row.serverId, holdOf(row.serverId, memoryOf(row.serverId)));
			return 'held';
		}
		if (err instanceof Waiting) return release(env, row);
		if (err instanceof LostOwnership) return; // the lease sweep marks it unknown
		if (err instanceof LaneFull || err instanceof LaneTimeout)
			return finish(env, row, 'skipped', err.message);
		// Refused for sending too fast: this row fails as any refusal does, and the server's other
		// rows wait for as long as the game asked instead of running into the same answer.
		if (err instanceof GameError && err.code === 'rate_limited') {
			const until = Date.now() + (err.retryAfterMs || WAIT_MS);
			held.set(row.serverId, Math.max(held.get(row.serverId) ?? 0, until));
			await finish(env, row, 'failed', OWN_WORDS.has(row.action) ? refusal(err) : err.message);
			return 'refused';
		}
		if (err instanceof GameError && err.code === 'unreachable')
			await finish(env, row, 'unknown', `No answer from the server (${err.message})`);
		else if (OWN_WORDS.has(row.action)) await finish(env, row, 'failed', refusal(err));
		else if (err instanceof GameError || err instanceof ApiError)
			await finish(env, row, 'failed', err.message);
		else await finish(env, row, 'failed', err instanceof Error ? err.message : String(err));
	} finally {
		stats.inFlight--;
	}
}

/**
 * A Seeding reward is a panel action, not a game request: the player goes on the server's own
 * reserved list, or the organisation's, for the rule's number of days from now. The seeded
 * server is nudged to sync at once; with an org-wide slot the org's other servers pick the entry
 * up on their own next sync, as they would an expiry, so a burst of grants is never a burst of
 * fan-outs across the org. Earned slots do not go stale, so the age cut-off does not apply, and
 * the grant needs no server memory (the roster may still be loading after a start).
 */
async function deliverSeedReward(env: Env, row: OutboxRow): Promise<void> {
	const p = row.params as {
		steamId: string;
		name: string;
		reason: string;
		slotDays: number;
		/** missing on rows from before the rule had a scope: those went org-wide */
		scope?: 'server' | 'org';
		replaceExisting?: boolean;
		protectedNoteWord?: string;
	};
	stats.inFlight++;
	try {
		if (!isOwner()) throw new LostOwnership();
		const m = memoryOf(row.serverId);
		const server = m?.server ?? (await getServer(env, row.serverId));
		const org = m?.org ?? (server ? await getOrg(env, server.orgId) : null);
		if (!server || !org) return await finish(env, row, 'skipped', 'Server no longer exists.');
		const here = p.scope === 'server';
		const list = here
			? await serverListOf(env, server, 'reserve')
			: await listOf(env, org.id, 'reserve');
		const expiresAt = new Date(Date.now() + p.slotDays * 86400_000);
		const {
			id: entryId,
			added,
			replaced,
			protected: protectedEntry
		} = await grantEntry(
			env,
			list,
			{
				steamId: p.steamId,
				reason: p.reason,
				expiresAt,
				addedByName: `trigger: ${row.triggerName}`
			},
			{
				replaceExisting: !!p.replaceExisting,
				protectedNoteWord: p.protectedNoteWord
			}
		);
		// The next sync puts the slot on the server; remember it now so the rule does not grant
		// it again before the next snapshot.
		m?.reserved.add(p.steamId);
		if (!added)
			return await finish(
				env,
				row,
				'skipped',
				protectedEntry
					? `${p.steamId}'s existing reserved slot was kept because its note contains the protected word “${p.protectedNoteWord}”.`
					: `${p.steamId} already has a reserved slot ${here ? `on ${server.name}` : `in ${org.name}`}.`
			);
		if (m) {
			m.syncAt = 0;
			gateway().observeSoon(row.serverId, { lists: true });
		}
		// The org's JSON webhooks hear of it once the slot is on the list. A failure to queue the
		// event leaves the grant as it is: the slot was earned and given.
		try {
			await withOwnedTransaction(env, (tx) =>
				queueEvent(
					tx,
					seedRewardGranted({
						entryId,
						org: { id: org.id, name: org.name },
						server: { id: server.id, name: server.name },
						player: { steamId: p.steamId, name: p.name },
						scope: here ? 'server' : 'org',
						expiresAt,
						days: p.slotDays,
						rule: { id: row.triggerId, name: row.triggerName },
						seedMinutes: (row.detail as { minutes?: number } | null)?.minutes ?? null
					})
				)
			);
		} catch (err) {
			if (err instanceof LostOwnership) throw err;
			console.error('[warcon] json webhooks for a grant', forLog(err));
		}
		await finish(
			env,
			row,
			'delivered',
			`${replaced ? 'Replaced the reserved slot' : 'Reserved a slot'} for ${p.name} until ${expiresAt.toISOString().slice(0, 10)}.`
		);
	} catch (err) {
		if (err instanceof LostOwnership) return; // the lease sweep marks it unknown
		await finish(env, row, 'failed', err instanceof Error ? err.message : String(err));
	} finally {
		stats.inFlight--;
	}
}

/**
 * A rule's ban is a panel action, not a game request: the player goes on the server's own ban list,
 * or the organisation's, with the rule's reason, for its number of days or for good. It is written
 * only while this process owns the worker and the rule still holds the settings it was decided
 * under, both judged in the transaction that writes it. The panel's ban enforcement then removes
 * the player: the servers the ban reaches take their lists again at once (this one, or every
 * server of the organisation this worker watches), so a player on any of them is kicked at its
 * next look with the organisation's ban message. It stands whether or not the player is still on,
 * and does not go stale. A player already on that list for as long or longer is left as the list
 * has them; a shorter ban there is made to last as long as this one.
 */
async function deliverPanelBan(env: Env, row: OutboxRow): Promise<void> {
	const p = row.params as PanelBanParams;
	stats.inFlight++;
	try {
		if (!isOwner()) throw new LostOwnership();
		const m = memoryOf(row.serverId);
		const server = m?.server ?? (await getServer(env, row.serverId));
		const org = m?.org ?? (server ? await getOrg(env, server.orgId) : null);
		if (!server || !org) return await finish(env, row, 'skipped', 'Server no longer exists.');
		const here = p.scope !== 'org';
		const list = here ? await serverListOf(env, server, 'ban') : await listOf(env, org.id, 'ban');
		const written = await withOwnedTransaction(env, async (tx) => {
			// Read under a share lock: an edit or a delete of the rule waits for this ban, or lands
			// first and stops it.
			const [rule] = row.triggerId
				? await tx
						.select({ enabled: triggers.enabled, config: triggers.config })
						.from(triggers)
						.where(eq(triggers.id, row.triggerId))
						.for('share')
				: [];
			if (!holdsFor(row, rule)) return null;
			return grantEntry(
				env,
				list,
				{
					steamId: p.steamId,
					reason: p.reason,
					expiresAt: p.days ? new Date(Date.now() + p.days * 86400_000) : null,
					addedByName: `trigger: ${row.triggerName}`
				},
				{ tx, lengthen: true }
			);
		});
		if (!written) return await finish(env, row, 'skipped', CHANGED);
		if (!written.added && !written.lengthened)
			return await finish(
				env,
				row,
				'skipped',
				`${p.steamId} is already on ${here ? `${server.name}'s ban list` : `the ban list of ${org.name}`}.`
			);
		// Who added the entry and its reason stay; the length is now the rule's, and the list's own
		// record says so, as an edit by hand would.
		if (written.lengthened)
			await writeAudit(env, null, {
				actorName: `trigger: ${row.triggerName}`,
				...(here ? { server: { id: server.id, name: server.name } } : {}),
				orgId: org.id,
				category: here ? 'server' : 'org',
				action: 'list.update',
				target: p.steamId,
				outcome: 'ok',
				message: `Ban lengthened ${here ? `on ${server.name}` : `across ${org.name}`} ${p.days ? `for ${p.days} day${p.days === 1 ? '' : 's'}` : '(permanent)'} by a rule`,
				detail: {
					kind: 'ban',
					listId: list.id,
					entryId: written.id,
					triggerId: row.triggerId,
					days: p.days
				}
			}).catch((err) => console.error('[warcon] ban lengthen audit', forLog(err)));
		const reach = here ? [m] : [...allMemory()].filter((s) => s.server.orgId === server.orgId);
		for (const s of reach) {
			if (!s) continue;
			s.syncAt = 0;
			gateway().observeSoon(s.server.id, { lists: true });
		}
		await finish(
			env,
			row,
			'delivered',
			written.lengthened
				? `${row.okMessage} (the ban already there now lasts as long)`
				: row.okMessage
		);
	} catch (err) {
		if (err instanceof LostOwnership) return; // the lease sweep marks it unknown
		console.error('[warcon] rule ban', forLog(err));
		await finish(env, row, 'failed', 'The ban could not be written.');
	} finally {
		stats.inFlight--;
	}
}

/** The wait an action's answer asks for (changeTeam's refused kill), or 0. */
const retryAfterOf = (r: unknown): number =>
	r && typeof r === 'object' && typeof (r as { retryAfterMs?: unknown }).retryAfterMs === 'number'
		? (r as { retryAfterMs: number }).retryAfterMs
		: 0;

/**
 * A rule's whisper, kick or kill carries what it tells one player, their stats across the
 * organisation among it: what became of it is told in the panel's own words, never the game's,
 * which staff of this server read (Recent actions, the audit trail, Discord) and which might repeat
 * the text. A kill says in its own fixed words whether the player was killed and told.
 */
const OWN_WORDS = new Set(['whisper', 'kick', RULE_KILL]);

/** Why the game refused a whisper or kick, as a fixed phrase: its status and its code. */
function refusal(err: unknown): string {
	if (!(err instanceof GameError)) {
		// the panel's own refusal says why in its own words; anything else is logged, not shown
		if (err instanceof ApiError) return err.message;
		console.warn('[warcon] a rule message was not sent:', forLog(err));
		return 'Not sent: the panel could not send it.';
	}
	if (err.code === 'rate_limited') return 'Refused: the server asked the panel to slow down.';
	if (err.code === 'player_not_found') return 'Refused: the player is not on the server.';
	return `Refused by the server (${err.status}${/^[a-z_]{1,40}$/.test(err.code) ? `, ${err.code}` : ''}).`;
}

const messageOf = (r: unknown): string =>
	r && typeof r === 'object' && typeof (r as { message?: unknown }).message === 'string'
		? (r as { message: string }).message
		: '';

/**
 * One AFK protection round: each player it names who is still on is killed in turn, then the rule's
 * message goes out. A player gone since, or one the game will not kill (with no living character,
 * presumably: dead, or not spawned yet; its answer then has not been seen), is passed over. A refusal for sending too fast ends the round and holds the
 * server; no answer, a refused password or a server error ends it as a failure. After
 * AFK_ROUND_MAX_MS the rest are left for the next round, so the lane is never held for long. The
 * result is fixed phrases and counts only.
 */
async function afkRound(
	client: WardogsClient,
	params: Record<string, unknown>,
	m: ReturnType<typeof memoryOf>
): Promise<{ message: string; retryAfterMs?: number }> {
	const ids = (Array.isArray(params.steamIds) ? params.steamIds : [])
		.filter((v): v is string => typeof v === 'string')
		.slice(0, AFK_ROUND_MAX_PLAYERS);
	const on = new Set((m?.players ?? []).map((p) => p.steamId));
	const started = Date.now();
	let killed = 0;
	let refused = 0;
	let gone = 0;
	let left = 0;
	let retryAfterMs = 0;
	for (let i = 0; i < ids.length; i++) {
		if (!on.has(ids[i])) {
			gone++;
			continue;
		}
		if (Date.now() - started >= AFK_ROUND_MAX_MS) {
			left = ids.length - i;
			break;
		}
		try {
			await ACTIONS.kill.run(client, { steamId: ids[i] });
			killed++;
		} catch (err) {
			if (!(err instanceof GameError)) throw err;
			if (err.code === 'rate_limited') {
				retryAfterMs = err.retryAfterMs || WAIT_MS;
				left = ids.length - i;
				break;
			}
			if (
				err.code === 'unreachable' ||
				err.status === 401 ||
				err.status === 403 ||
				err.status >= 500
			)
				throw err;
			if (err.code === 'player_not_found') gone++;
			else refused++;
		}
	}
	const message = typeof params.message === 'string' ? str(params.message, MAX_CHAT) : '';
	let announced = false;
	if (killed && message && !retryAfterMs)
		try {
			await ACTIONS.broadcast.run(client, { message });
			announced = true;
		} catch (err) {
			if (!(err instanceof GameError)) throw err;
			// The round stands without its message; one refused for sending too fast holds the server.
			if (err.code === 'rate_limited') retryAfterMs = err.retryAfterMs || WAIT_MS;
		}
	const parts = [`Killed ${killed} of ${ids.length}`];
	if (refused) parts.push(`${refused} refused`);
	if (gone) parts.push(`${gone} gone`);
	if (left)
		parts.push(
			retryAfterMs
				? `${left} not reached: the server asked the panel to slow down`
				: `${left} not reached in time`
		);
	if (killed && message) parts.push(announced ? 'announced' : 'message not sent');
	return { message: `${parts.join(' · ')}.`, ...(retryAfterMs ? { retryAfterMs } : {}) };
}

/** Runs the row's action; "empty_reset" decides between a rotation edit and a direct change. */
async function execute(client: WardogsClient, row: OutboxRow): Promise<unknown> {
	const params = (row.params as Record<string, unknown>) ?? {};
	if (row.action === AFK_ROUND) return afkRound(client, params, memoryOf(row.serverId));
	if (row.action === RULE_KILL) return killAndTell(client, params);
	if (row.action === 'empty_reset') {
		let rotationOn = false;
		try {
			rotationOn = !!((await ACTIONS.rotation.run(client, {})) as { enabled: boolean }).enabled;
		} catch (err) {
			// A refusal for sending too fast is not "no rotation": the reset fails and the server is
			// held, before anything is sent. Anything else reads as no rotation.
			if (err instanceof GameError && err.code === 'rate_limited') throw err;
		}
		if (rotationOn) {
			try {
				await ACTIONS.setNextMap.run(client, params);
				return ACTIONS.endMatch.run(client, {});
			} catch (err) {
				// Builds without the rotation edit routes (live CL-499480) answer 404/405; the server is
				// empty, so travelling straight there is the same outcome.
				if (!(err instanceof GameError) || (err.code !== 'no_route' && err.status !== 405))
					throw err;
			}
		}
		await ACTIONS.changeMap.run(client, params);
		return rotationOn ? { message: 'Map changed directly.' } : ACTIONS.endMatch.run(client, {});
	}
	const def = ACTIONS[row.action];
	if (!def) throw new ApiError(400, `Unknown action '${row.action}'.`);
	return def.run(client, params);
}

async function finish(env: Env, row: OutboxRow, state: Outcome, outcome: string): Promise<void> {
	stats[state]++;
	deliveries.inc({ outcome: state });
	try {
		await withOwnedTransaction(env, (tx) =>
			tx
				.update(outbox)
				.set({ state, outcome: outcome.slice(0, 300), doneAt: new Date(), leaseUntil: null })
				.where(and(eq(outbox.id, row.id), eq(outbox.state, 'sending')))
		);
	} catch (err) {
		if (err instanceof LostOwnership) throw err;
		console.error('[warcon] outbox update', err);
	}
	// A panel action (a grant, a ban, a flag) can be delivered before the roster is in memory:
	// audit it from the server row then.
	const server =
		memoryOf(row.serverId)?.server ??
		(PANEL_ACTIONS.has(row.action) ? await getServer(env, row.serverId) : null);
	if (server && state !== 'skipped')
		await recordDelivery(
			env,
			row,
			{ id: server.id, name: server.name, orgId: server.orgId },
			row.target,
			state === 'delivered' ? 'ok' : 'error',
			outcome,
			{
				rconAction: row.action,
				outboxId: row.id,
				state,
				...((row.detail as Record<string, unknown>) ?? {})
			}
		).catch((err) => console.error('[warcon] delivery audit', err));
	emit({ type: 'outbox', serverId: row.serverId, id: row.id, state });
}

// ---- reads --------------------------------------------------------------------------------------

export async function recentOutbox(env: Env, serverId: string, limit = 30): Promise<OutboxView[]> {
	// Newest first in the order outbox_server_idx keeps (created_at DESC NULLS LAST, as Drizzle
	// writes it): by id the read walked the whole outbox, kept for good, back to the server's last
	// row, which on a quiet server is most of the table.
	const rows = await env.db
		.select()
		.from(outbox)
		.where(eq(outbox.serverId, serverId))
		.orderBy(sql`${outbox.createdAt} desc nulls last`, desc(outbox.id))
		.limit(limit);
	return rows.map((r) => ({
		id: r.id,
		triggerId: r.triggerId,
		triggerName: r.triggerName,
		triggerKind: r.triggerKind,
		action: r.action,
		target: r.target,
		state: r.state as OutboxView['state'],
		attempts: r.attempts,
		outcome: r.outcome,
		createdAt: r.createdAt.toISOString(),
		doneAt: r.doneAt ? r.doneAt.toISOString() : null
	}));
}

export async function outboxDepth(env: Env): Promise<{ pending: number; oldestMs: number | null }> {
	const [row] = await env.db.execute<{ n: string; oldest: Date | null }>(sql`
		SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM outbox WHERE state IN ('pending', 'sending')`);
	const n = Number(row?.n ?? 0);
	return { pending: n, oldestMs: row?.oldest ? Date.now() - new Date(row.oldest).getTime() : null };
}
