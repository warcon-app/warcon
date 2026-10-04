// Read side of the analytics tables: one query bundle per server and time range.
//
// Samples are written when something changed and at a heartbeat, not on a fixed clock, so every
// figure that used to multiply a sample count by the poll interval is duration-weighted instead:
// each sample covers the time until the next one (capped, so a lone sample before a long gap
// does not claim hours), averages weight player counts by that cover, uptime is covered-up time
// over covered time, and session minutes come straight from joined_at and left_at.
import { and, count, desc, eq, gte, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Env } from './env';
import { matches, playerSessions, servers } from './db/schema';
import { settings } from './settings';
import { liveFactions } from './matches';

import { MAX_COVER_S } from './rollups';

export type Range = '24h' | '7d' | '30d';
const RANGE_MS: Record<Range, number> = {
	'24h': 86400000,
	'7d': 7 * 86400000,
	'30d': 30 * 86400000
};
/** Bucket width per range so a chart gets roughly 300 points. */
const BUCKET_S: Record<Range, number> = { '24h': 300, '7d': 1800, '30d': 7200 };
/** Ranges longer than this read the hourly rollups (the 30-day charts); shorter ones read raw rows. */
const ROLLED_BEYOND_MS = 14 * 86400_000;

export const parseRange = (v: string | null): Range => (v === '7d' || v === '30d' ? v : '24h');

export type PeriodUnit = 'hour' | 'day';
/** The periods a range is cut into for the per-period charts: hours over a day, days beyond. */
const PERIODS: Record<Range, { unit: PeriodUnit; n: number }> = {
	'24h': { unit: 'hour', n: 24 },
	'7d': { unit: 'day', n: 7 },
	'30d': { unit: 'day', n: 30 }
};

export interface PopulationPoint {
	ts: string;
	avg: number | null;
	max: number | null;
	cap: number | null;
	ok: number;
	total: number;
	/** seconds this bucket's samples covered while up / while unreachable */
	up: number;
	down: number;
}
/** One hour or one day, from the player sessions. */
export interface PeriodPoint {
	/** when it starts */
	ts: string;
	/** the players who were on during it */
	players: number;
	/** of them, those whose first session on this server began in it */
	newPlayers: number;
	/** the sessions that ended in it, and how long they lasted */
	sessions: number;
	avgSessionS: number | null;
	medianSessionS: number | null;
}
export interface Periods {
	range: Range;
	/** the time zone the days are cut in */
	tz: string;
	unit: PeriodUnit;
	/** oldest first; the last one is running now */
	periods: PeriodPoint[];
}
/** Cash in play at one moment or bucket: the total and each faction's share ('' = unassigned). */
export interface CashPoint {
	ts: string;
	/** null when no reachable sample carried cash in this bucket (a gap, not zero) */
	total: number | null;
	factions: Record<string, number>;
}
export interface MapShare {
	map: string;
	minutes: number;
	matches: number;
}
/**
 * Wins per side over the matches that ended in the range, by the boards' rule: the winner is the
 * side that led when the scores reset; with no winner, a match somebody scored in is a draw, and
 * one that ended with no scores (abandoned) or with nobody scoring has no result.
 */
