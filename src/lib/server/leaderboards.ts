// Leaderboards and careers, read at page load from what the worker writes: each player's line
// of every match (match_players: the game's own kills and deaths, the feed's headshots, team
// kills, suicides, vehicle kills and streaks, time on and the side played) joined to its match
// for the result, and the sessions for playtime, seed time, the last name and cash. All time is
// read from each player's settled totals per server (player_totals, kept by the database as
// sessions close and matches end, migration 0038) plus the open sessions; a range (7, 30, 90
// days) or a season still running from the same totals per UTC day (player_days, migration 0039)
// plus its partial first day and the open sessions; a finished season from the day rows too, cut
// at its end. A page of a board is kept for a minute (loadBoard). Only matches that have ended
// count, and a match is in a range or a season by when it ended; the match in progress is on the
// live page. The result of a match for a player (win, loss, draw, none) is the rule in
// $lib/leaderboard, written out again in SQL below for the aggregates (and once more, as
// match_result(), in the migration).
import { sql } from 'drizzle-orm';
import type { Env } from './env';
import { servers } from './db/schema';
import { boardReads } from './metrics';
import type { RiskPerformance } from './risk';
import type { PlayerStats } from './message-vars';
import { orgSeasons, pickable, resolveWindow, type BoardWindow } from './seasons';
import {
	BOARD_PAGE,
	DEFAULT_FLOOR_MINUTES,
	groupCareer,
	streak,
	type BoardMetric,
	type BoardQuery,
	type BoardRow,
	type BoardView,
	type CareerMatch,
	type CareerPlace,
	type CareerSeason,
	type CareerView,
	type MatchResult
} from '$lib/leaderboard';
import {
	isFinished,
	WINNER_MIN_MATCHES,
	type Season,
	type SeasonWinners,
	type WinnerCategory
} from '$lib/seasons';

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const iso = (v: unknown): string | null =>
	v === null || v === undefined ? null : new Date(v as string | Date).toISOString();

/** All time is "since the epoch": one query shape for every range. */
const EPOCH = new Date(0);

/**
 * One row per (player, match) over these servers: the player's line of the match with its
 * outcome (the rule of matchResult() in $lib/leaderboard). `steamId` narrows it to one player
 * (a career) or a few (risk), else every player with a line in the range.
 */
const lines = (ids: string[], from: Date, steamId: string | string[] | null) => sql`
	lines AS (
		SELECT p.steam_id, p.match_id, p.server_id, p.faction, p.seconds, p.kills, p.deaths, p.cash_delta,
		       p.headshots, p.team_kills, p.suicides, p.vehicle_kills, p.longest_m, p.kill_streak, p.death_streak,
		       m.started_at, m.ended_at, m.map,
		       CASE WHEN p.faction IS NULL THEN NULL
		            WHEN jsonb_typeof(m.final_scores) = 'array' AND jsonb_array_length(m.final_scores) > 0
		                 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.final_scores) e WHERE e->>'name' = p.faction)
		                 THEN NULL
		            WHEN m.winner IS NOT NULL THEN CASE WHEN m.winner = p.faction THEN 'win' ELSE 'loss' END
		            WHEN jsonb_typeof(m.final_scores) = 'array'
		                 AND (SELECT MAX(CASE WHEN jsonb_typeof(e->'score') = 'number' THEN (e->>'score')::numeric END)
		                        FROM jsonb_array_elements(m.final_scores) e) > 0 THEN 'draw'
		            ELSE NULL END AS result
		  FROM matches m
		  JOIN match_players p ON p.match_id = m.id AND p.server_id = m.server_id
		 WHERE m.server_id IN ${ids} AND m.ended_at IS NOT NULL AND m.ended_at >= ${from}
		   ${steamId === null ? sql`` : Array.isArray(steamId) ? sql`AND p.steam_id IN ${steamId}` : sql`AND p.steam_id = ${steamId}`})`;

/**
 * Per-player totals over these servers since `from` (the 7, 30 and 90-day boards), from the day
 * rows (player_days, migration 0039): every UTC day after from's (D1 on) in full; for each session
 * that crossed D1's midnight (its join is kept on D1's row), its time from `from`, or from its
 * join, to that midnight; and, read here, the sessions closed between `from` and that midnight, the
 * open sessions seen since `from` and the lines of matches that ended in the same stretch. One pass
 * over them, then the columns of the reads before player_days (base in src/test/totals-oracle.ts),
 * word for word: a player's session side only when they have a session in range, the line side
 * only with a line in range, else the zero the missing side had. Seconds are exact numeric sums,
 * so the minutes are the same digits for any `from`. `cash_minutes` is the whole time of the
 * sessions the cash came from, what cash per minute divides by: a session that began before
 * `from` counts all of its cash, so all of its time too (from its join, not from `from`). Also
 * read by the exactness test.
 */
