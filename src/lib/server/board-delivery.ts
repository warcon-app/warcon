// Discord status boards: one message per board that this process keeps editing in place, on the
// board's own interval, with what the worker last saw on its servers (the same live view the
// pages show). A webhook may edit only messages it sent, so a board posts once, remembers the
// message id, and edits that message from then on; one that someone deleted is posted again.
// Runs in the process that owns the worker lease. boards.ts owns the records and their
// validation; board-render.ts shapes the message.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Env } from './env';
import { servers, statusBoards, type StatusBoardRow } from './db/schema';
import { isOwner, LostOwnership, withOwnedTransaction } from './leadership';
import { memoryOf } from './observe';
import { liveView, readLiveRows } from './live';
import { nextDue } from './poller-schedule';
import { callDiscord, type PostResult } from './webhook-delivery';
import { renderBoard, type BoardServer } from './board-render';
import type { LiveView } from '$lib/types';

declare global {
	// Survives Vite HMR re-evaluation in dev so an old loop never keeps editing.
	var __warconBoards: ReturnType<typeof setInterval> | undefined;
}

const BEAT_MS = 1000;
/** Boards are re-read this often; a change made in the panel reaches the worker sooner (invalidateBoards). */
const ROSTER_MS = 15_000;
/** A board whose last request failed (a webhook deleted in Discord, an outage) tries again this often at most. */
const FAILURE_RETRY_MS = 60_000;

interface BoardState {
	row: StatusBoardRow;
	/** when the message is next edited; 0 until the first beat */
	nextAt: number;
	busy: boolean;
}

const boards = new Map<string, BoardState>();
let envRef: Env | null = null;
let rosterAt = 0;
let beating = false;
let wasOwner = false;

export function startBoards(env: Env): void {
	envRef = env;
	if (globalThis.__warconBoards) clearInterval(globalThis.__warconBoards);
	globalThis.__warconBoards = setInterval(() => void beat(), BEAT_MS);
}

export function stopBoards(): void {
	if (globalThis.__warconBoards) clearInterval(globalThis.__warconBoards);
	globalThis.__warconBoards = undefined;
	boards.clear();
	rosterAt = 0;
	wasOwner = false;
}

/** A board was created, changed, paused or removed: read them again on the next beat. */
export function invalidateBoards(): void {
	rosterAt = 0;
}

async function beat(): Promise<void> {
	const env = envRef;
	if (!env || beating) return;
	if (!isOwner()) {
		wasOwner = false;
		return;
	}
	beating = true;
	try {
		const now = Date.now();
		if (!wasOwner) {
			// A new ownership period: another worker may have posted or edited meanwhile.
			wasOwner = true;
			rosterAt = 0;
		}
		if (now - rosterAt >= ROSTER_MS) await refreshRoster(env, now);
		for (const b of boards.values()) {
			if (b.busy || b.nextAt > now) continue;
			b.busy = true;
			// A fixed cadence from the first post on; a stall is never caught up with a burst.
			b.nextAt = nextDue(b.nextAt || now, b.row.intervalMs, now);
			void refresh(env, b)
				.catch((err) => {
					if (!(err instanceof LostOwnership)) console.error(`[warcon] board ${b.row.label}`, err);
				})
				.finally(() => {
					b.busy = false;
				});
		}
	} catch (err) {
		console.error('[warcon] boards beat', err);
	} finally {
		beating = false;
	}
}

async function refreshRoster(env: Env, now: number): Promise<void> {
	rosterAt = now;
	const rows = await env.db.select().from(statusBoards).where(eq(statusBoards.enabled, true));
	const present = new Set<string>();
	for (const row of rows) {
		present.add(row.id);
		const b = boards.get(row.id);
		if (!b) boards.set(row.id, { row, nextAt: now, busy: false });
		else {
			// Edited in the panel: show the new shape right away rather than at the next tick.
			if (row.updatedAt.getTime() !== b.row.updatedAt.getTime() && !b.busy) b.nextAt = now;
			b.row = row;
		}
	}
	for (const id of boards.keys()) if (!present.has(id)) boards.delete(id);
}

async function boardRow(env: Env, id: string): Promise<StatusBoardRow | null> {
	const [row] = await env.db.select().from(statusBoards).where(eq(statusBoards.id, id)).limit(1);
	return row ?? null;
}