export interface TeamWins {
	/** every side on the scoreboard of a match with a result, most wins first */
	teams: { name: string; wins: number; colorHex: string | null }[];
	/** matches with a result: won, or drawn */
	decided: number;
	draws: number;
	noResult: number;
}
export interface TopPlayer {
	steamId: string;
	name: string;
	minutes: number;
	sessions: number;
	kills: number;
	deaths: number;
	lastSeen: string;
	online: boolean;
}
export interface MatchRow {
	id: number;
	startedAt: string;
	endedAt: string | null;
	map: string | null;
	experiences: string | null;
	lighting: string | null;
	peakPlayers: number;
	finalScores: { name: string; score: number }[] | null;
	winner: string | null;
}
export interface CombatCause {
	cause: string;
	kills: number;
	headshots: number;
}
export interface CombatPlayer {
	steamId: string;
	name: string;
	kills: number;
	deaths: number;
	headshots: number;
	teamKills: number;
	avgDistanceM: number | null;
}
export interface LongestKill {
	ts: string;
	killer: string;
	victim: string;
	cause: string | null;
	distanceM: number;
}
/** From the kill feed (kills table), for the range; null when this server has no feed set up and no kills. */
export interface Combat {
	kills: number;
	headshots: number;
	teamKills: number;
	suicides: number;
	vehicleKills: number;
	/** kills per bucket, same buckets as `population` */
	perBucket: { ts: string; kills: number }[];
	causes: CombatCause[];
	players: CombatPlayer[];
	longest: LongestKill[];
}
export interface Analytics {
	range: Range;
	from: string;
	to: string;
	/** the heartbeat between samples when nothing changes */
	sampleSeconds: number;
	bucketSeconds: number;
	summary: {
		uniquePlayers: number;
		peakPlayers: number;
		avgPlayers: number;
		uptimePct: number | null;
		onlineNow: number;
		samples: number;
		matches: number;
		/** hours of covered time in the range */
		coveredHours: number;
	};
	population: PopulationPoint[];
	cash: CashPoint[];
	maps: MapShare[];
	wins: TeamWins;
	players: TopPlayer[];
	matches: MatchRow[];
	hourly: { hour: number; avg: number }[];
	combat: Combat | null;
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const isoOf = (v: unknown): string =>
	v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

/**
 * The samples in range with the seconds each one covers (until the next, or now, capped):
 * ts, ok, player_count (weighted), peak, max_players, map, dur, n (samples represented).
 * `from` may be SQL (the rollups' cut): LEAD only looks forward, so starting the read there gives
 * every row after it the same cover as reading the whole range would.
 */
const rawRows = (serverId: string, from: Date | SQL) => sql`
	SELECT ts, ok, player_count::float AS player_count, player_count AS peak, max_players, map,
	       LEAST(${MAX_COVER_S}, EXTRACT(EPOCH FROM (COALESCE(LEAD(ts) OVER (ORDER BY ts), now()) - ts))) AS dur,
	       1 AS n
	  FROM samples WHERE server_id = ${serverId} AND ts >= ${from}`;

/** Where the hourly rollups stop: the raw rows take over from here (a scalar the index can use). */
const CUT = sql`(SELECT t FROM cut)`;

/** The same shape from the hourly rollups up to their newest bucket, then raw samples. */
const rolledRows = (serverId: string, from: Date) => sql`
	WITH cut AS (SELECT COALESCE(MAX(bucket) + interval '1 hour', ${from}::timestamptz) AS t
	               FROM sample_rollups WHERE server_id = ${serverId} AND bucket >= ${from})
	SELECT r.bucket AS ts, true AS ok, r.player_s / NULLIF(r.up_s, 0) AS player_count, r.max_players AS peak,
	       r.max_cap AS max_players, NULL::text AS map, r.up_s AS dur, r.ok_samples AS n
	  FROM sample_rollups r, cut WHERE r.server_id = ${serverId} AND r.bucket >= ${from} AND r.bucket < cut.t AND r.up_s > 0
	UNION ALL
	SELECT r.bucket, false, NULL, NULL, NULL, NULL, r.down_s, r.samples - r.ok_samples
	  FROM sample_rollups r, cut WHERE r.server_id = ${serverId} AND r.bucket >= ${from} AND r.bucket < cut.t AND r.down_s > 0
	UNION ALL
	SELECT x.ts, x.ok, x.player_count, x.peak, x.max_players, x.map, x.dur, x.n
	  FROM (${rawRows(serverId, CUT)}) x`;

/** Map cover in range: rollups up to their newest bucket, then raw samples. */
const mapRows = (serverId: string, from: Date, rolled: boolean) =>
	rolled
		? sql`
	WITH cut AS (SELECT COALESCE(MAX(bucket) + interval '1 hour', ${from}::timestamptz) AS t
	               FROM sample_rollups WHERE server_id = ${serverId} AND bucket >= ${from})
	SELECT map, secs FROM sample_map_rollups, cut
	 WHERE server_id = ${serverId} AND bucket >= ${from} AND bucket < cut.t
	UNION ALL
	SELECT x.map, x.dur FROM (${rawRows(serverId, CUT)}) x
	 WHERE x.ok AND x.map IS NOT NULL AND x.map <> ''`
		: sql`
	SELECT x.map, x.dur AS secs FROM (${rawRows(serverId, from)}) x
	 WHERE x.ok AND x.map IS NOT NULL AND x.map <> ''`;

export async function loadAnalytics(env: Env, serverId: string, range: Range): Promise<Analytics> {
	const to = new Date();
	const from = new Date(to.getTime() - RANGE_MS[range]);
	const bucket = BUCKET_S[range];
	const db = env.db;
	// The hourly rollups carry the older part of a long range: far fewer rows, the same numbers,
	// and on TimescaleDB the raw rows beyond two weeks sit in compressed chunks.
	const rolled = RANGE_MS[range] > ROLLED_BEYOND_MS;
	const covered = (serverId: string, from: Date) =>
		rolled ? rolledRows(serverId, from) : rawRows(serverId, from);

	// time_bucket() would be nicer, but this floor() form works on plain Postgres too.
	const population = (
		await db.execute<{
			b: Date;
			avg: string | null;
			max: number | null;
			cap: number | null;
			ok: string;
			total: string;
			up: string | null;
			down: string | null;
		}>(sql`
				WITH s AS (${covered(serverId, from)})
				SELECT to_timestamp(floor(extract(epoch FROM ts) / ${bucket}) * ${bucket}) AS b,
				       SUM(player_count * dur) FILTER (WHERE ok) / NULLIF(SUM(dur) FILTER (WHERE ok), 0) AS avg,
				       MAX(peak) AS max, MAX(max_players) AS cap,
				       SUM(n) FILTER (WHERE ok) AS ok, SUM(n) AS total,
				       SUM(dur) FILTER (WHERE ok) AS up, SUM(dur) FILTER (WHERE NOT ok) AS down
				  FROM s GROUP BY b ORDER BY b`)
	).map((r) => ({
		ts: isoOf(r.b),
		avg: numOrNull(r.avg),
		max: numOrNull(r.max),
		cap: numOrNull(r.cap),
		ok: num(r.ok),
		total: num(r.total),
		up: num(r.up),
		down: num(r.down)
	}));

	const cash = await bucketedCash(env, serverId, from, bucket);

	const [totals] = await db.execute<{
		n: string;
		peak: number | null;
		avg: string | null;
		up: string | null;
		down: string | null;
	}>(sql`
			WITH s AS (${covered(serverId, from)})
			SELECT SUM(n) AS n, MAX(peak) AS peak,
			       SUM(player_count * dur) FILTER (WHERE ok) / NULLIF(SUM(dur) FILTER (WHERE ok), 0) AS avg,
			       SUM(dur) FILTER (WHERE ok) AS up, SUM(dur) FILTER (WHERE NOT ok) AS down
			  FROM s`);

	const maps = (
		await db.execute<{ map: string; secs: string; matches: string }>(sql`
				WITH s AS (${mapRows(serverId, from, rolled)})
				SELECT s.map, SUM(s.secs) AS secs,
				       (SELECT COUNT(*) FROM matches m WHERE m.server_id = ${serverId} AND m.map = s.map AND m.started_at >= ${from}) AS matches
				  FROM s GROUP BY s.map ORDER BY secs DESC`)
	).map((r) => ({
		map: r.map,
		minutes: Math.round(num(r.secs) / 60),
		matches: num(r.matches)
	}));

	const wins = await teamWins(env, serverId, from);

	const seen = (await db.execute<{
		steamId: string;
		name: string;
		minutes: string;
		sessions: string;
		lastSeen: Date;
		online: string;
	}>(sql`
				SELECT p.steam_id AS "steamId",
				       (ARRAY_AGG(p.name ORDER BY p.last_seen DESC))[1] AS name,
				       SUM(EXTRACT(EPOCH FROM (COALESCE(p.left_at, now()) - GREATEST(p.joined_at, ${from}::timestamptz)))) / 60 AS minutes,
				       COUNT(*) AS sessions,
				       MAX(p.last_seen) AS "lastSeen", COUNT(*) FILTER (WHERE p.left_at IS NULL) AS online
				  FROM player_sessions p WHERE p.server_id = ${serverId} AND p.last_seen >= ${from}
				   AND (p.left_at IS NULL OR p.left_at >= ${from})
				 GROUP BY p.server_id, p.steam_id ORDER BY minutes DESC LIMIT 50`)) as {
		steamId: string;
		name: string;
		minutes: string;
		sessions: string;
		lastSeen: Date;
		online: string;
	}[];
	// Kills and deaths for those players from their match lines (the game's own counters, per
	// match that ended in the range), the same rows the boards read.
	const recorded = new Map<string, { kills: number; deaths: number }>();
	if (seen.length)
		for (const r of await db.execute<{ steamId: string; kills: string; deaths: string }>(sql`
				SELECT p.steam_id AS "steamId", SUM(p.kills) AS kills, SUM(p.deaths) AS deaths
				  FROM match_players p JOIN matches m ON m.id = p.match_id
				 WHERE p.server_id = ${serverId} AND p.steam_id IN ${seen.map((s) => s.steamId)}
				   AND m.server_id = ${serverId}
				   AND m.ended_at IS NOT NULL AND m.ended_at >= ${from}
				 GROUP BY p.steam_id`))
			recorded.set(r.steamId, { kills: num(r.kills), deaths: num(r.deaths) });
	const players = seen.map((r) => ({
		steamId: r.steamId,
		name: r.name,
		minutes: Math.round(num(r.minutes)),
		sessions: num(r.sessions),
		kills: recorded.get(r.steamId)?.kills ?? 0,
		deaths: recorded.get(r.steamId)?.deaths ?? 0,
		lastSeen: isoOf(r.lastSeen),
		online: num(r.online) > 0
	}));

	const [unique] = await db
		.select({ n: sql<number>`COUNT(DISTINCT ${playerSessions.steamId})` })
		.from(playerSessions)
		.where(
			and(
				eq(playerSessions.serverId, serverId),
				gte(playerSessions.lastSeen, from),
				or(isNull(playerSessions.leftAt), gte(playerSessions.leftAt, from))
			)
		);
	const [online] = await db
		.select({ n: count() })
		.from(playerSessions)
		.where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.leftAt)));

	const matchRows = await db
		.select()
		.from(matches)
		.where(and(eq(matches.serverId, serverId), gte(matches.startedAt, from)))
		.orderBy(desc(sql`(${matches.endedAt} IS NULL)`), desc(matches.startedAt))
		.limit(30);
	const [matchCount] = await db
		.select({ n: count() })
		.from(matches)
		.where(and(eq(matches.serverId, serverId), gte(matches.startedAt, from)));

	const hourly = (
		await db.execute<{ hour: number; avg: string }>(sql`
				WITH s AS (${covered(serverId, from)})
				SELECT EXTRACT(HOUR FROM ts)::int AS hour,
				       SUM(player_count * dur) / NULLIF(SUM(dur), 0) AS avg
				  FROM s WHERE ok GROUP BY hour ORDER BY hour`)
	).map((r) => ({ hour: num(r.hour), avg: num(r.avg) }));

	const combat = await loadCombat(env, serverId, from, bucket);

	const up = num(totals?.up);
	const down = num(totals?.down);
	return {
		range,
		from: from.toISOString(),
		to: to.toISOString(),
		sampleSeconds: Math.round(settings().sampleMs / 1000),
		bucketSeconds: bucket,
		summary: {
			uniquePlayers: num(unique?.n),
			peakPlayers: num(totals?.peak),
			avgPlayers: Math.round(num(totals?.avg) * 10) / 10,
			uptimePct: up + down > 0 ? Math.round((up / (up + down)) * 1000) / 10 : null,
			onlineNow: num(online?.n),
			samples: num(totals?.n),
			matches: num(matchCount?.n),
			coveredHours: Math.round(((up + down) / 3600) * 10) / 10
		},
		population,
		cash,
		maps,
		wins,
		players,
		matches: matchRows.map((r) => ({
			id: r.id,
			startedAt: r.startedAt.toISOString(),
			endedAt: r.endedAt ? r.endedAt.toISOString() : null,
			map: r.map,
			experiences: r.experiences,
			lighting: r.lighting,
			peakPlayers: r.peakPlayers,
			finalScores: (r.finalScores as { name: string; score: number }[] | null) ?? null,
			winner: r.winner
		})),
		hourly,
		combat
	};
}

