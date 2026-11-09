// Player presence per server, kept in the worker's memory and written to player_sessions in
// batches: a row on join, left_at on leave (with the exact last time the player was seen), and a
// heartbeat every sessionHeartbeatMs that refreshes last_seen and the stats of everyone still on.
// A 2-second observation cadence must not mean a database write per player per observation. The
// one exception is a player's side, written the look it changes: the web decides whether a kill
// was a team kill from it as the kill arrives, and cannot see this memory.
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { playerSessions } from './db/schema';
import { jsonParam as json } from './db/storable';
import type { Player } from '$lib/types';

export interface OpenSession {
	id: number;
	steamId: string;
	name: string;
	faction: string | null;
	/** the session's totals: the game starts its counters again every match, so these carry what
	 *  earlier matches of the session reached plus the counters as they stand (followPlayer) */
	kills: number;
	deaths: number;
	/** cash, the same way: the game's scoreboard starts a player's cash again with the counters,
	 *  so a session carries what earlier matches reached plus the cash as it stands */
	cash: number;
	/** the game's own counters at the last look; null on a session reloaded after a restart */
	game: { kills: number; deaths: number; cash: number } | null;
	/** seed time banked: time on with the player count at or under the seeding threshold, counted
	 *  once the server climbed past the threshold with the player still on (observe.ts) */
	seedMs: number;
	/** seed time of the current low stretch, not yet banked; dropped if the player leaves first */
	pendingSeedMs: number;
	joinedAt: number;
	lastSeen: number;
	/** what the database currently holds for last_seen */
	writtenAt: number;
	/** what the database currently holds for faction */
	writtenTeam: string | null;
	/** this is the player's first session on this server (false when unknown: sessions reloaded
	 *  after a restart, or opened quietly when joins were not trusted) */
	firstVisit: boolean;
	/** the last team seen this session; unlike `faction` it survives the game clearing everyone's
	 *  side, or putting them on its holding team ("White"), between matches, so a re-pick of the
	 *  same side is not a new pick and the holding team is never one */
	lastFaction: string | null;
	/** the last side seen this session that was a team on the scoreboard, null until they are on
	 *  one. This is what the row keeps as the session's faction: the side seen last may be none,
	 *  or the game's holding team ("White"), when the player leaves between matches, and a player
	 *  on no team is on nobody's side when a kill is judged */
	team: string | null;
}

/** Whether a faction is a team in the match: on the scoreboard, or any side when there is none. */
export const isTeam = (faction: string | null, teams: readonly string[] | undefined): boolean =>
	!!faction && (!teams?.length || teams.includes(faction));

export interface Presence {
	loaded: boolean;
	open: Map<string, OpenSession>;
	heartbeatAt: number;
}

export const newPresence = (): Presence => ({ loaded: false, open: new Map(), heartbeatAt: 0 });

/**
 * Loads the sessions the database still has open for this server (once per process per server).
 * A stored side the scoreboard does not list (the holding side, which rows held before only teams
 * were kept) loads as none, so the next look writes it that way.
 */
export async function loadPresence(
	db: DbOrTx,
	serverId: string,
	presence: Presence,
	/** the factions on the scoreboard, when known */
	teams?: readonly string[]
): Promise<void> {
	const rows = await db
		.select()
		.from(playerSessions)
		.where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.leftAt)));
	presence.open.clear();
	for (const r of rows) {
		const team = isTeam(r.faction, teams) ? r.faction : null;
		presence.open.set(r.steamId, {
			id: r.id,
			steamId: r.steamId,
			name: r.name,
			faction: r.faction,
			kills: r.kills,
			deaths: r.deaths,
			cash: r.cash,
			game: null,
			seedMs: r.seedSeconds * 1000,
			pendingSeedMs: 0,
			joinedAt: r.joinedAt.getTime(),
			lastSeen: r.lastSeen.getTime(),
			writtenAt: r.lastSeen.getTime(),
			writtenTeam: r.faction,
			firstVisit: false,
			lastFaction: team,
			team
		});
	}
	presence.loaded = true;
}

export interface PresenceDiff {
	joined: Player[];
	left: OpenSession[];
	/** the players on the list who already have a session */
	stayed: { player: Player; session: OpenSession }[];
	/** the players still on who are in a faction other than the last one seen this session;
	 *  `from` is that last one (null: their first pick of the session) */
	factioned: { player: Player; from: string | null }[];
	/** the players still on whose name is not the one their session holds: the game can show a
	 *  joiner's name first and the clan tag in front of it a look or two later */
	renamed: Player[];
	/** the players back on the list after missing the previous look: inside the leave grace this
	 *  is the same session, but it may be a reconnect (a kicked player coming straight back), so
	 *  the rules that judge who may be on look at them again */
	returned: Player[];
}