export const rangeBase = (ids: string[], from: Date) => sql`
	edge AS (
		SELECT ${from}::timestamptz AS f, (${from}::timestamptz AT TIME ZONE 'UTC')::date + 1 AS d1,
		       ((${from}::timestamptz AT TIME ZONE 'UTC')::date + 1)::timestamp AT TIME ZONE 'UTC' AS m1),
	parts AS (
		SELECT d.steam_id, d.sessions AS n, d.seconds AS sec, d.seconds AS cs, d.seed_seconds AS seed, d.cash,
		       d.last_seen AS ls, d.matches AS m, d.kills, d.deaths, d.headshots, d.team_kills, d.suicides,
		       d.vehicle_kills, d.kill_streak, d.death_streak, d.wins, d.losses, d.draws, d.idle_seconds AS idle
		  FROM player_days d, edge WHERE d.server_id IN ${ids} AND d.day >= edge.d1
		UNION ALL
		SELECT d.steam_id, 0, EXTRACT(EPOCH FROM (edge.m1 - GREATEST(j, edge.f))), EXTRACT(EPOCH FROM (edge.m1 - j)),
		       0, 0, NULL, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
		  FROM player_days d CROSS JOIN edge CROSS JOIN LATERAL unnest(d.crossings) j
		 WHERE d.server_id IN ${ids} AND d.day = edge.d1 AND d.crossings IS NOT NULL
		UNION ALL
		SELECT s.steam_id, 1, EXTRACT(EPOCH FROM (COALESCE(s.left_at, now()) - GREATEST(s.joined_at, edge.f))),
		       EXTRACT(EPOCH FROM (COALESCE(s.left_at, now()) - s.joined_at)),
		       s.seed_seconds, s.cash, s.last_seen, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
		  FROM player_sessions s, edge
		 WHERE s.server_id IN ${ids} AND s.last_seen >= edge.f
		   AND (s.left_at IS NULL OR (s.left_at >= edge.f AND s.left_at < edge.m1))
		UNION ALL
		SELECT p.steam_id, 0, 0, 0, 0, 0, NULL, 1, p.kills, p.deaths, p.headshots, p.team_kills, p.suicides,
		       p.vehicle_kills, p.kill_streak, p.death_streak, CASE WHEN x.r = 'win' THEN 1 ELSE 0 END,
		       CASE WHEN x.r = 'loss' THEN 1 ELSE 0 END, CASE WHEN x.r = 'draw' THEN 1 ELSE 0 END, p.idle_seconds
		  FROM edge, matches mt
		  JOIN match_players p ON p.match_id = mt.id AND p.server_id = mt.server_id
		  CROSS JOIN LATERAL (SELECT match_result(mt.final_scores, mt.winner, p.faction) AS r) x
		 WHERE mt.server_id IN ${ids} AND mt.ended_at >= edge.f AND mt.ended_at < edge.m1),
	player AS (
		SELECT steam_id, SUM(n) AS n, SUM(sec) AS sec, SUM(cs) AS cs, SUM(seed) AS seed, MAX(ls) AS ls,
		       SUM(cash) AS cash, SUM(m) AS m, SUM(kills) AS kills, SUM(deaths) AS deaths,
		       SUM(headshots) AS headshots, SUM(team_kills) AS team_kills, SUM(suicides) AS suicides,
		       SUM(vehicle_kills) AS vehicle_kills, MAX(kill_streak) FILTER (WHERE m > 0) AS kill_streak,
		       MAX(death_streak) FILTER (WHERE m > 0) AS death_streak,
		       SUM(wins) AS wins, SUM(losses) AS losses, SUM(draws) AS draws, SUM(idle) AS idle
		  FROM parts GROUP BY steam_id HAVING SUM(n) > 0 OR SUM(m) > 0),
	base AS (
		SELECT steam_id,
		       CASE WHEN n > 0 THEN sec / 60 ELSE 0 END AS minutes,
		       CASE WHEN n > 0 THEN cs / 60 ELSE 0 END AS cash_minutes,
		       CASE WHEN n > 0 THEN seed / 60.0 ELSE 0 END AS seed_minutes,
		       CASE WHEN n > 0 THEN cash ELSE 0 END AS cash, CASE WHEN n > 0 THEN ls END AS last_seen,
		       CASE WHEN m > 0 THEN kills ELSE 0 END AS kills, CASE WHEN m > 0 THEN deaths ELSE 0 END AS deaths,
		       CASE WHEN m > 0 THEN headshots ELSE 0 END AS headshots,
		       CASE WHEN m > 0 THEN team_kills ELSE 0 END AS team_kills,
		       CASE WHEN m > 0 THEN suicides ELSE 0 END AS suicides,
		       CASE WHEN m > 0 THEN vehicle_kills ELSE 0 END AS vehicle_kills,
		       CASE WHEN m > 0 THEN kill_streak ELSE 0 END AS kill_streak,
		       CASE WHEN m > 0 THEN death_streak ELSE 0 END AS death_streak,
		       CASE WHEN m > 0 THEN m ELSE 0 END AS matches, CASE WHEN m > 0 THEN wins ELSE 0 END AS wins,
		       CASE WHEN m > 0 THEN losses ELSE 0 END AS losses, CASE WHEN m > 0 THEN draws ELSE 0 END AS draws,
		       CASE WHEN m > 0 THEN idle / 60.0 ELSE 0 END AS idle_minutes
		  FROM player)`;

/**
 * Per-player totals over these servers from `from` to `to` (a finished season), from the same day
 * rows: the first day as rangeBase reads it, every UTC day after it and before to's (Dt) in full,
 * and Dt read here: the sessions that left on it and those that crossed into the next day (their
 * joins are kept on that day's row), each up to `to`, and the lines of matches that ended on it
 * before `to`. When `to` falls on from's own day, or at its end, only the first day is read, up
 * to `to`. The sessions still open count up to `to`. A session is in the season when it left in
 * it or was still going at its end; its seed time and cash go where it left, as the day rows keep
 * them, so one still going at `to` gives the season its time and nothing else. `cash_minutes` is
 * the whole time of the sessions the cash came from, as in rangeBase: the time before `from` of
 * one that left in the season counts, and none of one still going at `to`. A crossing into D1
 * adds its time from its join to that midnight once `to` is past it; one into the day after Dt,
 * or one that left on Dt after `to`, takes back what D1's crossing and the day rows gave it, its
 * time from its join, or D1, to Dt's midnight. Last seen has no meaning for a finished season
 * and is left empty. Read against oracleSeasonBase by the exactness test.
 */
