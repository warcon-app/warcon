// The all-time and ranged reads as they were before player_totals and player_days (main at
// edf2aab), word for word, for the exactness tests to hold the totals against: each sums every
// session and every line of an ended match on the servers asked about, since `from` (the epoch for
// all time). A finished season's read is the same sums cut at its end (seasonSums). The time
// behind the cash (cash_minutes) is each counted session's whole length, from its join; the rows
// below compare its value, not its scale (parts that cancel sum to 0.000000 where this reads 0).
// Frozen on purpose: if the reads' meaning changes, this file changes with it in the same commit,
// deliberately. totalsRows, rangeRows and seasonRows, at the end, are the other side.
import { sql, type SQL } from 'drizzle-orm';
import type { DbOrTx } from '$lib/server/db';
import { DEFAULT_FLOOR_MINUTES, type BoardMetric, type BoardQuery } from '$lib/leaderboard';
import { rangeBase, seasonBase, totalsBase } from '$lib/server/leaderboards';

const EPOCH = new Date(0);

const lines = (
	ids: string[],
	from: Date,
	steamId: string | string[] | null,
	to: Date | null = null
) => sql`
	lines AS (
		SELECT p.steam_id, p.match_id, p.server_id, p.faction, p.seconds, p.kills, p.deaths, p.cash_delta,
		       p.headshots, p.team_kills, p.suicides, p.vehicle_kills, p.longest_m, p.kill_streak, p.death_streak,
		       p.idle_seconds, m.started_at, m.ended_at, m.map,
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
		   ${to === null ? sql`` : sql`AND m.ended_at < ${to}`}
		   ${steamId === null ? sql`` : Array.isArray(steamId) ? sql`AND p.steam_id IN ${steamId}` : sql`AND p.steam_id = ${steamId}`})`;

const base = (ids: string[], from: Date, steamIds: string[] | null = null) => sql`
	sess AS (
		SELECT steam_id,
		       SUM(EXTRACT(EPOCH FROM (COALESCE(left_at, now()) - GREATEST(joined_at, ${from}::timestamptz)))) / 60 AS minutes,
		       SUM(EXTRACT(EPOCH FROM (COALESCE(left_at, now()) - joined_at))) / 60 AS cash_minutes,
		       SUM(seed_seconds) / 60.0 AS seed_minutes, MAX(last_seen) AS last_seen,
		       SUM(cash) AS cash
		  FROM player_sessions WHERE server_id IN ${ids} AND last_seen >= ${from}
		   AND (left_at IS NULL OR left_at >= ${from})
		   ${steamIds === null ? sql`` : sql`AND steam_id IN ${steamIds}`}
		 GROUP BY steam_id),
	${lines(ids, from, steamIds)},
	mt AS (
		SELECT steam_id, COUNT(*) AS matches,
		       SUM(kills) AS kills, SUM(deaths) AS deaths, SUM(headshots) AS headshots,
		       SUM(team_kills) AS team_kills, SUM(suicides) AS suicides, SUM(vehicle_kills) AS vehicle_kills,
		       MAX(kill_streak) AS kill_streak, MAX(death_streak) AS death_streak,
		       COUNT(*) FILTER (WHERE result = 'win') AS wins,
		       COUNT(*) FILTER (WHERE result = 'loss') AS losses,
		       COUNT(*) FILTER (WHERE result = 'draw') AS draws,
		       SUM(idle_seconds) / 60.0 AS idle_minutes
		  FROM lines GROUP BY steam_id),
	base AS (
		SELECT steam_id,
		       COALESCE(sess.minutes, 0) AS minutes, COALESCE(sess.cash_minutes, 0) AS cash_minutes,
		       COALESCE(sess.seed_minutes, 0) AS seed_minutes, COALESCE(sess.cash, 0) AS cash, sess.last_seen,
		       COALESCE(mt.kills, 0) AS kills, COALESCE(mt.deaths, 0) AS deaths,
		       COALESCE(mt.headshots, 0) AS headshots, COALESCE(mt.team_kills, 0) AS team_kills,
		       COALESCE(mt.suicides, 0) AS suicides, COALESCE(mt.vehicle_kills, 0) AS vehicle_kills,
		       COALESCE(mt.kill_streak, 0) AS kill_streak, COALESCE(mt.death_streak, 0) AS death_streak,
		       COALESCE(mt.matches, 0) AS matches, COALESCE(mt.wins, 0) AS wins,
		       COALESCE(mt.losses, 0) AS losses, COALESCE(mt.draws, 0) AS draws,
		       COALESCE(mt.idle_minutes, 0) AS idle_minutes
		  FROM sess FULL JOIN mt USING (steam_id))`;

