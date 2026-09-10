// Read side of the analytics tables: one query bundle per server and time range.
//
// Samples are written when something changed and at a heartbeat, not on a fixed clock, so every
// figure that used to multiply a sample count by the poll interval is duration-weighted instead:
// each sample covers the time until the next one (capped, so a lone sample before a long gap
// does not claim hours), averages weight player counts by that cover, uptime is covered-up time
// over covered time, and session minutes come straight from joined_at and left_at.
import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Env } from './env';
import { matches, playerSessions } from './db/schema';
import { settings } from './settings';

import { MAX_COVER_S } from './rollups';

export type Range = '24h' | '7d' | '30d';
const RANGE_MS: Record<Range, number> = {
	'24h': 86400000,
	'7d': 7 * 86400000,
	'30d': 30 * 86400000
};
/** Bucket width per range so a chart gets roughly 300 points. */
const BUCKET_S: Record<Range, number> = { '24h': 300, '7d': 1800, '30d': 7200 };

export const parseRange = (v: string | null): Range => (v === '7d' || v === '30d' ? v : '24h');

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
	players: TopPlayer[];
	matches: MatchRow[];
	hourly: { hour: number; avg: number }[];
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const isoOf = (v: unknown): string =>
	v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

/**
 * The samples in range with the seconds each one covers (until the next, or now, capped):
 * ts, ok, player_count (weighted), peak, max_players, map, dur, n (samples represented).
 */
const rawRows = (serverId: string, from: Date) => sql`
	SELECT ts, ok, player_count::float AS player_count, player_count AS peak, max_players, map,
	       LEAST(${MAX_COVER_S}, EXTRACT(EPOCH FROM (COALESCE(LEAD(ts) OVER (ORDER BY ts), now()) - ts))) AS dur,
	       1 AS n
	  FROM samples WHERE server_id = ${serverId} AND ts >= ${from}`;

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
	  FROM (${rawRows(serverId, from)}) x, cut WHERE x.ts >= cut.t`;

/** Map cover in range: rollups up to their newest bucket, then raw samples. */
const mapRows = (serverId: string, from: Date, rolled: boolean) =>
	rolled
		? sql`
	WITH cut AS (SELECT COALESCE(MAX(bucket) + interval '1 hour', ${from}::timestamptz) AS t
	               FROM sample_rollups WHERE server_id = ${serverId} AND bucket >= ${from})
	SELECT map, secs FROM sample_map_rollups, cut
	 WHERE server_id = ${serverId} AND bucket >= ${from} AND bucket < cut.t
	UNION ALL
	SELECT x.map, x.dur FROM (${rawRows(serverId, from)}) x, cut
	 WHERE x.ts >= cut.t AND x.ok AND x.map IS NOT NULL AND x.map <> ''`
		: sql`
	SELECT x.map, x.dur AS secs FROM (${rawRows(serverId, from)}) x
	 WHERE x.ok AND x.map IS NOT NULL AND x.map <> ''`;

export async function loadAnalytics(env: Env, serverId: string, range: Range): Promise<Analytics> {
	const to = new Date();
	const from = new Date(to.getTime() - RANGE_MS[range]);
	const bucket = BUCKET_S[range];
	const db = env.db;
	// Longer than the raw retention: the hourly rollups carry the older part of the range.
	const rolled = RANGE_MS[range] > settings().rawRetentionDays * 86400000;
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

	const players = (
		await db.execute<{
			steamId: string;
			name: string;
			minutes: string;
			sessions: string;
			kills: string;
			deaths: string;
			lastSeen: Date;
			online: string;
		}>(sql`
				SELECT p.steam_id AS "steamId",
				       (SELECT name FROM player_sessions p2 WHERE p2.steam_id = p.steam_id AND p2.server_id = p.server_id ORDER BY last_seen DESC LIMIT 1) AS name,
				       SUM(EXTRACT(EPOCH FROM (COALESCE(p.left_at, now()) - GREATEST(p.joined_at, ${from}::timestamptz)))) / 60 AS minutes,
				       COUNT(*) AS sessions, SUM(p.kills) AS kills, SUM(p.deaths) AS deaths,
				       MAX(p.last_seen) AS "lastSeen", COUNT(*) FILTER (WHERE p.left_at IS NULL) AS online
				  FROM player_sessions p WHERE p.server_id = ${serverId} AND p.last_seen >= ${from}
				 GROUP BY p.server_id, p.steam_id ORDER BY minutes DESC LIMIT 50`)
	).map((r) => ({
		steamId: r.steamId,
		name: r.name,
		minutes: Math.round(num(r.minutes)),
		sessions: num(r.sessions),
		kills: num(r.kills),
		deaths: num(r.deaths),
		lastSeen: isoOf(r.lastSeen),
		online: num(r.online) > 0
	}));

	const [unique] = await db
		.select({ n: sql<number>`COUNT(DISTINCT ${playerSessions.steamId})` })
		.from(playerSessions)
		.where(and(eq(playerSessions.serverId, serverId), gte(playerSessions.lastSeen, from)));
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
		hourly
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
			 ORDER BY ts DESC LIMIT ${limit}`);
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
