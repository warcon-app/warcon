// Trigger delivery. Intents are written to the outbox inside the observation's transaction;
// this loop claims them (FOR UPDATE SKIP LOCKED, with a lease), sends each through the server's
// lane behind any human command, and records exactly what happened: delivered, failed (the game
// said no), skipped (the player had already left, or the intent went stale), or unknown (sent,
// no answer). Unknown is never retried on its own: a second whisper is harmless, a second kick
// is not, and the audit row says what is known.
import { and, desc, eq, sql } from 'drizzle-orm';
import type { Env } from './env';
import type { DbOrTx } from './db';
import { outbox, triggers, type OutboxRow } from './db/schema';
import { actionDef, ACTIONS } from './actions';
import { GameError, WardogsClient } from './rcon';
import { ApiError } from './http';
import { LaneFull, LaneTimeout, PRIORITY, withServer } from './dispatcher';
import { emit } from './events';
import { isOwner, LostOwnership, withOwnedTransaction } from './leadership';
import { settings } from './settings';
import { recordDelivery, type Intent, type TriggerUpdate } from './triggers';
import { memoryOf } from './observe';
import { grantEntry, listOf, serverListOf } from './lists';
import { getOrg, getServer } from './access';
import { gateway } from './gateway';
import { deliveries } from './metrics';
import { NAME_FLAG } from './name-filter';
import { KILL_RATE_FLAG } from './kill-rate';
import type { OutboxView } from '$lib/types';

const CLAIM_LIMIT = 50;
const PASS_MS = 1000;

/** Writes intents; a dedupe key seen before is dropped silently. Returns how many were new. */
export async function enqueueIntents(
	db: DbOrTx,
	serverId: string,
	intents: Intent[]
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
				dedupeKey: i.dedupeKey
			}))
		)
		.onConflictDoNothing({ target: outbox.dedupeKey })
		.returning({ id: outbox.id });
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
	// Survives Vite HMR re-evaluation in dev so an old delivery loop never keeps running.
	var __warconDelivery: ReturnType<typeof setInterval> | undefined;
}
let running = false;
let wanted = false;
let envRef: Env | null = null;
const stats = { delivered: 0, failed: 0, skipped: 0, unknown: 0, lastPassAt: 0, inFlight: 0 };

export function startDelivery(env: Env): void {
	envRef = env;
	if (globalThis.__warconDelivery) clearInterval(globalThis.__warconDelivery);
	globalThis.__warconDelivery = setInterval(() => void pass(), PASS_MS);
}

export function stopDelivery(): void {
	if (globalThis.__warconDelivery) clearInterval(globalThis.__warconDelivery);
	globalThis.__warconDelivery = undefined;
}

/** Runs a pass now (after intents were written) instead of waiting for the next tick. */
export function wakeDelivery(): void {
	wanted = true;
	void pass();
}

export const deliveryStats = () => ({ ...stats });

async function pass(): Promise<void> {
	const env = envRef;
	if (!env || running || !isOwner()) return;
	running = true;
	wanted = false;
	try {
		stats.lastPassAt = Date.now();
		const lease = settings().outboxLeaseMs;
		const claimed = await withOwnedTransaction(env, async (tx) => {
			// A send whose lease lapsed may have reached the game: it is unknown, never sent again.
			await tx.execute(sql`
			UPDATE outbox SET state = 'unknown', outcome = 'The worker stopped while sending; the game may have acted.', done_at = now(), lease_until = NULL
			 WHERE state = 'sending' AND lease_until < now()`);
			// Claiming moves the row to "sending" durably before anything is sent.
			return (await tx.execute(sql`
			UPDATE outbox SET state = 'sending', lease_until = now() + (${lease} || ' milliseconds')::interval, attempts = attempts + 1
			 WHERE id IN (SELECT id FROM outbox
			               WHERE state = 'pending' AND not_before <= now()
			               ORDER BY id LIMIT ${CLAIM_LIMIT} FOR UPDATE SKIP LOCKED)
			 RETURNING id, server_id AS "serverId", trigger_id AS "triggerId", trigger_name AS "triggerName",
			           trigger_kind AS "triggerKind", action, params, target, detail, steam_id AS "steamId",
			           ok_message AS "okMessage", dedupe_key AS "dedupeKey", state, attempts, not_before AS "notBefore",
			           lease_until AS "leaseUntil", outcome, created_at AS "createdAt", done_at AS "doneAt"`)) as unknown as OutboxRow[];
		});
		if (!claimed.length) return;
		// One chain per server (its lane serialises them anyway), servers in parallel.
		const byServer = new Map<string, OutboxRow[]>();
		for (const r of claimed)
			(byServer.get(r.serverId) ?? byServer.set(r.serverId, []).get(r.serverId)!).push(r);
		await Promise.all(
			[...byServer.values()].map(async (rows) => {
				for (const r of rows)
					await deliverOne(env, r).catch((err) => console.error('[warcon] delivery', err));
			})
		);
	} catch (err) {
		if (!(err instanceof LostOwnership)) console.error('[warcon] delivery pass', err);
	} finally {
		running = false;
		if (wanted) void pass();
	}
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
	return null;
}

