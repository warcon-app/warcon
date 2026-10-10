// The live snapshot: what the worker last saw on each server, shaped for pages (LiveView) and
// persisted in server_live for cold reads and for a web process running on its own.
import { inArray } from 'drizzle-orm';
import type { Env } from './env';
import type { DbOrTx } from './db';
import { serverLive, type ServerLiveRow } from './db/schema';
import type { ServerMemory } from './observe';
import type { LiveView, Player, Status } from '$lib/types';
import { saneScores } from '$lib/format';

const iso = (ms: number): string | null => (ms > 0 ? new Date(ms).toISOString() : null);

/** A status read back from the table: one written before its scores were checked, or while the
 *  server was down, is checked again on the way out. */
function saneStatus(raw: unknown): Status | null {
	if (!raw || typeof raw !== 'object') return null;
	const s = raw as Status;
	return { ...s, scores: saneScores(s.scores) };
}

export function liveView(m: ServerMemory): LiveView {
	return {
		serverId: m.server.id,
		ok: m.ok,
		error: m.error,
		tier: m.tier,
		build: m.identity.build,
		gameServerId: m.identity.gameServerId,
		startedAt: iso(m.startedAt),
		reservedSlots: m.identity.reservedSlots,
		restartTimeUtc: m.identity.restartTimeUtc,
		restartTimeUtcFile: m.identity.restartTimeUtcFile,
		throttledUntil: m.holdUntil > Date.now() ? iso(m.holdUntil) : null,
		status: m.status,
		players: m.players,
		statusAt: iso(m.statusAt),
		playersAt: iso(m.playersAt),
		observedAt: iso(m.observedAt)
	};
}

/** A view without its player list, for pages that list many servers and show none of their players. */
export const slimView = (v: LiveView): LiveView => ({ ...v, players: [] });

export function liveViewFromRow(r: ServerLiveRow): LiveView {
	return {
		serverId: r.serverId,
		ok: r.ok,
		error: r.error,
		tier: r.tier as LiveView['tier'],
		build: r.build ?? '',
		gameServerId: r.gameServerId ?? '',
		startedAt: r.startedAt ? r.startedAt.toISOString() : null,
		reservedSlots: r.reservedSlots ?? null,
		restartTimeUtc: r.restartTimeUtc ?? null,
		restartTimeUtcFile: r.restartTimeUtcFile ?? null,
		// A hold lasts seconds; a row read cold from the database is not inside one.
		throttledUntil: null,
		status: saneStatus(r.status),
		players: Array.isArray(r.players) ? (r.players as Player[]) : [],
		statusAt: r.statusAt ? r.statusAt.toISOString() : null,
		playersAt: r.playersAt ? r.playersAt.toISOString() : null,
		observedAt: r.observedAt ? r.observedAt.toISOString() : null
	};
}

/** Upserts the server's row from the worker's memory. */
export async function writeLive(db: DbOrTx, m: ServerMemory, ts: Date): Promise<void> {
	const row = {
		serverId: m.server.id,
		ok: m.ok,
		error: m.error,
		tier: m.tier,
		build: m.identity.build,
		gameServerId: m.identity.gameServerId,
		startedAt: m.startedAt ? new Date(m.startedAt) : null,
		reservedSlots: m.identity.reservedSlots,
		restartTimeUtc: m.identity.restartTimeUtc,
		restartTimeUtcFile: m.identity.restartTimeUtcFile,
		status: m.status,
		players: m.players,
		playerCount: m.status?.playerCount ?? m.players.length,
		statusAt: m.statusAt ? new Date(m.statusAt) : null,
		playersAt: m.playersAt ? new Date(m.playersAt) : null,
		observedAt: m.observedAt ? new Date(m.observedAt) : null,
		updatedAt: ts
	};
	const { serverId: _id, ...set } = row;
	void _id;
	await db.insert(serverLive).values(row).onConflictDoUpdate({ target: serverLive.serverId, set });
}

/** Rows for these servers from the database (servers never observed are absent). */
export async function readLiveRows(env: Env, ids: string[]): Promise<Map<string, LiveView>> {
	const out = new Map<string, LiveView>();
	if (!ids.length) return out;
	const rows = await env.db.select().from(serverLive).where(inArray(serverLive.serverId, ids));
	for (const r of rows) out.set(r.serverId, liveViewFromRow(r));
	return out;
}