/** The board's servers in the panel's order, each with the worker's latest view of it. */
async function boardServers(env: Env, row: StatusBoardRow): Promise<BoardServer[]> {
	const only = Array.isArray(row.serverIds) ? (row.serverIds as string[]) : null;
	const rows = await env.db
		.select({ id: servers.id, name: servers.name })
		.from(servers)
		.where(
			only?.length
				? and(eq(servers.orgId, row.orgId), inArray(servers.id, only))
				: eq(servers.orgId, row.orgId)
		)
		.orderBy(asc(servers.sortOrder), asc(servers.name));
	const live = new Map<string, LiveView>();
	const missing: string[] = [];
	for (const r of rows) {
		const m = memoryOf(r.id);
		if (m && m.observedAt) live.set(r.id, liveView(m));
		else missing.push(r.id);
	}
	for (const [id, v] of await readLiveRows(env, missing)) live.set(id, v);
	return rows.map((r) => ({ id: r.id, name: r.name, live: live.get(r.id) ?? null }));
}

async function refresh(env: Env, b: BoardState): Promise<void> {
	const row = b.row;
	const payload = renderBoard({
		appName: env.APP_NAME || 'Warcon',
		heading: row.heading,
		intervalMs: row.intervalMs,
		showPlayers: row.showPlayers,
		servers: await boardServers(env, row)
	});
	if (!isOwner()) return;
	if (row.messageId) {
		const edited = await callDiscord(env, row, {
			method: 'PATCH',
			messageId: row.messageId,
			payload
		});
		if (edited.status !== 404) return settle(env, b, edited);
		// The message is gone (deleted in Discord, or by the panel): look at the row again before
		// posting anew, since a pause or removal is what usually takes a message away.
		const fresh = await boardRow(env, row.id);
		if (!fresh || !fresh.enabled) {
			boards.delete(row.id);
			return;
		}
		b.row = fresh;
		if (fresh.messageId && fresh.messageId !== row.messageId) return; // re-pointed: edit that one next
	}
	const posted = await callDiscord(env, b.row, { payload });
	if (!posted.ok) return settle(env, b, posted);
	if (!posted.messageId)
		return settle(env, b, {
			ok: false,
			status: posted.status,
			error: 'Discord did not return the message it created.'
		});
	if (await claimMessage(env, b.row, posted.messageId))
		b.row = { ...b.row, messageId: posted.messageId };
	else {
		// Paused, removed or re-pointed while the post was in flight: the message is an orphan.
		void callDiscord(env, b.row, { method: 'DELETE', messageId: posted.messageId });
		boards.delete(b.row.id);
	}
}

/**
 * Records the outcome on the row. A rate limit moves the next edit to when Discord allows one;
 * any other failure is retried no more than once a minute rather than on every tick. A change
 * saved in the panel (a new URL, say) still applies at once: the roster reload pulls the edit in.
 */
async function settle(env: Env, b: BoardState, result: PostResult): Promise<void> {
	if (result.retryAfterMs) b.nextAt = Math.max(b.nextAt, Date.now() + result.retryAfterMs);
	else if (!result.ok) b.nextAt = Math.max(b.nextAt, Date.now() + FAILURE_RETRY_MS);
	try {
		await env.db
			.update(statusBoards)
			.set({
				lastSentAt: result.ok ? new Date() : undefined,
				lastStatus: result.status,
				lastError: result.ok ? '' : result.error.slice(0, 300)
			})
			.where(eq(statusBoards.id, b.row.id));
	} catch (err) {
		console.error('[warcon] board status', err);
	}
}

/**
 * Remembers the message a post created, but only if the board is still enabled and still points
 * at the message we were replacing (or none): a pause, removal or new URL saved meanwhile wins.
 */
async function claimMessage(env: Env, row: StatusBoardRow, messageId: string): Promise<boolean> {
	try {
		const rows = await withOwnedTransaction(env, (tx) =>
			tx
				.update(statusBoards)
				.set({ messageId, lastSentAt: new Date(), lastStatus: 200, lastError: '' })
				.where(
					and(
						eq(statusBoards.id, row.id),
						eq(statusBoards.enabled, true),
						row.messageId
							? eq(statusBoards.messageId, row.messageId)
							: isNull(statusBoards.messageId)
					)
				)
				.returning({ id: statusBoards.id })
		);
		return rows.length > 0;
	} catch (err) {
		if (!(err instanceof LostOwnership)) console.error('[warcon] board claim', err);
		return false;
	}
}
