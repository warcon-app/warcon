// One row per player per match (match_players): what the game's scoreboard counted for that
// player over that match, kept in the worker's memory while the match runs, written when the
// player leaves and when the match ends, then enriched from the kill feed. Boards, careers, the
// dossier and analytics read these rows; the kills table itself is read only for the feed, the
// weapon and nemesis record and the team-kill trigger.
//
// The tally follows the rule followPlayer applies to a session: the game's per-match counters
// only climb, so a counter below the last look means the game started it again (a reconnect with
// fresh counters, or the next match reaching the player list before the status shows it). What
// was reached is banked and the new counters add on top. Cash banks the same way: the scoreboard
// starts it again with the counters (seen on the live game, 2026-09-22), so the row carries what
// each run of the counters earned, the cash at the last look less the cash at the first.
import { sql } from 'drizzle-orm';
import type { DbOrTx } from './db';
import { isTeam } from './sessions';
import { causeKind } from '$lib/causes';
import type { Player } from '$lib/types';

export interface MatchTally {
	steamId: string;
	/** the name at the last look */
	name: string;
	/** the last side seen that was a team on the scoreboard */
	faction: string | null;
	/** counters the game reset since the match began, as they stood when it did; for cash, what
	 *  each earlier run of the counters earned */
	banked: { kills: number; deaths: number; cash: number };
	/** the game's counters at the last look */
	last: { kills: number; deaths: number };
	/** the cash at the first look of this run of the counters, and at the last */
	cashFirst: number;
	cashLast: number;
	/** when the counters last dropped; 0 never */
	droppedAt: number;
	/** time on during the match: the gaps between trusted looks the player was on for */
	ms: number;
	lastSeen: number;
	/** the row is due at the next match stage: the player left (their part is then safe from a
	 *  worker restart), or the row is being closed */
	dirty: boolean;
}

export type Tallies = Map<string, MatchTally>;

/** One player's line of a match, as the row stores it (the feed columns come separately). */
export interface TallyRow {
	steamId: string;
	name: string;
	faction: string | null;
	seconds: number;
	kills: number;
	deaths: number;
	/** the cash earned over the match: each run of the counters' last look less its first */
	cashDelta: number;
}

/**
 * Applies one look at the player list. `stayed` names the players who were also on at the
 * previous look, when that look was recent enough to trust: they earn `gapMs` of time on.
 * Everyone on the list gets a tally; a newcomer starts from the counters as they stand.
 */
export function tallyLook(
	tallies: Tallies,
	players: Player[],
	opts: { now: number; gapMs: number; stayed: ReadonlySet<string>; teams?: readonly string[] }
): void {
	for (const p of players) {
		if (!p.steamId) continue;
		const t = tallies.get(p.steamId);
		if (!t) {
			tallies.set(p.steamId, {
				steamId: p.steamId,
				name: p.name,
				faction: isTeam(p.faction, opts.teams) ? p.faction : null,
				banked: { kills: 0, deaths: 0, cash: 0 },
				last: { kills: p.kills, deaths: p.deaths },
				cashFirst: p.cash,
				cashLast: p.cash,
				droppedAt: 0,
				ms: 0,
				lastSeen: opts.now,
				dirty: false
			});
			continue;
		}
		if (p.kills < t.last.kills || p.deaths < t.last.deaths) {
			t.banked.kills += t.last.kills;
			t.banked.deaths += t.last.deaths;
			t.banked.cash += t.cashLast - t.cashFirst;
			t.cashFirst = p.cash;
			t.droppedAt = opts.now;
		}
		t.last = { kills: p.kills, deaths: p.deaths };
		t.cashLast = p.cash;
		t.name = p.name;
		if (isTeam(p.faction, opts.teams)) t.faction = p.faction;
		if (opts.stayed.has(p.steamId)) t.ms += opts.gapMs;
		t.lastSeen = opts.now;
	}
}

