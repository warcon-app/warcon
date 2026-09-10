// Player presence per server, kept in the worker's memory and written to player_sessions in
// batches: a row on join, left_at on leave (with the exact last time the player was seen), and a
// heartbeat every sessionHeartbeatMs that refreshes last_seen and the stats of everyone still on.
// A 2-second observation cadence must not mean a database write per player per observation.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { playerSessions } from './db/schema';
import type { Player } from '$lib/types';

export interface OpenSession {
	id: number;
	steamId: string;
	name: string;
	faction: string | null;
	kills: number;
	deaths: number;
	cash: number;
	joinedAt: number;
	lastSeen: number;
	/** what the database currently holds for last_seen */
	writtenAt: number;
}

export interface Presence {
	loaded: boolean;
	open: Map<string, OpenSession>;
	heartbeatAt: number;
}

export const newPresence = (): Presence => ({ loaded: false, open: new Map(), heartbeatAt: 0 });

/** Loads the sessions the database still has open for this server (once per process per server). */
export async function loadPresence(
	db: DbOrTx,
	serverId: string,
	presence: Presence
): Promise<void> {
	const rows = await db
		.select()
		.from(playerSessions)
		.where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.leftAt)));
	presence.open.clear();
	for (const r of rows)
		presence.open.set(r.steamId, {
			id: r.id,
			steamId: r.steamId,
			name: r.name,
			faction: r.faction,
			kills: r.kills,
			deaths: r.deaths,
			cash: r.cash,
			joinedAt: r.joinedAt.getTime(),
			lastSeen: r.lastSeen.getTime(),
			writtenAt: r.lastSeen.getTime()
		});
	presence.loaded = true;
}

export interface PresenceDiff {
	joined: Player[];
	left: OpenSession[];
	/** the players still on, with their open session */
	stayed: { player: Player; session: OpenSession }[];
}

/** Compares the observed player list with the open sessions. Pure; touches nothing. */
export function diffPresence(presence: Presence, players: Player[]): PresenceDiff {
	const seen = new Set<string>();
	const joined: Player[] = [];
	const stayed: PresenceDiff['stayed'] = [];
	for (const p of players) {
		if (!p.steamId || seen.has(p.steamId)) continue;
		seen.add(p.steamId);
		const s = presence.open.get(p.steamId);
		if (s) stayed.push({ player: p, session: s });
		else joined.push(p);
	}
	const left = [...presence.open.values()].filter((s) => !seen.has(s.steamId));
	return { joined, left, stayed };
}

const json = (v: unknown) => sql`(${JSON.stringify(v)}::text)::jsonb`;

/** Which of these SteamIDs have never had a session on this server (a read; call before the transaction). */
export async function firstVisits(
	db: DbOrTx,
	serverId: string,
	ids: string[]
): Promise<Set<string>> {
	const out = new Set<string>();
	if (!ids.length) return out;
	const known = await db
		.selectDistinct({ steamId: playerSessions.steamId })
		.from(playerSessions)
		.where(and(eq(playerSessions.serverId, serverId), inArray(playerSessions.steamId, ids)));
	const knownIds = new Set(known.map((k) => k.steamId));
	for (const id of ids) if (!knownIds.has(id)) out.add(id);
	return out;
}

/**
 * Applies a diff to the database and to the in-memory presence: inserts joins, closes leaves,
 * and (when the heartbeat is due) refreshes everyone else.
 */
export async function persistPresence(
	db: DbOrTx,
	serverId: string,
	presence: Presence,
	diff: PresenceDiff,
	ts: Date,
	heartbeatDue: boolean
): Promise<void> {
	const now = ts.getTime();

	if (diff.left.length) {
		await db.execute(sql`
			UPDATE player_sessions AS s SET left_at = v.left_at, last_seen = v.left_at,
			       name = v.name, faction = v.faction, kills = v.kills, deaths = v.deaths, cash = v.cash
			  FROM jsonb_to_recordset(${json(
					diff.left.map((s) => ({
						id: s.id,
						left_at: new Date(s.lastSeen).toISOString(),
						name: s.name,
						faction: s.faction,
						kills: s.kills,
						deaths: s.deaths,
						cash: s.cash
					}))
				)}) AS v(id bigint, left_at timestamptz, name text, faction text, kills int, deaths int, cash int)
			 WHERE s.id = v.id AND s.left_at IS NULL`);
		for (const s of diff.left) presence.open.delete(s.steamId);
	}

	if (diff.joined.length) {
		const rows = await db
			.insert(playerSessions)
			.values(
				diff.joined.map((p) => ({
					serverId,
					steamId: p.steamId,
					name: p.name,
					faction: p.faction,
					joinedAt: ts,
					lastSeen: ts,
					kills: p.kills,
					deaths: p.deaths,
					cash: p.cash
				}))
			)
			.returning({ id: playerSessions.id, steamId: playerSessions.steamId });
		const idOf = new Map(rows.map((r) => [r.steamId, r.id]));
		for (const p of diff.joined)
			presence.open.set(p.steamId, {
				id: idOf.get(p.steamId)!,
				steamId: p.steamId,
				name: p.name,
				faction: p.faction,
				kills: p.kills,
				deaths: p.deaths,
				cash: p.cash,
				joinedAt: now,
				lastSeen: now,
				writtenAt: now
			});
	}

	for (const { player: p, session: s } of diff.stayed) {
		s.name = p.name;
		s.faction = p.faction;
		s.kills = p.kills;
		s.deaths = p.deaths;
		s.cash = p.cash;
		s.lastSeen = now;
	}
	if (heartbeatDue && diff.stayed.length) {
		await db.execute(sql`
			UPDATE player_sessions AS s SET last_seen = v.last_seen,
			       name = v.name, faction = v.faction, kills = v.kills, deaths = v.deaths, cash = v.cash
			  FROM jsonb_to_recordset(${json(
					diff.stayed.map(({ session: s }) => ({
						id: s.id,
						last_seen: new Date(s.lastSeen).toISOString(),
						name: s.name,
						faction: s.faction,
						kills: s.kills,
						deaths: s.deaths,
						cash: s.cash
					}))
				)}) AS v(id bigint, last_seen timestamptz, name text, faction text, kills int, deaths int, cash int)
			 WHERE s.id = v.id AND s.left_at IS NULL`);
		for (const { session: s } of diff.stayed) s.writtenAt = now;
		presence.heartbeatAt = now;
	}
}

/** Closes every open session at the time each player was last seen (the server went away). */
export async function closeAllSessions(db: DbOrTx, presence: Presence): Promise<number> {
	const open = [...presence.open.values()];
	if (open.length)
		await persistPresence(
			db,
			'',
			presence,
			{ joined: [], left: open, stayed: [] },
			new Date(),
			false
		);
	return open.length;
}
