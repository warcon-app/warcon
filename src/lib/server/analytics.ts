// Read side of the analytics tables: one query bundle per server and time range.
import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import type { Env } from './env';
import { matches, playerSessions } from './db/schema';
import { pollSeconds } from './poller';

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
	pollSeconds: number;
	bucketSeconds: number;
	summary: {
		uniquePlayers: number;
		peakPlayers: number;
		avgPlayers: number;
		uptimePct: number | null;
		onlineNow: number;
		samples: number;
		matches: number;
	};
	population: PopulationPoint[];
	maps: MapShare[];
	players: TopPlayer[];
	matches: MatchRow[];
	hourly: { hour: number; avg: number }[];
}

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const isoOf = (v: unknown): string =>
	v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

export async function loadAnalytics(env: Env, serverId: string, range: Range): Promise<Analytics> {
	const to = new Date();
	const from = new Date(to.getTime() - RANGE_MS[range]);
	const bucket = BUCKET_S[range];
	const poll = pollSeconds(env) || 20;
	const db = env.db;

	// time_bucket() would be nicer, but this floor() form works on plain Postgres too.
	const population = (
		await db.execute<{
			b: Date;
			avg: string | null;
			max: number | null;
			cap: number | null;
			ok: string;
			total: string;
		}>(sql`
				SELECT to_timestamp(floor(extract(epoch FROM ts) / ${bucket}) * ${bucket}) AS b,
				       AVG(CASE WHEN ok THEN player_count END) AS avg,
				       MAX(player_count) AS max, MAX(max_players) AS cap,
				       COUNT(*) FILTER (WHERE ok) AS ok, COUNT(*) AS total
				  FROM samples WHERE server_id = ${serverId} AND ts >= ${from}
				 GROUP BY b ORDER BY b`)
	).map((r) => ({
		ts: isoOf(r.b),
		avg: numOrNull(r.avg),
		max: numOrNull(r.max),
		cap: numOrNull(r.cap),
		ok: num(r.ok),
		total: num(r.total)
	}));

	const [totals] = await db.execute<{
		n: string;
		ok: string;
		peak: number | null;
		avg: string | null;
	}>(sql`
			SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE ok) AS ok, MAX(player_count) AS peak,
			       AVG(CASE WHEN ok THEN player_count END) AS avg
			  FROM samples WHERE server_id = ${serverId} AND ts >= ${from}`);

	const maps = (
		await db.execute<{ map: string; n: string; matches: string }>(sql`
				SELECT s.map, COUNT(*) AS n,
				       (SELECT COUNT(*) FROM matches m WHERE m.server_id = s.server_id AND m.map = s.map AND m.started_at >= ${from}) AS matches
				  FROM samples s WHERE s.server_id = ${serverId} AND s.ts >= ${from} AND s.ok AND s.map IS NOT NULL AND s.map <> ''
				 GROUP BY s.server_id, s.map ORDER BY n DESC`)
	).map((r) => ({
		map: r.map,
		minutes: Math.round((num(r.n) * poll) / 60),
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
				       SUM(EXTRACT(EPOCH FROM (p.last_seen - GREATEST(p.joined_at, ${from}::timestamptz))) + ${poll}) / 60 AS minutes,
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
				SELECT EXTRACT(HOUR FROM ts)::int AS hour, AVG(player_count) AS avg
				  FROM samples WHERE server_id = ${serverId} AND ts >= ${from} AND ok
				 GROUP BY hour ORDER BY hour`)
	).map((r) => ({ hour: num(r.hour), avg: num(r.avg) }));

	return {
		range,
		from: from.toISOString(),
		to: to.toISOString(),
		pollSeconds: poll,
		bucketSeconds: bucket,
		summary: {
			uniquePlayers: num(unique?.n),
			peakPlayers: num(totals?.peak),
			avgPlayers: Math.round(num(totals?.avg) * 10) / 10,
			uptimePct:
				totals && num(totals.n) ? Math.round((num(totals.ok) / num(totals.n)) * 1000) / 10 : null,
			onlineNow: num(online?.n),
			samples: num(totals?.n),
			matches: num(matchCount?.n)
		},
		population,
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