/**
 * A finished season's rows, from `from` to `to`: every session that left in it or was still going
 * at its end, for its time in it (an open one up to `to`, or now if sooner); seed time and cash
 * only of the sessions that left in it; the lines of the matches that ended in it; no last seen.
 */
const seasonSums = (ids: string[], from: Date, to: Date) => sql`
	sess AS (
		SELECT steam_id,
		       SUM(EXTRACT(EPOCH FROM (LEAST(COALESCE(left_at, now()), ${to}::timestamptz)
		                               - GREATEST(joined_at, ${from}::timestamptz)))) / 60 AS minutes,
		       COALESCE(SUM(EXTRACT(EPOCH FROM (left_at - joined_at))) FILTER (WHERE left_at < ${to}), 0) / 60
		         AS cash_minutes,
		       COALESCE(SUM(seed_seconds) FILTER (WHERE left_at < ${to}), 0) / 60.0 AS seed_minutes,
		       COALESCE(SUM(cash) FILTER (WHERE left_at < ${to}), 0) AS cash
		  FROM player_sessions WHERE server_id IN ${ids} AND last_seen >= ${from}
		   AND (left_at IS NULL OR left_at >= ${from}) AND (left_at < ${to} OR joined_at < ${to})
		 GROUP BY steam_id),
	${lines(ids, from, null, to)},
	mt AS (
		SELECT steam_id, COUNT(*) AS matches,
		       SUM(kills) AS kills, SUM(deaths) AS deaths, SUM(headshots) AS headshots,
		       SUM(team_kills) AS team_kills, SUM(suicides) AS suicides, SUM(vehicle_kills) AS vehicle_kills,
		       MAX(kill_streak) AS kill_streak, MAX(death_streak) AS death_streak,
		       COUNT(*) FILTER (WHERE result = 'win') AS wins,
		       COUNT(*) FILTER (WHERE result = 'loss') AS losses,
		       COUNT(*) FILTER (WHERE result = 'draw') AS draws,
		       SUM(idle_seconds) / 60.0 AS idle_minutes
		  FROM lines GROUP BY steam_id),
	base AS (
		SELECT steam_id,
		       COALESCE(sess.minutes, 0) AS minutes, COALESCE(sess.cash_minutes, 0) AS cash_minutes,
		       COALESCE(sess.seed_minutes, 0) AS seed_minutes, COALESCE(sess.cash, 0) AS cash,
		       NULL::timestamptz AS last_seen,
		       COALESCE(mt.kills, 0) AS kills, COALESCE(mt.deaths, 0) AS deaths,
		       COALESCE(mt.headshots, 0) AS headshots, COALESCE(mt.team_kills, 0) AS team_kills,
		       COALESCE(mt.suicides, 0) AS suicides, COALESCE(mt.vehicle_kills, 0) AS vehicle_kills,
		       COALESCE(mt.kill_streak, 0) AS kill_streak, COALESCE(mt.death_streak, 0) AS death_streak,
		       COALESCE(mt.matches, 0) AS matches, COALESCE(mt.wins, 0) AS wins,
		       COALESCE(mt.losses, 0) AS losses, COALESCE(mt.draws, 0) AS draws,
		       COALESCE(mt.idle_minutes, 0) AS idle_minutes
		  FROM sess FULL JOIN mt USING (steam_id))`;