/** The row a tally stands for right now: everything banked plus the counters as they stand. */
export const tallyRow = (t: MatchTally): TallyRow => ({
	steamId: t.steamId,
	name: t.name,
	faction: t.faction,
	seconds: Math.round(t.ms / 1000),
	kills: t.banked.kills + t.last.kills,
	deaths: t.banked.deaths + t.last.deaths,
	cashDelta: t.banked.cash + t.cashLast - t.cashFirst
});

/**
 * The rows of the match that just ended, and the tallies that carry into the next one. The
 * boundary is read from two status looks; the player list is looked at more often, so a
 * counter drop seen since the previous status look was the new match reaching the list first:
 * that player's row stops at what was banked, and the counters seen since open their tally in
 * the next match. Everyone else's row is everything reached, and their tally ends.
 */
export function closeTallies(
	tallies: Tallies,
	prevStatusAt: number
): { rows: TallyRow[]; carried: Tallies } {
	const rows: TallyRow[] = [];
	const carried: Tallies = new Map();
	for (const t of tallies.values()) {
		const early = t.droppedAt > 0 && t.droppedAt >= prevStatusAt;
		if (!early) {
			rows.push(tallyRow(t));
			continue;
		}
		rows.push({
			steamId: t.steamId,
			name: t.name,
			faction: t.faction,
			seconds: Math.round(t.ms / 1000),
			kills: t.banked.kills,
			deaths: t.banked.deaths,
			cashDelta: t.banked.cash
		});
		carried.set(t.steamId, {
			...t,
			banked: { kills: 0, deaths: 0, cash: 0 },
			last: { ...t.last },
			droppedAt: 0,
			ms: 0,
			dirty: false
		});
	}
	return { rows, carried };
}

const json = (v: unknown) => sql`(${JSON.stringify(v)}::text)::jsonb`;

/** Writes (or rewrites) these players' rows of the match. Sets, never adds. */
export async function writeMatchPlayers(
	db: DbOrTx,
	serverId: string,
	matchId: number,
	rows: TallyRow[]
): Promise<void> {
	if (!rows.length) return;
	await db.execute(sql`
		INSERT INTO match_players (match_id, server_id, steam_id, name, faction, seconds, kills, deaths, cash_delta)
		SELECT ${matchId}::bigint, ${serverId}, v.steam_id, v.name, v.faction, v.seconds, v.kills, v.deaths, v.cash_delta
		  FROM jsonb_to_recordset(${json(
				rows.map((r) => ({
					steam_id: r.steamId,
					name: r.name,
					faction: r.faction,
					seconds: r.seconds,
					kills: r.kills,
					deaths: r.deaths,
					cash_delta: r.cashDelta
				}))
			)}) AS v(steam_id text, name text, faction text, seconds int, kills int, deaths int, cash_delta int)
		ON CONFLICT (match_id, steam_id) DO UPDATE
		   SET name = EXCLUDED.name, faction = EXCLUDED.faction, seconds = EXCLUDED.seconds,
		       kills = EXCLUDED.kills, deaths = EXCLUDED.deaths, cash_delta = EXCLUDED.cash_delta`);
}

/** One kill of the match, in match order, as the feed pass reads it. */
export interface FeedKill {
	killerSteamId: string | null;
	victimSteamId: string;
	headshot: boolean;
	suicide: boolean;
	teamKill: boolean;
	cause: string | null;
	distanceM: number | null;
}

/** What the feed adds to a player's row of the match. */
export interface FeedRecord {
	headshots: number;
	teamKills: number;
	suicides: number;
	vehicleKills: number;
	longestM: number | null;
	killStreak: number;
	deathStreak: number;
}

/**
 * The feed's record of every player in the match's kills, in one pass. A kill is a killer, not
 * a suicide, not a team kill: it extends the killer's kill streak and ends their death streak;
 * every death (a kill taken, a team kill taken, a suicide, the environment) extends the victim's
 * death streak and ends their kill streak. A team kill is counted against its killer and does
 * not touch their streaks.
 */