/** How long a player may be missing from the list before their session closes. The game empties
 *  the list for half a minute or so at a map change while the clients load the next map; that is
 *  not a leave, and the same players back on the list is not a round of joins. */
export const LEAVE_GRACE_MS = 60_000;

/**
 * Compares the observed player list with the open sessions. Pure; touches nothing. A player
 * missing from the list is in neither `stayed` nor `left` until they have been gone for the grace;
 * their `lastSeen` stays put, so a leave recorded after it is dated to the last time they were on.
 */
export function diffPresence(
	presence: Presence,
	players: Player[],
	now: number,
	graceMs = LEAVE_GRACE_MS,
	/** when the previous look at the list was taken (0: none, so nobody counts as returned) */
	prevLookAt = 0,
	/** the factions on the scoreboard, when known: any other side is no pick */
	teams?: readonly string[]
): PresenceDiff {
	const seen = new Set<string>();
	const joined: Player[] = [];
	const returned: Player[] = [];
	const stayed: PresenceDiff['stayed'] = [];
	const factioned: PresenceDiff['factioned'] = [];
	const renamed: Player[] = [];
	for (const p of players) {
		if (!p.steamId || seen.has(p.steamId)) continue;
		seen.add(p.steamId);
		const s = presence.open.get(p.steamId);
		if (s) {
			stayed.push({ player: p, session: s });
			if (isTeam(p.faction, teams) && p.faction !== s.lastFaction)
				factioned.push({ player: p, from: s.lastFaction });
			if (p.name !== s.name) renamed.push(p);
			if (s.lastSeen < prevLookAt) returned.push(p);
		} else joined.push(p);
	}
	const left = [...presence.open.values()].filter(
		(s) => !seen.has(s.steamId) && now - s.lastSeen > graceMs
	);
	return { joined, left, stayed, factioned, renamed, returned };
}

/**
 * The name each of these SteamIDs last played under on these servers (none for one never seen
 * there). One look per player at their newest session, which the steam_id index finds without
 * reading the rest of their history: a player's sessions do not overlap, so the newest join is
 * the last one seen.
 */
export async function latestNames(
	db: DbOrTx,
	serverIds: string[],
	steamIds: string[]
): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const ids = [...new Set(steamIds)];
	if (!serverIds.length || !ids.length) return out;
	const rows = await db.execute<{ steamId: string; name: string }>(sql`
		SELECT i.steam_id AS "steamId", s.name
		  FROM jsonb_array_elements_text(${json(ids)}) AS i(steam_id)
		 CROSS JOIN LATERAL (SELECT name FROM player_sessions p
		                      WHERE p.steam_id = i.steam_id AND p.server_id IN ${serverIds}
		                      ORDER BY p.joined_at DESC LIMIT 1) s`);
	for (const r of rows) out.set(r.steamId, r.name);
	return out;
}

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
 * Brings a session in line with the player as just seen. Kills and deaths only climb within a
 * match, so either one falling means the game started its counters again (a new match): what the
 * session had reached is kept and the new counters are added on top. A session reloaded after a
 * restart has only its totals; what they hold beyond the counters now is taken as earlier matches.
 * Cash follows the same rule: the scoreboard's cash starts again with the counters (seen on the
 * live game on 2026-09-22, when players ten hours in showed a few thousand while offline players
 * kept hundreds of thousands), so it is banked at a counter drop too; within a match it may fall
 * through spending and simply follows.
 */
export function followPlayer(
	s: OpenSession,
	p: Player,
	now: number,
	teams?: readonly string[]
): void {
	s.name = p.name;
	s.faction = p.faction;
	if (isTeam(p.faction, teams)) s.lastFaction = p.faction;
	if (isTeam(p.faction, teams)) s.team = p.faction;
	const g = s.game;
	const restarted = !!g && (p.kills < g.kills || p.deaths < g.deaths);
	for (const k of ['kills', 'deaths', 'cash'] as const) {
		const before = !g ? Math.max(0, s[k] - p[k]) : restarted ? s[k] : s[k] - g[k];
		s[k] = before + p[k];
	}
	s.game = { kills: p.kills, deaths: p.deaths, cash: p.cash };
	s.lastSeen = now;
}