export const seasonBase = (ids: string[], from: Date, to: Date) => sql`
	edge AS (
		SELECT *, t > m1 AS late
		  FROM (SELECT f, t, d1, d1::timestamp AT TIME ZONE 'UTC' AS m1, dt, dt::timestamp AT TIME ZONE 'UTC' AS mt,
		               (dt + 1)::timestamp AT TIME ZONE 'UTC' AS mn
		          FROM (SELECT ${from}::timestamptz AS f, ${to}::timestamptz AS t,
		                       (${from}::timestamptz AT TIME ZONE 'UTC')::date + 1 AS d1,
		                       (${to}::timestamptz AT TIME ZONE 'UTC')::date AS dt) a) b),
	parts AS (
		SELECT d.steam_id, d.sessions AS n, d.seconds AS sec, d.seconds AS cs, d.seed_seconds AS seed, d.cash,
		       d.matches AS m, d.kills, d.deaths, d.headshots, d.team_kills, d.suicides, d.vehicle_kills,
		       d.kill_streak, d.death_streak, d.wins, d.losses, d.draws, d.idle_seconds AS idle
		  FROM player_days d, edge WHERE d.server_id IN ${ids} AND d.day >= edge.d1 AND d.day < edge.dt
		UNION ALL
		SELECT d.steam_id, 0, EXTRACT(EPOCH FROM (LEAST(edge.m1, edge.t) - GREATEST(j, edge.f))),
		       CASE WHEN edge.late THEN EXTRACT(EPOCH FROM (edge.m1 - j)) ELSE 0 END, 0, 0,
		       0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
		  FROM player_days d CROSS JOIN edge CROSS JOIN LATERAL unnest(d.crossings) j
		 WHERE d.server_id IN ${ids} AND d.day = edge.d1 AND d.crossings IS NOT NULL AND j < edge.t
		UNION ALL
		SELECT s.steam_id, CASE WHEN s.left_at < edge.t THEN 1 ELSE 0 END,
		       EXTRACT(EPOCH FROM (LEAST(s.left_at, edge.t) - GREATEST(s.joined_at, edge.f))),
		       CASE WHEN s.left_at < edge.t THEN EXTRACT(EPOCH FROM (s.left_at - s.joined_at)) ELSE 0 END,
		       CASE WHEN s.left_at < edge.t THEN s.seed_seconds ELSE 0 END,
		       CASE WHEN s.left_at < edge.t THEN s.cash ELSE 0 END, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
		  FROM player_sessions s, edge
		 WHERE s.server_id IN ${ids} AND s.left_at >= edge.f AND s.left_at < edge.m1
		   AND (s.left_at < edge.t OR s.joined_at < edge.t)
		UNION ALL
		SELECT d.steam_id, 0, EXTRACT(EPOCH FROM (edge.t - GREATEST(j, edge.mt))),
		       -GREATEST(EXTRACT(EPOCH FROM (edge.mt - j)), 0), 0, 0,
		       0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
		  FROM player_days d CROSS JOIN edge CROSS JOIN LATERAL unnest(d.crossings) j
		 WHERE edge.late AND d.server_id IN ${ids} AND d.day = edge.dt + 1 AND d.crossings IS NOT NULL
		   AND j < edge.t
		UNION ALL
		SELECT s.steam_id, CASE WHEN s.left_at < edge.t THEN 1 ELSE 0 END,
		       EXTRACT(EPOCH FROM (LEAST(s.left_at, edge.t) - GREATEST(s.joined_at, edge.mt))),
		       CASE WHEN s.left_at < edge.t THEN EXTRACT(EPOCH FROM (s.left_at - GREATEST(s.joined_at, edge.mt)))
		            ELSE -GREATEST(EXTRACT(EPOCH FROM (edge.mt - s.joined_at)), 0) END,
		       CASE WHEN s.left_at < edge.t THEN s.seed_seconds ELSE 0 END,
		       CASE WHEN s.left_at < edge.t THEN s.cash ELSE 0 END, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
		  FROM player_sessions s, edge
		 WHERE edge.late AND s.server_id IN ${ids} AND s.left_at >= edge.mt AND s.left_at < edge.mn
		   AND (s.left_at < edge.t OR s.joined_at < edge.t)
		UNION ALL
		SELECT s.steam_id, 1, EXTRACT(EPOCH FROM (LEAST(now(), edge.t) - GREATEST(s.joined_at, edge.f))),
		       0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0
		  FROM player_sessions s, edge
		 WHERE s.server_id IN ${ids} AND s.left_at IS NULL AND s.last_seen >= edge.f
		   AND s.joined_at < edge.t
		UNION ALL
		SELECT p.steam_id, 0, 0, 0, 0, 0, 1, p.kills, p.deaths, p.headshots, p.team_kills, p.suicides,
		       p.vehicle_kills, p.kill_streak, p.death_streak, CASE WHEN x.r = 'win' THEN 1 ELSE 0 END,
		       CASE WHEN x.r = 'loss' THEN 1 ELSE 0 END, CASE WHEN x.r = 'draw' THEN 1 ELSE 0 END, p.idle_seconds
		  FROM edge, matches mt
		  JOIN match_players p ON p.match_id = mt.id AND p.server_id = mt.server_id
		  CROSS JOIN LATERAL (SELECT match_result(mt.final_scores, mt.winner, p.faction) AS r) x
		 WHERE mt.server_id IN ${ids}
		   AND ((mt.ended_at >= edge.f AND mt.ended_at < LEAST(edge.m1, edge.t))
		        OR (edge.late AND mt.ended_at >= edge.mt AND mt.ended_at < edge.t))),
	player AS (
		SELECT steam_id, SUM(n) AS n, SUM(sec) AS sec, SUM(cs) AS cs, SUM(seed) AS seed, SUM(cash) AS cash,
		       SUM(m) AS m, SUM(kills) AS kills, SUM(deaths) AS deaths, SUM(headshots) AS headshots,
		       SUM(team_kills) AS team_kills, SUM(suicides) AS suicides, SUM(vehicle_kills) AS vehicle_kills,
		       MAX(kill_streak) FILTER (WHERE m > 0) AS kill_streak,
		       MAX(death_streak) FILTER (WHERE m > 0) AS death_streak,
		       SUM(wins) AS wins, SUM(losses) AS losses, SUM(draws) AS draws, SUM(idle) AS idle
		  FROM parts GROUP BY steam_id HAVING SUM(n) > 0 OR SUM(sec) <> 0 OR SUM(m) > 0),
	base AS (
		SELECT steam_id,
		       CASE WHEN n > 0 OR sec <> 0 THEN sec / 60 ELSE 0 END AS minutes,
		       CASE WHEN n > 0 OR sec <> 0 THEN cs / 60 ELSE 0 END AS cash_minutes,
		       CASE WHEN n > 0 OR sec <> 0 THEN seed / 60.0 ELSE 0 END AS seed_minutes,
		       CASE WHEN n > 0 OR sec <> 0 THEN cash ELSE 0 END AS cash, NULL::timestamptz AS last_seen,
		       CASE WHEN m > 0 THEN kills ELSE 0 END AS kills, CASE WHEN m > 0 THEN deaths ELSE 0 END AS deaths,
		       CASE WHEN m > 0 THEN headshots ELSE 0 END AS headshots,
		       CASE WHEN m > 0 THEN team_kills ELSE 0 END AS team_kills,
		       CASE WHEN m > 0 THEN suicides ELSE 0 END AS suicides,
		       CASE WHEN m > 0 THEN vehicle_kills ELSE 0 END AS vehicle_kills,
		       CASE WHEN m > 0 THEN kill_streak ELSE 0 END AS kill_streak,
		       CASE WHEN m > 0 THEN death_streak ELSE 0 END AS death_streak,
		       CASE WHEN m > 0 THEN m ELSE 0 END AS matches, CASE WHEN m > 0 THEN wins ELSE 0 END AS wins,
		       CASE WHEN m > 0 THEN losses ELSE 0 END AS losses, CASE WHEN m > 0 THEN draws ELSE 0 END AS draws,
		       CASE WHEN m > 0 THEN idle / 60.0 ELSE 0 END AS idle_minutes
		  FROM player)`;