const METRIC_SQL: Record<BoardMetric, SQL> = {
	kills: sql`kills`,
	deaths: sql`deaths`,
	kd: sql`CASE WHEN deaths > 0 THEN kills::float / deaths WHEN kills > 0 THEN kills::float ELSE NULL END`,
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

/** Every all-time base row over these servers (or these players), each column as text. */
export async function oracleBase(
	db: DbOrTx,
	ids: string[],
	steamIds: string[] | null = null
): Promise<Record<string, string | null>[]> {
	return oracleRangeBase(db, ids, EPOCH, steamIds);
}

/** Every base row over these servers since `from`, each column as text. */
export async function oracleRangeBase(
	db: DbOrTx,
	ids: string[],
	from: Date,
	steamIds: string[] | null = null
): Promise<Record<string, string | null>[]> {
	if (!ids.length) return [];
	return (await db.execute(sql`
		WITH ${base(ids, from, steamIds)}
		SELECT steam_id, minutes::text, trim_scale(cash_minutes)::text AS cash_minutes, seed_minutes::text,
		       cash::text, last_seen::text, kills::text, deaths::text,
		       headshots::text, team_kills::text, suicides::text, vehicle_kills::text, kill_streak::text,
		       death_streak::text, matches::text, wins::text, losses::text, draws::text, idle_minutes::text
		  FROM base ORDER BY steam_id`)) as Record<string, string | null>[];
}

/**
 * A slice of the board since `from` (all time by default), or from `from` to `to` (a finished
 * season), as boardSlice read it, the counts as text.
 */
export async function oracleBoard(
	db: DbOrTx,
	ids: string[],
	q: BoardQuery,
	limit: number,
	offset: number,
	from: Date = EPOCH,
	to: Date | null = null
): Promise<Record<string, unknown>[]> {
	const order = q.dir === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
	return (await db.execute(sql`
		WITH ${to ? seasonSums(ids, from, to) : base(ids, from)},
		page AS (
			SELECT *, COUNT(*) OVER () AS total FROM base
			 WHERE minutes >= ${q.minMinutes}
			 ORDER BY ${METRIC_SQL[q.sort]} ${order}, kills DESC, steam_id
			 LIMIT ${limit} OFFSET ${offset})
		SELECT r.steam_id AS "steamId", r.minutes::text, r.cash_minutes::text AS "cashMinutes",
		       r.seed_minutes::text AS "seedMinutes", r.cash::text,
		       r.last_seen AS "lastSeen", r.kills::text, r.headshots::text, r.team_kills::text AS "teamKills",
		       r.deaths::text, r.suicides::text, r.vehicle_kills::text AS "vehicleKills",
		       r.kill_streak::text AS "killStreak", r.death_streak::text AS "deathStreak", r.matches::text,
		       r.wins::text, r.losses::text, r.draws::text, r.idle_minutes::text AS "idleMinutes", r.total::text,
		       (SELECT name FROM player_sessions ps WHERE ps.steam_id = r.steam_id AND ps.server_id IN ${ids}
		         ORDER BY ps.joined_at DESC, ps.id DESC LIMIT 1) AS name
		  FROM page r`)) as Record<string, unknown>[];
}

/** rankOf as it was: one more than the players above, at the default floor; null under it. */
export async function oracleRank(
	db: DbOrTx,
	ids: string[],
	steamId: string
): Promise<number | null> {
	if (!ids.length) return null;
	const [row] = (await db.execute(sql`
		WITH ${base(ids, EPOCH)},
		me AS (SELECT kills, minutes FROM base WHERE steam_id = ${steamId})
		SELECT (SELECT minutes >= ${DEFAULT_FLOOR_MINUTES} FROM me) AS qualifies,
		       (SELECT COUNT(*) FROM base, me WHERE base.minutes >= ${DEFAULT_FLOOR_MINUTES} AND base.kills > me.kills) AS above`)) as {
		qualifies: boolean | null;
		above: string;
	}[];
	return row?.qualifies ? Number(row.above) + 1 : null;
}

/** riskPerformanceFor's record of matches as it was (the kill-feed part never changed). */
export async function oracleRiskRecord(
	db: DbOrTx,
	ids: string[],
	steamIds: string[]
): Promise<Record<string, string | null>[]> {
	if (!ids.length || !steamIds.length) return [];
	return (await db.execute(sql`
		WITH ${lines(ids, EPOCH, steamIds)}
		SELECT steam_id AS "steamId", COUNT(*)::text AS matches,
		       (COUNT(*) FILTER (WHERE result = 'win'))::text AS wins,
		       (COUNT(*) FILTER (WHERE result = 'loss'))::text AS losses,
		       (COUNT(*) FILTER (WHERE result = 'draw'))::text AS draws,
		       SUM(kills)::text AS kills, SUM(deaths)::text AS deaths
		  FROM lines GROUP BY steam_id ORDER BY steam_id`)) as Record<string, string | null>[];
}

/** The same rows from the totals (totalsBase), as text, to hold against oracleBase. */
export async function totalsRows(
	db: DbOrTx,
	ids: string[],
	steamIds: string[] | null = null
): Promise<Record<string, string | null>[]> {
	if (!ids.length) return [];
	return (await db.execute(sql`
		WITH ${totalsBase(ids, steamIds)}
		SELECT steam_id, minutes::text, trim_scale(cash_minutes)::text AS cash_minutes, seed_minutes::text,
		       cash::text, last_seen::text, kills::text, deaths::text,
		       headshots::text, team_kills::text, suicides::text, vehicle_kills::text, kill_streak::text,
		       death_streak::text, matches::text, wins::text, losses::text, draws::text, idle_minutes::text
		  FROM base ORDER BY steam_id`)) as Record<string, string | null>[];
}

/** Every base row over these servers from `from` to `to`, each column as text. */
export async function oracleSeasonBase(
	db: DbOrTx,
	ids: string[],
	from: Date,
	to: Date
): Promise<Record<string, string | null>[]> {
	if (!ids.length) return [];
	return (await db.execute(sql`
		WITH ${seasonSums(ids, from, to)}
		SELECT steam_id, minutes::text, trim_scale(cash_minutes)::text AS cash_minutes, seed_minutes::text,
		       cash::text, last_seen::text, kills::text, deaths::text,
		       headshots::text, team_kills::text, suicides::text, vehicle_kills::text, kill_streak::text,
		       death_streak::text, matches::text, wins::text, losses::text, draws::text, idle_minutes::text
		  FROM base ORDER BY steam_id`)) as Record<string, string | null>[];
}

/** The same rows from the day rows (rangeBase), as text, to hold against oracleRangeBase. */
export async function rangeRows(
	db: DbOrTx,
	ids: string[],
	from: Date
): Promise<Record<string, string | null>[]> {
	if (!ids.length) return [];
	return (await db.execute(sql`
		WITH ${rangeBase(ids, from)}
		SELECT steam_id, minutes::text, trim_scale(cash_minutes)::text AS cash_minutes, seed_minutes::text,
		       cash::text, last_seen::text, kills::text, deaths::text,
		       headshots::text, team_kills::text, suicides::text, vehicle_kills::text, kill_streak::text,
		       death_streak::text, matches::text, wins::text, losses::text, draws::text, idle_minutes::text
		  FROM base ORDER BY steam_id`)) as Record<string, string | null>[];
}

/** The same rows from the day rows (seasonBase), as text, to hold against oracleSeasonBase. */
export async function seasonRows(
	db: DbOrTx,
	ids: string[],
	from: Date,
	to: Date
): Promise<Record<string, string | null>[]> {
	if (!ids.length) return [];
	return (await db.execute(sql`
		WITH ${seasonBase(ids, from, to)}
		SELECT steam_id, minutes::text, trim_scale(cash_minutes)::text AS cash_minutes, seed_minutes::text,
		       cash::text, last_seen::text, kills::text, deaths::text,
		       headshots::text, team_kills::text, suicides::text, vehicle_kills::text, kill_streak::text,
		       death_streak::text, matches::text, wins::text, losses::text, draws::text, idle_minutes::text
		  FROM base ORDER BY steam_id`)) as Record<string, string | null>[];
}