export function feedRecord(kills: FeedKill[]): Map<string, FeedRecord> {
	const out = new Map<string, FeedRecord & { killRun: number; deathRun: number }>();
	const of = (id: string) => {
		let r = out.get(id);
		if (!r) {
			r = {
				headshots: 0,
				teamKills: 0,
				suicides: 0,
				vehicleKills: 0,
				longestM: null,
				killStreak: 0,
				deathStreak: 0,
				killRun: 0,
				deathRun: 0
			};
			out.set(id, r);
		}
		return r;
	};
	for (const k of kills) {
		if (k.killerSteamId && !k.suicide) {
			const killer = of(k.killerSteamId);
			if (k.teamKill) killer.teamKills++;
			else {
				if (k.headshot) killer.headshots++;
				const kind = causeKind(k.cause);
				if (kind === 'vehicle' || kind === 'vehicle weapon') killer.vehicleKills++;
				if (k.distanceM !== null && (killer.longestM === null || k.distanceM > killer.longestM))
					killer.longestM = k.distanceM;
				killer.killRun++;
				killer.deathRun = 0;
				if (killer.killRun > killer.killStreak) killer.killStreak = killer.killRun;
			}
		}
		const victim = of(k.victimSteamId);
		if (k.suicide) victim.suicides++;
		victim.deathRun++;
		victim.killRun = 0;
		if (victim.deathRun > victim.deathStreak) victim.deathStreak = victim.deathRun;
	}
	const record = new Map<string, FeedRecord>();
	for (const [id, r] of out)
		record.set(id, {
			headshots: r.headshots,
			teamKills: r.teamKills,
			suicides: r.suicides,
			vehicleKills: r.vehicleKills,
			longestM: r.longestM,
			killStreak: r.killStreak,
			deathStreak: r.deathStreak
		});
	return record;
}

/**
 * Fills the feed columns of the match's rows from the kills that carry its row, in match order.
 * One read of the match's window on kills (server_id, ts) and one update; rows the feed knows
 * nothing about keep their zeros, and a player the feed saw but the scoreboard never did (a
 * worker away for their whole stay) gets no row. Returns how many rows were filled.
 */
export async function enrichMatchPlayers(
	db: DbOrTx,
	serverId: string,
	matchId: number,
	startedAt: Date
): Promise<number> {
	const rows = await db.execute<{
		killerSteamId: string | null;
		victimSteamId: string;
		headshot: boolean;
		suicide: boolean;
		teamKill: boolean;
		cause: string | null;
		distanceM: number | null;
	}>(sql`
		SELECT killer_steam_id AS "killerSteamId", victim_steam_id AS "victimSteamId", headshot, suicide,
		       team_kill AS "teamKill", cause, distance_m AS "distanceM"
		  FROM kills
		 WHERE event_type = 'killed' AND parsed_kill
		   AND server_id = ${serverId} AND ts >= ${new Date(startedAt.getTime() - 120_000)}
		   AND match_row = ${matchId}::bigint
		 ORDER BY event_time, ts`);
	const record = feedRecord(rows as FeedKill[]);
	if (!record.size) return 0;
	const result = await db.execute(sql`
		UPDATE match_players AS m
		   SET headshots = v.headshots, team_kills = v.team_kills, suicides = v.suicides,
		       vehicle_kills = v.vehicle_kills, longest_m = v.longest_m,
		       kill_streak = v.kill_streak, death_streak = v.death_streak
		  FROM jsonb_to_recordset(${json(
				[...record].map(([steamId, r]) => ({
					steam_id: steamId,
					headshots: r.headshots,
					team_kills: r.teamKills,
					suicides: r.suicides,
					vehicle_kills: r.vehicleKills,
					longest_m: r.longestM,
					kill_streak: r.killStreak,
					death_streak: r.deathStreak
				}))
			)}) AS v(steam_id text, headshots int, team_kills int, suicides int, vehicle_kills int,
		           longest_m real, kill_streak int, death_streak int)
		 WHERE m.match_id = ${matchId}::bigint AND m.steam_id = v.steam_id`);
	return Number((result as unknown as { count?: number }).count ?? 0);
}