/**
 * The base rows for all time, from the settled totals: `sess` is the pairs with a closed session
 * plus the open sessions, `mt` the pairs with a line of an ended match, then the join of the reads
 * before player_totals. The same rows and values as they gave: the seconds are exact numeric sums,
 * and a player with no session at all still gets the join's zeros. All time has no edge, so the
 * time behind the cash is the playtime. Also read by the exactness test
 * (src/test/player-totals.test.ts).
 */
export const totalsBase = (ids: string[], steamIds: string[] | null = null) => sql`
	sess AS (
		SELECT steam_id, SUM(seconds) / 60 AS minutes, SUM(seed_seconds) / 60.0 AS seed_minutes,
		       MAX(last_seen) AS last_seen, SUM(cash) AS cash
		  FROM (SELECT steam_id, seconds, seed_seconds, cash, last_seen FROM player_totals
		         WHERE server_id IN ${ids} AND sessions > 0
		           ${steamIds === null ? sql`` : sql`AND steam_id IN ${steamIds}`}
		        UNION ALL
		        SELECT steam_id, EXTRACT(EPOCH FROM (now() - joined_at)), seed_seconds, cash, last_seen
		          FROM player_sessions WHERE server_id IN ${ids} AND left_at IS NULL
		           ${steamIds === null ? sql`` : sql`AND steam_id IN ${steamIds}`}) s
		 GROUP BY steam_id),
	mt AS (
		SELECT steam_id, SUM(matches) AS matches,
		       SUM(kills) AS kills, SUM(deaths) AS deaths, SUM(headshots) AS headshots,
		       SUM(team_kills) AS team_kills, SUM(suicides) AS suicides, SUM(vehicle_kills) AS vehicle_kills,
		       MAX(kill_streak) AS kill_streak, MAX(death_streak) AS death_streak,
		       SUM(wins) AS wins, SUM(losses) AS losses, SUM(draws) AS draws,
		       SUM(idle_seconds) / 60.0 AS idle_minutes
		  FROM player_totals WHERE server_id IN ${ids} AND matches > 0
		   ${steamIds === null ? sql`` : sql`AND steam_id IN ${steamIds}`}
		 GROUP BY steam_id),
	base AS (
		SELECT steam_id,
		       COALESCE(sess.minutes, 0) AS minutes, COALESCE(sess.minutes, 0) AS cash_minutes,
		       COALESCE(sess.seed_minutes, 0) AS seed_minutes, COALESCE(sess.cash, 0) AS cash, sess.last_seen,
		       COALESCE(mt.kills, 0) AS kills, COALESCE(mt.deaths, 0) AS deaths,
		       COALESCE(mt.headshots, 0) AS headshots, COALESCE(mt.team_kills, 0) AS team_kills,
		       COALESCE(mt.suicides, 0) AS suicides, COALESCE(mt.vehicle_kills, 0) AS vehicle_kills,
		       COALESCE(mt.kill_streak, 0) AS kill_streak, COALESCE(mt.death_streak, 0) AS death_streak,
		       COALESCE(mt.matches, 0) AS matches, COALESCE(mt.wins, 0) AS wins,
		       COALESCE(mt.losses, 0) AS losses, COALESCE(mt.draws, 0) AS draws,
		       COALESCE(mt.idle_minutes, 0) AS idle_minutes
		  FROM sess FULL JOIN mt USING (steam_id))`;