/**
 * One pass over the server's matches that ended since `from`: the counts by result, then each side
 * on those scoreboards with its wins. A side that played and never won is listed with none.
 * Colours come from the live scoreboard. A match counts by when it ended, but the index is on
 * when it started: the read starts a day before `from`, since no match runs that long, so it
 * reads the range and not the server's whole history.
 */
async function teamWins(env: Env, serverId: string, from: Date): Promise<TeamWins> {
	const [rows, live] = await Promise.all([
		env.db.execute<{
			name: string | null;
			wins: string;
			decided: string;
			draws: string;
			none: string;
		}>(sql`
			WITH m AS (
				SELECT winner,
				       CASE WHEN jsonb_typeof(final_scores) = 'array' THEN final_scores ELSE '[]'::jsonb END AS scores
				  FROM matches
				 WHERE server_id = ${serverId} AND started_at >= ${new Date(from.getTime() - 86_400_000)}
				   AND ended_at IS NOT NULL AND ended_at >= ${from}),
			r AS (
				SELECT winner, scores,
				       CASE WHEN winner IS NOT NULL THEN 'win'
				            WHEN (SELECT MAX(CASE WHEN jsonb_typeof(e->'score') = 'number' THEN (e->>'score')::numeric END)
				                    FROM jsonb_array_elements(scores) e) > 0 THEN 'draw'
				            ELSE 'none' END AS result
				  FROM m)
			SELECT NULL AS name, 0 AS wins,
			       COUNT(*) FILTER (WHERE result <> 'none') AS decided,
			       COUNT(*) FILTER (WHERE result = 'draw') AS draws,
			       COUNT(*) FILTER (WHERE result = 'none') AS none
			  FROM r
			UNION ALL
			SELECT f.name, COUNT(*) FILTER (WHERE r.winner = f.name), 0, 0, 0
			  FROM r CROSS JOIN LATERAL (
			       SELECT e->>'name' AS name FROM jsonb_array_elements(r.scores) e
			        UNION SELECT r.winner) f
			 WHERE r.result <> 'none' AND f.name IS NOT NULL AND f.name <> ''
			 GROUP BY f.name`),
		liveFactions(env, serverId)
	]);
	const totals = rows.find((r) => r.name === null);
	const teams = rows
		.filter((r) => r.name !== null)
		.map((r) => ({
			name: r.name as string,
			wins: num(r.wins),
			colorHex: live.find((f) => f.name === r.name)?.colorHex ?? null
		}))
		.sort((a, b) => b.wins - a.wins || a.name.localeCompare(b.name));
	return {
		teams,
		decided: num(totals?.decided),
		draws: num(totals?.draws),
		noResult: num(totals?.none)
	};
}

