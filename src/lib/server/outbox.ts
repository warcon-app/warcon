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
import { ACTIONS } from './actions';
import { GameError, WardogsClient } from './rcon';
import { ApiError } from './http';
import { LaneFull, LaneTimeout, PRIORITY, withServer } from './dispatcher';
import { emit } from './events';
import { isOwner, LostOwnership, withOwnedTransaction } from './leadership';
import { settings } from './settings';
import { recordDelivery, type Intent, type TriggerUpdate } from './triggers';
import { memoryOf } from './observe';
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

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let wanted = false;
let envRef: Env | null = null;
const stats = { delivered: 0, failed: 0, skipped: 0, unknown: 0, lastPassAt: 0, inFlight: 0 };

export function startDelivery(env: Env): void {
	envRef = env;
	if (timer) clearInterval(timer);
	timer = setInterval(() => void pass(), PASS_MS);
}

export function stopDelivery(): void {
	if (timer) clearInterval(timer);
	timer = null;
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
		// A send whose lease lapsed may have reached the game: it is unknown, never sent again.
		await env.db.execute(sql`
			UPDATE outbox SET state = 'unknown', outcome = 'The worker stopped while sending; the game may have acted.', done_at = now(), lease_until = NULL
			 WHERE state = 'sending' AND lease_until < now()`);
		// Claiming moves the row to "sending" durably before anything is sent.
		const claimed = (await env.db.execute(sql`
			UPDATE outbox SET state = 'sending', lease_until = now() + (${lease} || ' milliseconds')::interval, attempts = attempts + 1
			 WHERE id IN (SELECT id FROM outbox
			               WHERE state = 'pending' AND not_before <= now()
			               ORDER BY id LIMIT ${CLAIM_LIMIT} FOR UPDATE SKIP LOCKED)
			 RETURNING id, server_id AS "serverId", trigger_id AS "triggerId", trigger_name AS "triggerName",
			           trigger_kind AS "triggerKind", action, params, target, detail, steam_id AS "steamId",
			           ok_message AS "okMessage", dedupe_key AS "dedupeKey", state, attempts, not_before AS "notBefore",
			           lease_until AS "leaseUntil", outcome, created_at AS "createdAt", done_at AS "doneAt"`)) as unknown as OutboxRow[];
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
	if (row.steamId && m.playersAt && !m.players.some((p) => p.steamId === row.steamId))
		return 'Player already left.';
	if (row.action === 'empty_reset' && (m.players.length > 0 || (m.status?.playerCount ?? 0) > 0))
		return 'Players arrived before the reset.';
	return null;
}

class Skipped extends Error {}

async function deliverOne(env: Env, row: OutboxRow): Promise<void> {
	const early = skipReason(row, memoryOf(row.serverId));
	if (early) return finish(env, row, 'skipped', early);
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
				if (!isOwner()) throw new LostOwnership();
				const client = await WardogsClient.forServer(env, m!.server);
				return execute(client, row);
			},
			settings().outboxLeaseMs
		);
		await finish(env, row, 'delivered', messageOf(result) || row.okMessage);
	} catch (err) {
		if (err instanceof Skipped) return finish(env, row, 'skipped', err.message);
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
		await ACTIONS[rotationOn ? 'setNextMap' : 'changeMap'].run(client, params);
		return ACTIONS.endMatch.run(client, {});
	}
	const def = ACTIONS[row.action];
	if (!def) throw new ApiError(400, `Unknown action '${row.action}'.`);
	return def.run(client, params);
}

async function finish(env: Env, row: OutboxRow, state: Outcome, outcome: string): Promise<void> {
	stats[state]++;
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
	const m = memoryOf(row.serverId);
	if (m && state !== 'skipped')
		await recordDelivery(
			env,
			row,
			{ id: m.server.id, name: m.server.name, orgId: m.server.orgId },
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