/** All recorded games on these servers, batched for the connected-player risk badges. */
export async function riskPerformanceFor(
	env: Env,
	serverIds: string[],
	steamIds: string[]
): Promise<Map<string, RiskPerformance>> {
	const result = new Map<string, RiskPerformance>();
	if (!serverIds.length || !steamIds.length) return result;
	const blank = (): RiskPerformance => ({
		matches: 0,
		wins: 0,
		losses: 0,
		draws: 0,
		kills: 0,
		deaths: 0,
		feedKills: 0,
		headshots: 0
	});
	const [feed, played] = await Promise.all([
		env.db.execute<{ steamId: string; feedKills: string; headshots: string }>(sql`
			SELECT killer_steam_id AS "steamId",
			       COUNT(*) FILTER (WHERE NOT suicide) AS "feedKills",
			       COUNT(*) FILTER (WHERE headshot AND NOT suicide) AS headshots
			  FROM kills WHERE server_id IN ${serverIds} AND killer_steam_id IN ${steamIds}
			 GROUP BY killer_steam_id`),
		env.db.execute<{
			steamId: string;
			matches: string;
			wins: string;
			losses: string;
			draws: string;
			kills: string;
			deaths: string;
		}>(sql`
			SELECT steam_id AS "steamId", SUM(matches) AS matches, SUM(wins) AS wins,
			       SUM(losses) AS losses, SUM(draws) AS draws, SUM(kills) AS kills, SUM(deaths) AS deaths
			  FROM player_totals WHERE server_id IN ${serverIds} AND steam_id IN ${steamIds}
			 GROUP BY steam_id HAVING SUM(matches) > 0`)
	]);
	const of = (steamId: string) => {
		let value = result.get(steamId);
		if (!value) result.set(steamId, (value = blank()));
		return value;
	};
	for (const row of feed)
		Object.assign(of(row.steamId), {
			feedKills: num(row.feedKills),
			headshots: num(row.headshots)
		});
	for (const row of played)
		Object.assign(of(row.steamId), {
			matches: num(row.matches),
			wins: num(row.wins),
			losses: num(row.losses),
			draws: num(row.draws),
			kills: num(row.kills),
			deaths: num(row.deaths)
		});
	return result;
}

/** How each metric orders the board (see metricValue in $lib/leaderboard). */
const METRIC_SQL: Record<BoardMetric, ReturnType<typeof sql>> = {
	kills: sql`kills`,
	deaths: sql`deaths`,
	kd: sql`CASE WHEN deaths > 0 THEN kills::float / deaths WHEN kills > 0 THEN kills::float ELSE NULL END`,
	// as perHour and perMinute in $lib/leaderboard: seed time and idle time both count the wait for
	// players, so the larger goes
	perHour: sql`CASE WHEN minutes - GREATEST(seed_minutes, idle_minutes) > 0
	                  THEN kills::float / ((minutes - GREATEST(seed_minutes, idle_minutes)) / 60) ELSE NULL END`,
	playtime: sql`minutes`,
	seeded: sql`seed_minutes`,
	matches: sql`matches`,
	wins: sql`wins`,
	winRate: sql`CASE WHEN wins + losses + draws > 0 THEN wins::float / (wins + losses + draws) ELSE NULL END`,
	cash: sql`cash`,
	cashPerMin: sql`CASE WHEN cash_minutes - GREATEST(seed_minutes, idle_minutes) > 0
	                     THEN cash::float / (cash_minutes - GREATEST(seed_minutes, idle_minutes)) ELSE NULL END`
};

interface BaseRow extends Record<string, unknown> {
	steamId: string;
	name: string | null;
	minutes: string;
	cashMinutes: string;
	seedMinutes: string;
	idleMinutes: string;
	cash: string;
	lastSeen: Date | null;
	kills: string;
	headshots: string;
	teamKills: string;
	deaths: string;
	suicides: string;
	vehicleKills: string;
	killStreak: string;
	deathStreak: string;
	matches: string;
	wins: string;
	losses: string;
	draws: string;
	total: string;
}

/** Whether any of these servers has a kill feed (without one the feed's columns stay at zero). */
async function anyFeed(env: Env, ids: string[]): Promise<boolean> {
	if (!ids.length) return false;
	const [row] = await env.db
		.select({ n: sql<number>`COUNT(*)` })
		.from(servers)
		.where(sql`${servers.id} IN ${ids} AND ${servers.feedTokenHash} IS NOT NULL`);
	return num(row?.n) > 0;
}

/** The most rows an export writes: the top ten thousand of the board as it is set. */
export const EXPORT_ROWS = 10_000;

/**
 * The base rows of a board's window: all time from the totals, a range or a season still running
 * from the day rows to now, a finished season from the day rows to its end.
 */
const windowBase = (ids: string[], win: BoardWindow) =>
	win.from === null
		? totalsBase(ids)
		: win.to === null
			? rangeBase(ids, win.from)
			: seasonBase(ids, win.from, win.to);

/**
 * `limit` rows of the board as `q` sets it (scope, sort, floor) over the window, from `offset`:
 * the aggregate covers the whole window either way, then the page, or an export, takes its slice.
 */
async function boardSlice(
	env: Env,
	ids: string[],
	q: BoardQuery,
	win: BoardWindow,
	limit: number,
	offset: number
): Promise<BaseRow[]> {
	const order = q.dir === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
	return (await env.db.execute<BaseRow>(sql`
		WITH ${windowBase(ids, win)},
		page AS (
			SELECT *, COUNT(*) OVER () AS total FROM base
			 WHERE minutes >= ${q.minMinutes}
			 ORDER BY ${METRIC_SQL[q.sort]} ${order}, kills DESC, steam_id
			 LIMIT ${limit} OFFSET ${offset})
		SELECT r.steam_id AS "steamId", r.minutes, r.cash_minutes AS "cashMinutes", r.seed_minutes AS "seedMinutes",
		       r.idle_minutes AS "idleMinutes", r.cash, r.last_seen AS "lastSeen",
		       r.kills, r.headshots, r.team_kills AS "teamKills", r.deaths, r.suicides,
		       r.vehicle_kills AS "vehicleKills", r.kill_streak AS "killStreak", r.death_streak AS "deathStreak",
		       r.matches, r.wins, r.losses, r.draws, r.total,
		       (SELECT name FROM player_sessions ps WHERE ps.steam_id = r.steam_id AND ps.server_id IN ${ids}
		         ORDER BY ps.joined_at DESC, ps.id DESC LIMIT 1) AS name
		  FROM page r`)) as BaseRow[];
}

/**
 * A page of a board is the same for everyone who may see these servers, and each one is an
 * aggregate over its whole window: each (servers, window, query) is read once a minute per web
 * process, and the requests that ask for it while it is being read wait for that read. The key is
 * the server ids the caller's own check settled on, so a board over servers someone was not given
 * is never theirs, and the window the range resolved to, so a season that has just finished is
 * read again as such. A minute behind is the price: a match that just ended may not be on it yet.
 */