let zones: Promise<Set<string>> | null = null;

/**
 * The time zone to cut days in: the name the browser reports when Postgres knows it (its list
 * holds the old names browsers still send, such as Asia/Calcutta, and the new ones), else UTC.
 * The list is read once per process.
 */
export async function timeZone(env: Env, name: string | null | undefined): Promise<string> {
	if (!name || name.length > 64) return 'UTC';
	zones ??= env.db
		.execute<{ name: string }>(sql`SELECT name FROM pg_timezone_names`)
		.then((rows) => new Set(rows.map((r) => r.name)));
	try {
		return (await zones).has(name) ? name : 'UTC';
	} catch {
		zones = null;
		return 'UTC';
	}
}

/**
 * Players, new players and session lengths per hour (24h) or per day (7d, 30d), the last period
 * the one running now: days in the viewer's time zone (`tz`, an IANA name the browser reports;
 * UTC when it is missing or unknown), hours counted back from the start of the current one. A
 * player counts in every period one of their sessions touches, and is new in the period their
 * first session on this server began; a session counts, with its whole length, in the period it
 * ended, so one still running counts in none.
 *
 * One read of the sessions seen since the first period started (the (server, last_seen) index),
 * each placed by width_bucket over the period starts, which Postgres works out once in the zone.
 * A player whose sessions there all began inside the periods is then looked up on the
 * (steam_id, joined_at) index, back from the first start, for a session here before it: the read
 * grows with the players in the range and their own history, not with the server's.
 */