/** Whether a session's side (followPlayer) is not the one its row holds. */
export const sideMoved = (s: OpenSession): boolean => s.team !== s.writtenTeam;

/**
 * Applies a diff to the database and to the in-memory presence: inserts joins, closes leaves,
 * and (when the heartbeat is due) refreshes everyone else, or else writes the sides that changed.
 * `firstVisit` (from firstVisits, read before the transaction) is remembered on the new sessions
 * for rules that fire later on.
 */
export async function persistPresence(
	db: DbOrTx,
	serverId: string,
	presence: Presence,
	diff: PresenceDiff,
	ts: Date,
	heartbeatDue: boolean,
	firstVisit: Set<string> = new Set(),
	/** the factions on the scoreboard, when known */
	teams?: readonly string[]
): Promise<void> {
	const now = ts.getTime();

	if (diff.left.length) {
		await db.execute(sql`
			UPDATE player_sessions AS s SET left_at = v.left_at, last_seen = v.left_at,
			       name = v.name, faction = v.faction, kills = v.kills, deaths = v.deaths, cash = v.cash,
			       seed_seconds = v.seed_seconds
			  FROM jsonb_to_recordset(${json(
					diff.left.map((s) => ({
						id: s.id,
						left_at: new Date(s.lastSeen).toISOString(),
						name: s.name,
						faction: s.team,
						kills: s.kills,
						deaths: s.deaths,
						cash: s.cash,
						seed_seconds: Math.round(s.seedMs / 1000)
					}))
				)}) AS v(id bigint, left_at timestamptz, name text, faction text, kills int, deaths int, cash int, seed_seconds int)
			 WHERE s.id = v.id AND s.left_at IS NULL`);
		for (const s of diff.left) presence.open.delete(s.steamId);
	}

	if (diff.joined.length) {
		const teamOf = (p: Player) => (isTeam(p.faction, teams) ? p.faction : null);
		const rows = await db
			.insert(playerSessions)
			.values(
				diff.joined.map((p) => ({
					serverId,
					steamId: p.steamId,
					name: p.name,
					faction: teamOf(p),
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
				game: { kills: p.kills, deaths: p.deaths, cash: p.cash },
				seedMs: 0,
				pendingSeedMs: 0,
				joinedAt: now,
				lastSeen: now,
				writtenAt: now,
				writtenTeam: teamOf(p),
				firstVisit: firstVisit.has(p.steamId),
				lastFaction: teamOf(p),
				team: teamOf(p)
			});
	}

	for (const { player: p, session: s } of diff.stayed) followPlayer(s, p, now, teams);
	if (heartbeatDue && diff.stayed.length) {
		await db.execute(sql`
			UPDATE player_sessions AS s SET last_seen = v.last_seen,
			       name = v.name, faction = v.faction, kills = v.kills, deaths = v.deaths, cash = v.cash,
			       seed_seconds = v.seed_seconds
			  FROM jsonb_to_recordset(${json(
					diff.stayed.map(({ session: s }) => ({
						id: s.id,
						last_seen: new Date(s.lastSeen).toISOString(),
						name: s.name,
						faction: s.team,
						kills: s.kills,
						deaths: s.deaths,
						cash: s.cash,
						seed_seconds: Math.round(s.seedMs / 1000)
					}))
				)}) AS v(id bigint, last_seen timestamptz, name text, faction text, kills int, deaths int, cash int, seed_seconds int)
			 WHERE s.id = v.id AND s.left_at IS NULL`);
		for (const { session: s } of diff.stayed) {
			s.writtenAt = now;
			s.writtenTeam = s.team;
		}
		presence.heartbeatAt = now;
	} else {
		const moved = diff.stayed.map((x) => x.session).filter(sideMoved);
		if (moved.length) {
			// Only the side: the heartbeat brings the rest, and faction is in no index.
			await db.execute(sql`
				UPDATE player_sessions AS s SET faction = v.faction
				  FROM jsonb_to_recordset(${json(moved.map((s) => ({ id: s.id, faction: s.team })))})
				       AS v(id bigint, faction text)
				 WHERE s.id = v.id AND s.left_at IS NULL`);
			for (const s of moved) s.writtenTeam = s.team;
		}
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
			{ joined: [], left: open, stayed: [], factioned: [], renamed: [], returned: [] },
			new Date(),
			false
		);
	return open.length;
}