const BOARD_TTL_MS = 60_000;
/** The most pages kept: fifty rows each, a few megabytes at most. */
const BOARD_CACHE_MAX = 500;
/** A page as it is kept: what the board's window and query read. */
type BoardPage = Omit<BoardView, 'query' | 'when' | 'seasons'>;
const boardCache = new Map<
	string,
	{ ids: string[]; until: number; view: Promise<BoardPage>; read: boolean }
>();

/** Forgets the boards and winners kept over this server (its stats were purged), or all of them. */
export function forgetBoards(serverId?: string): void {
	for (const [key, hit] of boardCache)
		if (serverId === undefined || hit.ids.includes(serverId)) boardCache.delete(key);
	for (const [key, hit] of winnersCache)
		if (serverId === undefined || hit.ids.includes(serverId)) winnersCache.delete(key);
}

/**
 * One page of the board over these servers, which are the organisation's (`orgId`): its seasons
 * name the window a season's range reads, and what its boards open on decides `current`.
 */
export async function loadBoard(
	env: Env,
	ids: string[],
	q: BoardQuery,
	orgId: string
): Promise<BoardView> {
	const now = Date.now();
	const os = await orgSeasons(env, orgId);
	const win = resolveWindow(q.range, os, now);
	const head = {
		query: q,
		when: { range: win.range, season: win.season, finished: win.finished },
		seasons: pickable(os, now)
	};
	if (!ids.length)
		return { ...head, rows: [], total: 0, pageSize: BOARD_PAGE, hasFeed: false, winners: null };
	const sorted = [...new Set(ids)].sort();
	const key = JSON.stringify([
		sorted,
		q.scope,
		win.range,
		win.finished,
		q.sort,
		q.dir,
		q.page,
		q.minMinutes
	]);
	const hit = boardCache.get(key);
	if (hit && hit.until > now) {
		boardReads.inc({ outcome: hit.read ? 'hit' : 'shared' });
		return { ...(await hit.view), ...head };
	}
	boardReads.inc({ outcome: 'miss' });
	const entry = {
		ids: sorted,
		until: now + BOARD_TTL_MS,
		view: readBoard(env, sorted, q, win),
		read: false
	};
	boardCache.delete(key);
	boardCache.set(key, entry);
	// A failed read is not kept: the next request reads again.
	entry.view.then(
		() => (entry.read = true),
		() => {
			if (boardCache.get(key) === entry) boardCache.delete(key);
		}
	);
	if (boardCache.size > BOARD_CACHE_MAX) {
		for (const [k, e] of boardCache) if (e.until <= now) boardCache.delete(k);
		for (const k of boardCache.keys()) {
			if (boardCache.size <= BOARD_CACHE_MAX) break;
			boardCache.delete(k);
		}
	}
	return { ...(await entry.view), ...head };
}

async function readBoard(
	env: Env,
	ids: string[],
	q: BoardQuery,
	win: BoardWindow
): Promise<BoardPage> {
	const offset = (q.page - 1) * BOARD_PAGE;
	const [rows, hasFeed, winners] = await Promise.all([
		boardSlice(env, ids, q, win, BOARD_PAGE, offset),
		anyFeed(env, ids),
		win.finished && win.from && win.to ? seasonWinners(env, ids, win.from, win.to) : null
	]);
	return {
		rows: rows.map((r, i) => shapeRow(r, offset + i + 1)),
		total: rows.length ? num(rows[0].total) : 0,
		pageSize: BOARD_PAGE,
		hasFeed,
		winners
	};
}

/**
 * The board as `q` sets it over the window from the top, every page of it up to EXPORT_ROWS;
 * `q.page` and `q.range` are ignored (the caller resolved the range to `win`).
 */
export async function exportBoard(
	env: Env,
	ids: string[],
	q: BoardQuery,
	win: BoardWindow
): Promise<BoardRow[]> {
	if (!ids.length) return [];
	return (await boardSlice(env, ids, q, win, EXPORT_ROWS, 0)).map((r, i) => shapeRow(r, i + 1));
}

/**
 * A finished season's winners over these servers, from the same rows as its board (without the
 * board's playtime floor), so a winner's numbers are the ones the board shows them. Kept for a
 * minute, as its board is, in the season's first day (a session the worker closes late, after an
 * outage, can still land in it), then for an hour: every board and career of a finished season
 * asks. A purge forgets them (forgetBoards).
 */
const WINNERS_FRESH_MS = 86_400_000;
const WINNERS_TTL_MS = 3_600_000;
const WINNERS_CACHE_MAX = 2_000;
const winnersCache = new Map<
	string,
	{ ids: string[]; until: number; value: Promise<SeasonWinners> }
>();

function seasonWinners(env: Env, ids: string[], from: Date, to: Date): Promise<SeasonWinners> {
	const sorted = [...new Set(ids)].sort();
	const key = JSON.stringify([sorted, from.toISOString(), to.toISOString()]);
	const now = Date.now();
	const hit = winnersCache.get(key);
	if (hit && hit.until > now) return hit.value;
	const ttl = now - to.getTime() < WINNERS_FRESH_MS ? BOARD_TTL_MS : WINNERS_TTL_MS;
	const entry = { ids: sorted, until: now + ttl, value: readWinners(env, sorted, from, to) };
	winnersCache.delete(key);
	winnersCache.set(key, entry);
	entry.value.catch(() => {
		if (winnersCache.get(key) === entry) winnersCache.delete(key);
	});
	if (winnersCache.size > WINNERS_CACHE_MAX) {
		for (const [k, e] of winnersCache) if (e.until <= now) winnersCache.delete(k);
		for (const k of winnersCache.keys()) {
			if (winnersCache.size <= WINNERS_CACHE_MAX) break;
			winnersCache.delete(k);
		}
	}
	return entry.value;
}

/**
 * The top three in each category: most kills (fewer deaths first on a tie), the best K/D among
 * players with at least WINNER_MIN_MATCHES matches (more kills first), most playtime, most wins
 * (fewer matches first); each with the name the board shows.
 */