export async function loadPeriods(
	env: Env,
	serverId: string,
	range: Range,
	tz: string | null | undefined,
	/** the moment the last period runs at (tests pass one) */
	at: Date = new Date()
): Promise<Periods> {
	const { unit, n } = PERIODS[range];
	const zone = await timeZone(env, tz);
	const last = n - 1;
	const now = sql`${at}::timestamptz`;
	// Local midnights for days, so a day is 23 or 25 hours where the clocks change.
	const starts =
		unit === 'day'
			? sql`ARRAY(SELECT ((${now} AT TIME ZONE ${zone})::date - ${last}::int + k)::timestamp AT TIME ZONE ${zone}
			              FROM generate_series(0, ${last}::int) k ORDER BY k)`
			: sql`ARRAY(SELECT date_trunc('hour', ${now}, ${zone}) - (${last}::int - k) * interval '1 hour'
			              FROM generate_series(0, ${last}::int) k ORDER BY k)`;
	const rows = await env.db.execute<{
		start: Date;
		players: string;
		fresh: string;
		sessions: string;
		avg: number | null;
		median: number | null;
	}>(sql`
		WITH w AS (SELECT ${starts} AS starts),
		s AS (
			-- a, b, e: the periods it began, was last seen and ended in; -1 before the first
			SELECT p.steam_id, width_bucket(p.joined_at, w.starts) - 1 AS a,
			       width_bucket(p.last_seen, w.starts) - 1 AS b, width_bucket(p.left_at, w.starts) - 1 AS e,
			       date_part('epoch', p.left_at - p.joined_at) AS secs
			  FROM player_sessions p, w
			 WHERE p.server_id = ${serverId} AND p.last_seen >= w.starts[1]
			   AND (p.left_at IS NULL OR p.left_at >= w.starts[1])),
		present AS (
			SELECT k, COUNT(*) AS players
			  FROM (SELECT DISTINCT k, s.steam_id FROM s, generate_series(GREATEST(s.a, 0), s.b) k) x
			 GROUP BY k),
		fresh AS (
			SELECT c.k, COUNT(*) AS n
			  FROM (SELECT s.steam_id, MIN(s.a) AS k FROM s GROUP BY s.steam_id HAVING MIN(s.a) >= 0) c
			 CROSS JOIN w
			  LEFT JOIN LATERAL (SELECT 1 AS seen FROM player_sessions o
			                      WHERE o.steam_id = c.steam_id AND o.server_id = ${serverId}
			                        AND o.joined_at < w.starts[1]
			                      ORDER BY o.joined_at DESC LIMIT 1) o ON true
			 WHERE o.seen IS NULL GROUP BY c.k),
		ended AS (
			SELECT s.e AS k, COUNT(*) AS n, AVG(s.secs) AS avg,
			       percentile_cont(0.5) WITHIN GROUP (ORDER BY s.secs) AS median
			  FROM s WHERE s.e >= 0 GROUP BY s.e)
		SELECT w.starts[k + 1] AS start, COALESCE(p.players, 0) AS players, COALESCE(f.n, 0) AS fresh,
		       COALESCE(e.n, 0) AS sessions, e.avg, e.median
		  FROM w, generate_series(0, ${last}::int) k
		  LEFT JOIN present p USING (k) LEFT JOIN fresh f USING (k) LEFT JOIN ended e USING (k)
		 ORDER BY k`);
	return {
		range,
		tz: zone,
		unit,
		periods: rows.map((r) => ({
			ts: isoOf(r.start),
			players: num(r.players),
			newPlayers: num(r.fresh),
			sessions: num(r.sessions),
			avgSessionS: r.avg === null ? null : Math.round(num(r.avg)),
			medianSessionS: r.median === null ? null : Math.round(num(r.median))
		}))
	};
}