/**
 * True when the row's player is off the list but their session is still open: the list empties
 * for half a minute at a map change, so they may be back. The row waits (until the session
 * closes, then it is skipped, or the stale cut-off) rather than being dropped or sent now.
 */
function mustWait(row: OutboxRow, m: ReturnType<typeof memoryOf>): boolean {
	return (
		!!row.steamId &&
		!!m?.playersAt &&
		!m.players.some((p) => p.steamId === row.steamId) &&
		m.presence.open.has(row.steamId)
	);
}

/** How long a row whose player is off the list waits before it is looked at again. */
const WAIT_MS = 5000;

class Skipped extends Error {}
class Waiting extends Error {}

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

async function deliverOne(env: Env, row: OutboxRow): Promise<void> {
	if (row.action === 'seed_reward') return deliverSeedReward(env, row);
	// An alert-only Name filter match or a Kill rate flag: the audit row (and its Discord card) is
	// the whole delivery.
	if (row.action === NAME_FLAG || row.action === KILL_RATE_FLAG)
		return finish(env, row, 'delivered', row.okMessage);
	const early = skipReason(row, memoryOf(row.serverId));
	if (early) return finish(env, row, 'skipped', early);
	if (mustWait(row, memoryOf(row.serverId))) return release(env, row);
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
				if (mustWait(row, m)) throw new Waiting();
				if (!isOwner()) throw new LostOwnership();
				const client = await WardogsClient.forServer(env, m!.server);
				return execute(client, row);
			},
			settings().outboxLeaseMs
		);
		await finish(env, row, 'delivered', messageOf(result) || row.okMessage);
	} catch (err) {
		if (err instanceof Skipped) return finish(env, row, 'skipped', err.message);
		if (err instanceof Waiting) return release(env, row);
		if (err instanceof LostOwnership) return; // the lease sweep marks it unknown
		if (err instanceof LaneFull || err instanceof LaneTimeout)
			return finish(env, row, 'skipped', err.message);
		if (err instanceof GameError && err.code === 'unreachable')
			await finish(env, row, 'unknown', `No answer from the server (${err.message})`);
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
		const { added } = await grantEntry(env, list, {
			steamId: p.steamId,
			reason: p.reason,
			expiresAt,
			addedByName: `trigger: ${row.triggerName}`
		});
		// The next sync puts the slot on the server; remember it now so the rule does not grant
		// it again before the next snapshot.
		m?.reserved.add(p.steamId);
		if (!added)
			return await finish(
				env,
				row,
				'skipped',
				`${p.steamId} already has a reserved slot ${here ? `on ${server.name}` : `in ${org.name}`}.`
			);
		if (m) {
			m.syncAt = 0;
			gateway().observeSoon(row.serverId, { lists: true });
		}
		await finish(
			env,
			row,
			'delivered',
			`Reserved a slot for ${p.name} until ${expiresAt.toISOString().slice(0, 10)}.`
		);
	} catch (err) {
		if (err instanceof LostOwnership) return; // the lease sweep marks it unknown
		await finish(env, row, 'failed', err instanceof Error ? err.message : String(err));
	} finally {
		stats.inFlight--;
	}
}

const messageOf = (r: unknown): string =>
	r && typeof r === 'object' && typeof (r as { message?: unknown }).message === 'string'
		? (r as { message: string }).message
		: '';

/** Runs the row's action; "empty_reset" decides between a rotation edit and a direct change. */
async function execute(client: WardogsClient, row: OutboxRow): Promise<unknown> {
	const params = (row.params as Record<string, unknown>) ?? {};
	if (row.action === 'empty_reset') {
		let rotationOn = false;
		try {
			rotationOn = !!((await ACTIONS.rotation.run(client, {})) as { enabled: boolean }).enabled;
		} catch {
			/* treat as no rotation */
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
	const def = actionDef(row.action);
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
	// A grant can be delivered before the roster is in memory: audit it from the server row then.
	const server =
		memoryOf(row.serverId)?.server ??
		(row.action === 'seed_reward' ? await getServer(env, row.serverId) : null);
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
	const rows = await env.db
		.select()
		.from(outbox)
		.where(eq(outbox.serverId, serverId))
		.orderBy(desc(outbox.id))
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