async function readWinners(env: Env, ids: string[], from: Date, to: Date): Promise<SeasonWinners> {
	interface Place extends Record<string, unknown> {
		cat: WinnerCategory;
		steamId: string;
		value: number;
		name: string | null;
	}
	const rows = (await env.db.execute<Place>(sql`
		WITH ${seasonBase(ids, from, to)},
		top AS (
			SELECT 'kills' AS cat, steam_id, kills::float AS value,
			       ROW_NUMBER() OVER (ORDER BY kills DESC, deaths, steam_id) AS place
			  FROM base WHERE kills > 0
			UNION ALL
			SELECT 'kd', steam_id, ${METRIC_SQL.kd},
			       ROW_NUMBER() OVER (ORDER BY ${METRIC_SQL.kd} DESC, kills DESC, steam_id)
			  FROM base WHERE kills > 0 AND matches >= ${WINNER_MIN_MATCHES}
			UNION ALL
			SELECT 'playtime', steam_id, minutes::float, ROW_NUMBER() OVER (ORDER BY minutes DESC, steam_id)
			  FROM base WHERE minutes > 0
			UNION ALL
			SELECT 'wins', steam_id, wins::float, ROW_NUMBER() OVER (ORDER BY wins DESC, matches, steam_id)
			  FROM base WHERE wins > 0)
		SELECT t.cat, t.steam_id AS "steamId", t.value,
		       (SELECT name FROM player_sessions ps WHERE ps.steam_id = t.steam_id AND ps.server_id IN ${ids}
		         ORDER BY ps.joined_at DESC, ps.id DESC LIMIT 1) AS name
		  FROM top t WHERE t.place <= 3 ORDER BY t.cat, t.place`)) as Place[];
	const out: SeasonWinners = { kills: [], kd: [], playtime: [], wins: [] };
	for (const r of rows)
		out[r.cat].push({ steamId: r.steamId, name: r.name || r.steamId, value: num(r.value) });
	return out;
}

const shapeRow = (r: BaseRow, rank: number): BoardRow => ({
	rank,
	steamId: r.steamId,
	name: r.name || r.steamId,
	minutes: Math.round(num(r.minutes)),
	cashMinutes: Math.round(num(r.cashMinutes)),
	seedMinutes: Math.round(num(r.seedMinutes)),
	idleMinutes: Math.round(num(r.idleMinutes)),
	kills: num(r.kills),
	deaths: num(r.deaths),
	headshots: num(r.headshots),
	teamKills: num(r.teamKills),
	suicides: num(r.suicides),
	vehicleKills: num(r.vehicleKills),
	killStreak: num(r.killStreak),
	deathStreak: num(r.deathStreak),
	matches: num(r.matches),
	wins: num(r.wins),
	losses: num(r.losses),
	draws: num(r.draws),
	cash: num(r.cash),
	lastSeen: iso(r.lastSeen)
});

/**
 * These players' lines on the all-time board over these servers (one server's, or its
 * organisation's), the numbers that board shows them, for the message placeholders. A player
 * those servers have no record of has no entry.
 */
export async function playerStats(
	env: Env,
	ids: string[],
	steamIds: string[]
): Promise<Map<string, PlayerStats>> {
	const out = new Map<string, PlayerStats>();
	if (!ids.length || !steamIds.length) return out;
	const rows = await env.db.execute<{
		steamId: string;
		minutes: string;
		seedMinutes: string;
		kills: string;
		deaths: string;
		matches: string;
		wins: string;
		losses: string;
		draws: string;
	}>(sql`
		WITH ${totalsBase(ids, steamIds)}
		SELECT steam_id AS "steamId", minutes, seed_minutes AS "seedMinutes", kills, deaths,
		       matches, wins, losses, draws
		  FROM base`);
	for (const r of rows)
		out.set(r.steamId, {
			kills: num(r.kills),
			deaths: num(r.deaths),
			minutes: num(r.minutes),
			seedMinutes: num(r.seedMinutes),
			matches: num(r.matches),
			wins: num(r.wins),
			losses: num(r.losses),
			draws: num(r.draws)
		});
	return out;
}

/** The name the player was last seen with on these servers; null when never seen there. */
export async function lastNameOf(env: Env, ids: string[], steamId: string): Promise<string | null> {
	if (!ids.length) return null;
	const [row] = await env.db.execute<{ name: string }>(sql`
		SELECT name FROM player_sessions WHERE steam_id = ${steamId} AND server_id IN ${ids}
		 ORDER BY joined_at DESC, id DESC LIMIT 1`);
	return row?.name ?? null;
}

/**
 * The player's position on the all-time kills board over these servers at the default floor:
 * one more than the players above them; null when they are under the floor or unknown.
 */
export async function rankOf(env: Env, ids: string[], steamId: string): Promise<number | null> {
	if (!ids.length) return null;
	const [row] = await env.db.execute<{ qualifies: boolean | null; above: string }>(sql`
		WITH ${totalsBase(ids)},
		me AS (SELECT kills, minutes FROM base WHERE steam_id = ${steamId})
		SELECT (SELECT minutes >= ${DEFAULT_FLOOR_MINUTES} FROM me) AS qualifies,
		       (SELECT COUNT(*) FROM base, me WHERE base.minutes >= ${DEFAULT_FLOOR_MINUTES} AND base.kills > me.kills) AS above`);
	return row?.qualifies ? num(row.above) + 1 : null;
}

interface LineRow extends Record<string, unknown> {
	matchId: string;
	serverId: string;
	startedAt: Date;
	endedAt: Date | null;
	map: string | null;
	faction: string | null;
	result: MatchResult;
	seconds: string;
	kills: string;
	deaths: string;
	cashDelta: string;
	headshots: string;
	vehicleKills: string;
	longestM: string | null;
	killStreak: string;
	deathStreak: string;
}

/** A career lists the organisation's last ten seasons that have started. */
const CAREER_SEASONS = 10;