async function loadCombat(
	env: Env,
	serverId: string,
	from: Date,
	bucket: number
): Promise<Combat | null> {
	const db = env.db;
	const [feed] = await db
		.select({ configured: sql<boolean>`feed_token_hash IS NOT NULL` })
		.from(servers)
		.where(eq(servers.id, serverId));
	const [totals] = await db.execute<{
		kills: string;
		headshots: string;
		teamKills: string;
		suicides: string;
		vehicleKills: string;
	}>(sql`
		SELECT COUNT(*) AS kills, COUNT(*) FILTER (WHERE headshot) AS headshots,
		       COUNT(*) FILTER (WHERE team_kill) AS "teamKills", COUNT(*) FILTER (WHERE suicide) AS suicides,
		       COUNT(*) FILTER (WHERE cause LIKE 'Vehicle.%' OR cause LIKE 'Id.Vehicle.%') AS "vehicleKills"
		  FROM kills WHERE event_type = 'killed' AND parsed_kill AND server_id = ${serverId} AND ts >= ${from}`);
	if (!feed?.configured && !num(totals?.kills)) return null;
	const [perBucket, causes, players, longest] = await Promise.all([
		db.execute<{ b: Date; kills: string }>(sql`
			SELECT to_timestamp(floor(extract(epoch FROM ts) / ${bucket}) * ${bucket}) AS b, COUNT(*) AS kills
			  FROM kills WHERE event_type = 'killed' AND parsed_kill AND server_id = ${serverId} AND ts >= ${from} GROUP BY b ORDER BY b`),
		db.execute<{ cause: string; kills: string; headshots: string }>(sql`
			SELECT cause, COUNT(*) AS kills, COUNT(*) FILTER (WHERE headshot) AS headshots
			  FROM kills WHERE event_type = 'killed' AND parsed_kill AND server_id = ${serverId} AND ts >= ${from} AND cause IS NOT NULL AND NOT suicide
			 GROUP BY cause ORDER BY kills DESC LIMIT 12`),
		db.execute<{
			steamId: string;
			name: string;
			kills: string;
			deaths: string;
			headshots: string;
			teamKills: string;
			avg: string | null;
		}>(sql`
			WITH k AS (
				SELECT killer_steam_id AS steam_id, MAX(killer_name) AS name, COUNT(*) AS kills,
				       COUNT(*) FILTER (WHERE headshot) AS headshots, COUNT(*) FILTER (WHERE team_kill) AS team_kills,
				       AVG(distance_m) AS avg
				  FROM kills WHERE event_type = 'killed' AND parsed_kill AND server_id = ${serverId} AND ts >= ${from} AND killer_steam_id IS NOT NULL AND NOT suicide
				 GROUP BY killer_steam_id),
			d AS (
				SELECT victim_steam_id AS steam_id, COUNT(*) AS deaths
				  FROM kills WHERE event_type = 'killed' AND parsed_kill AND server_id = ${serverId} AND ts >= ${from} GROUP BY victim_steam_id)
			SELECT k.steam_id AS "steamId", k.name, k.kills, COALESCE(d.deaths, 0) AS deaths, k.headshots,
			       k.team_kills AS "teamKills", k.avg
			  FROM k LEFT JOIN d ON d.steam_id = k.steam_id ORDER BY k.kills DESC LIMIT 25`),
		db.execute<{ ts: Date; killer: string; victim: string; cause: string | null; d: number }>(sql`
			SELECT ts, killer_name AS killer, victim_name AS victim, cause, distance_m AS d
			  FROM kills WHERE event_type = 'killed' AND parsed_kill AND server_id = ${serverId} AND ts >= ${from} AND distance_m IS NOT NULL
			   AND NOT suicide AND NOT team_kill
			 ORDER BY distance_m DESC LIMIT 5`)
	]);
	return {
		kills: num(totals?.kills),
		headshots: num(totals?.headshots),
		teamKills: num(totals?.teamKills),
		suicides: num(totals?.suicides),
		vehicleKills: num(totals?.vehicleKills),
		perBucket: perBucket.map((r) => ({ ts: isoOf(r.b), kills: num(r.kills) })),
		causes: causes.map((r) => ({
			cause: r.cause,
			kills: num(r.kills),
			headshots: num(r.headshots)
		})),
		players: players.map((r) => ({
			steamId: r.steamId,
			name: r.name,
			kills: num(r.kills),
			deaths: num(r.deaths),
			headshots: num(r.headshots),
			teamKills: num(r.teamKills),
			avgDistanceM: r.avg === null ? null : Math.round(num(r.avg))
		})),
		longest: longest.map((r) => ({
			ts: isoOf(r.ts),
			killer: r.killer,
			victim: r.victim,
			cause: r.cause,
			distanceM: Math.round(num(r.d))
		}))
	};
}

