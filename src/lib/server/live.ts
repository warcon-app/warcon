// The live snapshot: what the worker last saw on each server, shaped for pages (LiveView) and
// persisted in server_live for cold reads and for a web process running on its own.
import { inArray } from 'drizzle-orm';
import type { Env } from './env';
import type { DbOrTx } from './db';
import { serverLive, type ServerLiveRow } from './db/schema';
import type { ServerMemory } from './observe';
import type { LiveView, Player, Status } from '$lib/types';

const iso = (ms: number): string | null => (ms > 0 ? new Date(ms).toISOString() : null);

export function liveView(m: ServerMemory): LiveView {
	return {
		serverId: m.server.id,
		ok: m.ok,
		error: m.error,
		tier: m.tier,
		status: m.status,
		players: m.players,
		statusAt: iso(m.statusAt),
		playersAt: iso(m.playersAt),
		observedAt: iso(m.observedAt)
	};
}

export function liveViewFromRow(r: ServerLiveRow): LiveView {
	return {
		serverId: r.serverId,
		ok: r.ok,
		error: r.error,
		tier: r.tier as LiveView['tier'],
		status: (r.status as Status | null) ?? null,
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