/**
 * The organisation's last seasons that have started, newest first, each finished one with its
 * winners on this server's board (`own`: the server, or nobody when the caller may not see it).
 */
async function careerSeasons(
	env: Env,
	orgId: string,
	own: string[]
): Promise<{ season: Season; winners: SeasonWinners | null }[]> {
	const now = Date.now();
	const started = pickable(await orgSeasons(env, orgId), now).slice(0, CAREER_SEASONS);
	return Promise.all(
		started.map(async (season) => ({
			season,
			winners:
				own.length && isFinished(season, now)
					? await seasonWinners(env, own, new Date(season.startsAt), new Date(season.endsAt!))
					: null
		}))
	);
}

/**
 * A player's career over these servers (all time): rank here and across the organisation, the
 * streak, the totals, results by map and by faction, the last ten matches and the organisation's
 * last seasons, all from the player's match lines, with the places they won in each finished
 * season on this server's board.
 */
export async function loadCareer(
	env: Env,
	opts: {
		serverId: string;
		orgId: string;
		ids: string[];
		nameOf: Map<string, string>;
		steamId: string;
	}
): Promise<CareerView> {
	const { serverId, ids, steamId } = opts;
	const own = ids.includes(serverId) ? [serverId] : [];
	const [serverRank, orgRank, seasons, linesRaw] = await Promise.all([
		rankOf(env, own, steamId),
		rankOf(env, ids, steamId),
		careerSeasons(env, opts.orgId, own),
		ids.length
			? env.db.execute<LineRow>(sql`
				WITH ${lines(ids, EPOCH, steamId)}
				SELECT match_id AS "matchId", server_id AS "serverId", started_at AS "startedAt", ended_at AS "endedAt",
				       map, faction, result, seconds, kills, deaths, cash_delta AS "cashDelta", headshots,
				       vehicle_kills AS "vehicleKills", longest_m AS "longestM", kill_streak AS "killStreak", death_streak AS "deathStreak"
				  FROM lines ORDER BY started_at DESC, match_id DESC`)
			: Promise.resolve<LineRow[]>([])
	]);
	const rows = (linesRaw as LineRow[]).map((r) => ({
		matchId: Number(r.matchId),
		serverId: r.serverId,
		serverName: opts.nameOf.get(r.serverId) || r.serverId,
		startedAt: new Date(r.startedAt).toISOString(),
		endedAt: iso(r.endedAt),
		map: r.map,
		faction: r.faction,
		result: r.result,
		seconds: num(r.seconds),
		kills: num(r.kills),
		deaths: num(r.deaths),
		cashDelta: num(r.cashDelta),
		headshots: num(r.headshots),
		vehicleKills: num(r.vehicleKills),
		longestM: r.longestM === null ? null : num(r.longestM),
		killStreak: num(r.killStreak),
		deathStreak: num(r.deathStreak)
	}));
	const count = (kind: MatchResult) => rows.filter((r) => r.result === kind).length;
	const sum = (pick: (r: (typeof rows)[number]) => number) => rows.reduce((n, r) => n + pick(r), 0);
	const max = (pick: (r: (typeof rows)[number]) => number) =>
		rows.reduce((n, r) => Math.max(n, pick(r)), 0);
	const longest = rows.reduce<number | null>(
		(n, r) => (r.longestM === null ? n : n === null ? r.longestM : Math.max(n, r.longestM)),
		null
	);
	const last: CareerMatch[] = rows.slice(0, 10).map((r) => ({
		matchId: r.matchId,
		serverId: r.serverId,
		serverName: r.serverName,
		startedAt: r.startedAt,
		endedAt: r.endedAt,
		map: r.map,
		faction: r.faction,
		result: r.result,
		seconds: r.seconds,
		kills: r.kills,
		deaths: r.deaths,
		cashDelta: r.cashDelta,
		headshots: r.headshots,
		killStreak: r.killStreak
	}));
	const careerSeason = (season: Season, winners: SeasonWinners | null): CareerSeason => {
		const from = Date.parse(season.startsAt);
		const to = season.endsAt === null ? Infinity : Date.parse(season.endsAt);
		const inIt = rows.filter((r) => {
			const at = r.endedAt === null ? NaN : Date.parse(r.endedAt);
			return at >= from && at < to;
		});
		const places: CareerPlace[] = [];
		for (const [category, list] of Object.entries(winners ?? {}) as [
			WinnerCategory,
			SeasonWinners[WinnerCategory]
		][]) {
			const i = list.findIndex((w) => w.steamId === steamId);
			if (i >= 0) places.push({ category, place: i + 1 });
		}
		return {
			season,
			matches: inIt.length,
			wins: inIt.filter((r) => r.result === 'win').length,
			losses: inIt.filter((r) => r.result === 'loss').length,
			draws: inIt.filter((r) => r.result === 'draw').length,
			kills: inIt.reduce((n, r) => n + r.kills, 0),
			deaths: inIt.reduce((n, r) => n + r.deaths, 0),
			places: places.sort((a, b) => a.place - b.place)
		};
	};
	return {
		rank: { server: serverRank, org: orgRank, floorMinutes: DEFAULT_FLOOR_MINUTES },
		streak: streak(rows.map((r) => r.result)),
		matches: rows.length,
		wins: count('win'),
		losses: count('loss'),
		draws: count('draw'),
		kills: sum((r) => r.kills),
		deaths: sum((r) => r.deaths),
		minutes: Math.round(sum((r) => r.seconds) / 60),
		headshots: sum((r) => r.headshots),
		vehicleKills: sum((r) => r.vehicleKills),
		longestM: longest,
		killStreak: max((r) => r.killStreak),
		deathStreak: max((r) => r.deathStreak),
		maps: groupCareer(
			rows.map((r) => ({ key: r.map, result: r.result, kills: r.kills, deaths: r.deaths }))
		),
		factions: groupCareer(
			rows.map((r) => ({ key: r.faction, result: r.result, kills: r.kills, deaths: r.deaths }))
		),
		last,
		seasons: seasons.map((s) => careerSeason(s.season, s.winners))
	};
}