/**
 * Cash per faction averaged into `bucket`-second buckets. Samples store cash as a JSON array, so
 * the rows are unnested in SQL and pivoted back here; buckets with no reachable sample are
 * omitted (the population series carries the outage bands).
 */
async function bucketedCash(
	env: Env,
	serverId: string,
	from: Date,
	bucket: number
): Promise<CashPoint[]> {
	const rows = await env.db.execute<{ b: Date; name: string; avg: string }>(sql`
			SELECT to_timestamp(floor(extract(epoch FROM s.ts) / ${bucket}) * ${bucket}) AS b,
			       e->>'name' AS name, AVG((e->>'cash')::numeric) AS avg
			  FROM samples s CROSS JOIN LATERAL jsonb_array_elements(s.cash) e
			 WHERE s.server_id = ${serverId} AND s.ts >= ${from} AND s.ok AND s.cash IS NOT NULL
			 GROUP BY b, name ORDER BY b`);
	return pivotCash(rows.map((r) => ({ ts: isoOf(r.b), name: r.name ?? '', cash: num(r.avg) })));
}

/** Every reachable sample's cash since `since`, newest last, for a live chart to start from. */
export async function loadCashSince(
	env: Env,
	serverId: string,
	since: Date,
	limit = 3000
): Promise<CashPoint[]> {
	const rows = await env.db.execute<{ ts: Date; cash: { name: string; cash: number }[] }>(sql`
			SELECT ts, cash FROM samples
			 WHERE server_id = ${serverId} AND ts >= ${since} AND ok AND cash IS NOT NULL
			 ORDER BY ts DESC NULLS LAST LIMIT ${limit}`);
	return rows.reverse().map((r) => {
		const point: CashPoint = { ts: isoOf(r.ts), total: 0, factions: {} };
		for (const c of Array.isArray(r.cash) ? r.cash : []) addCash(point, c.name ?? '', num(c.cash));
		return point;
	});
}

function pivotCash(rows: { ts: string; name: string; cash: number }[]): CashPoint[] {
	const points: CashPoint[] = [];
	let cur: CashPoint | null = null;
	for (const r of rows) {
		if (!cur || cur.ts !== r.ts) {
			cur = { ts: r.ts, total: 0, factions: {} };
			points.push(cur);
		}
		addCash(cur, r.name, r.cash);
	}
	return points;
}

function addCash(point: CashPoint, name: string, cash: number): void {
	const v = Math.round(cash);
	point.factions[name] = (point.factions[name] || 0) + v;
	point.total = (point.total || 0) + v;
}
