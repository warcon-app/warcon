// Leaderboards and careers, read at page load from what the worker already writes: kills and
// deaths from the kill feed (killer and victim columns), playtime, seed time and cash from player_sessions,
// and matches from the sessions that overlap a matches row. Nothing is precomputed. The queries
// ride the existing indexes: kills (server_id, ts), player_sessions (server_id, last_seen) and
// (steam_id, joined_at), matches (server_id, started_at).
//
// The overlap between sessions and matches is not a range join. Matches on one server are
// disjoint and follow each other, so the matches a session overlaps are one contiguous run:
// from the match open when the session began (or the first one to start after that) to the
// last match to start before it ended. Each end is one index probe, and the run is then read
// off the primary key. The result of a match for a player (win, loss, draw, none) is the rule
// in $lib/leaderboard, written out again in SQL below for the aggregates.
import { sql } from 'drizzle-orm';
import type { Env } from './env';
import { servers } from './db/schema';
import {
	BOARD_PAGE,
	DEFAULT_FLOOR_MINUTES,
	groupCareer,
	matchResult,
	rangeStart,
	streak,
	type BoardMetric,
	type BoardQuery,
	type BoardRow,
	type BoardView,
	type CareerMatch,
	type CareerView,
	type MatchResult
} from '$lib/leaderboard';

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
const iso = (v: unknown): string | null =>
	v === null || v === undefined ? null : new Date(v as string | Date).toISOString();

/** All time is "since the epoch": one query shape for every range. */
const EPOCH = new Date(0);

/**
 * Per-player totals over these servers since `from`: sessions, kills as killer, deaths as
 * victim and the match results, joined on the SteamID. Players seen by one source only (a
 * kill feed that knows a name the session writer missed) still get a row.
 */
const base = (ids: string[], from: Date) => sql`
	sess AS (
		SELECT steam_id,
		       SUM(EXTRACT(EPOCH FROM (COALESCE(left_at, now()) - GREATEST(joined_at, ${from}::timestamptz)))) / 60 AS minutes,
		       SUM(seed_seconds) / 60.0 AS seed_minutes, SUM(cash) AS cash, MAX(last_seen) AS last_seen
		  FROM player_sessions WHERE server_id IN ${ids} AND last_seen >= ${from}
		 GROUP BY steam_id),
	kl AS (
		SELECT killer_steam_id AS steam_id,
		       COUNT(*) FILTER (WHERE NOT suicide) AS kills,
		       COUNT(*) FILTER (WHERE headshot AND NOT suicide) AS headshots,
		       COUNT(*) FILTER (WHERE team_kill) AS team_kills
		  FROM kills WHERE server_id IN ${ids} AND ts >= ${from} AND killer_steam_id IS NOT NULL
		 GROUP BY killer_steam_id),
	dt AS (
		SELECT victim_steam_id AS steam_id, COUNT(*) AS deaths, COUNT(*) FILTER (WHERE suicide) AS suicides
		  FROM kills WHERE server_id IN ${ids} AND ts >= ${from}
		 GROUP BY victim_steam_id),
	${matchPairs(ids, from, null)},
	mt AS (
		SELECT steam_id, COUNT(*) AS matches,
		       COUNT(*) FILTER (WHERE result = 'win') AS wins,
		       COUNT(*) FILTER (WHERE result = 'loss') AS losses,
		       COUNT(*) FILTER (WHERE result = 'draw') AS draws
		  FROM pairs GROUP BY steam_id),
	base AS (
		SELECT steam_id,
		       COALESCE(sess.minutes, 0) AS minutes, COALESCE(sess.seed_minutes, 0) AS seed_minutes,
		       COALESCE(sess.cash, 0) AS cash, sess.last_seen,
		       COALESCE(kl.kills, 0) AS kills, COALESCE(kl.headshots, 0) AS headshots,
		       COALESCE(kl.team_kills, 0) AS team_kills,
		       COALESCE(dt.deaths, 0) AS deaths, COALESCE(dt.suicides, 0) AS suicides,
		       COALESCE(mt.matches, 0) AS matches, COALESCE(mt.wins, 0) AS wins,
		       COALESCE(mt.losses, 0) AS losses, COALESCE(mt.draws, 0) AS draws
		  FROM sess FULL JOIN kl USING (steam_id) FULL JOIN dt USING (steam_id) FULL JOIN mt USING (steam_id))`;

/**
 * One row per (player, match) the player's sessions overlapped, with the faction of their last
 * session in it and the match's outcome. `steamId` narrows it to one player (a career), else
 * every player seen since `from`.
 */
const matchPairs = (ids: string[], from: Date, steamId: string | null) => sql`
	s AS (
		SELECT id, server_id, steam_id, faction, joined_at, COALESCE(left_at, now()) AS left_at, last_seen
		  FROM player_sessions
		 WHERE server_id IN ${ids} AND last_seen >= ${from}
		   ${steamId === null ? sql`` : sql`AND steam_id = ${steamId}`}),
	bounds AS (
		SELECT s.*, a.id AS last_id,
		       CASE WHEN p.id IS NOT NULL AND COALESCE(p.ended_at, now()) > s.joined_at THEN p.id ELSE n.id END AS first_id
		  FROM s
		  LEFT JOIN LATERAL (SELECT id FROM matches m WHERE m.server_id = s.server_id AND m.started_at < s.left_at
		                      ORDER BY m.started_at DESC LIMIT 1) a ON true
		  LEFT JOIN LATERAL (SELECT id, ended_at FROM matches m WHERE m.server_id = s.server_id AND m.started_at <= s.joined_at
		                      ORDER BY m.started_at DESC LIMIT 1) p ON true
		  LEFT JOIN LATERAL (SELECT id FROM matches m WHERE m.server_id = s.server_id AND m.started_at > s.joined_at
		                      ORDER BY m.started_at LIMIT 1) n ON true),
	pairs AS (
		SELECT DISTINCT ON (b.steam_id, m.id)
		       b.steam_id, m.id AS match_id, m.server_id, m.started_at, m.ended_at, m.map, b.faction,
		       m.winner, m.final_scores,
		       -- the rule of matchResult() in $lib/leaderboard, for the aggregates: the game's
		       -- holding team ("White", a player not yet put on a side) is never a competitor.
		       CASE WHEN b.faction IS NULL OR b.faction = 'White' THEN NULL
		            WHEN m.winner IS NOT NULL THEN CASE WHEN m.winner = b.faction THEN 'win' ELSE 'loss' END
		            WHEN jsonb_typeof(m.final_scores) = 'array'
		                 AND (SELECT MAX((e->>'score')::numeric) FROM jsonb_array_elements(m.final_scores) e) > 0 THEN 'draw'
		            ELSE NULL END AS result
		  FROM bounds b
		  JOIN matches m ON m.server_id = b.server_id AND m.id BETWEEN b.first_id AND b.last_id
		 WHERE b.first_id <= b.last_id AND m.started_at >= ${from}
		 ORDER BY b.steam_id, m.id, b.last_seen DESC)`;

/** How each metric orders the board (see metricValue in $lib/leaderboard). */
const METRIC_SQL: Record<BoardMetric, ReturnType<typeof sql>> = {
	kills: sql`kills`,
	deaths: sql`deaths`,
	kd: sql`CASE WHEN deaths > 0 THEN kills::float / deaths WHEN kills > 0 THEN kills::float ELSE NULL END`,
	perHour: sql`CASE WHEN minutes > 0 THEN kills::float / (minutes / 60) ELSE NULL END`,
	playtime: sql`minutes`,
	seeded: sql`seed_minutes`,
	matches: sql`matches`,
	wins: sql`wins`,
	winRate: sql`CASE WHEN wins + losses + draws > 0 THEN wins::float / (wins + losses + draws) ELSE NULL END`,
	cash: sql`cash`
};

interface BaseRow extends Record<string, unknown> {
	steamId: string;
	name: string | null;
	minutes: string;
	seedMinutes: string;
	cash: string;
	lastSeen: Date | null;
	kills: string;
	headshots: string;
	teamKills: string;
	deaths: string;
	suicides: string;
	matches: string;
	wins: string;
	losses: string;
	draws: string;
	total: string;
}

/** Whether any of these servers has a kill feed (without one the board has playtime alone). */
async function anyFeed(env: Env, ids: string[]): Promise<boolean> {
	if (!ids.length) return false;
	const [row] = await env.db
		.select({ n: sql<number>`COUNT(*)` })
		.from(servers)
		.where(sql`${servers.id} IN ${ids} AND ${servers.feedTokenHash} IS NOT NULL`);
	return num(row?.n) > 0;
}

/** One page of the board over these servers. */
export async function loadBoard(env: Env, ids: string[], q: BoardQuery): Promise<BoardView> {
	const empty: BoardView = { query: q, rows: [], total: 0, pageSize: BOARD_PAGE, hasFeed: false };
	if (!ids.length) return empty;
	const from = rangeStart(q.range) ?? EPOCH;
	const order = q.dir === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
	const offset = (q.page - 1) * BOARD_PAGE;
	const [rowsRaw, hasFeed] = await Promise.all([
		env.db.execute<BaseRow>(sql`
			WITH ${base(ids, from)},
			page AS (
				SELECT *, COUNT(*) OVER () AS total FROM base
				 WHERE minutes >= ${q.minMinutes}
				 ORDER BY ${METRIC_SQL[q.sort]} ${order}, kills DESC, steam_id
				 LIMIT ${BOARD_PAGE} OFFSET ${offset})
			SELECT r.steam_id AS "steamId", r.minutes, r.seed_minutes AS "seedMinutes", r.cash, r.last_seen AS "lastSeen",
			       r.kills, r.headshots, r.team_kills AS "teamKills", r.deaths, r.suicides,
			       r.matches, r.wins, r.losses, r.draws, r.total,
			       (SELECT name FROM player_sessions ps WHERE ps.steam_id = r.steam_id AND ps.server_id IN ${ids}
			         ORDER BY ps.last_seen DESC LIMIT 1) AS name
			  FROM page r`),
		anyFeed(env, ids)
	]);
	const rows = rowsRaw as BaseRow[];
	return {
		query: q,
		rows: rows.map((r, i) => shapeRow(r, offset + i + 1)),
		total: rows.length ? num(rows[0].total) : 0,
		pageSize: BOARD_PAGE,
		hasFeed
	};
}

const shapeRow = (r: BaseRow, rank: number): BoardRow => ({
	rank,
	steamId: r.steamId,
	name: r.name || r.steamId,
	minutes: Math.round(num(r.minutes)),
	seedMinutes: Math.round(num(r.seedMinutes)),
	kills: num(r.kills),
	deaths: num(r.deaths),
	headshots: num(r.headshots),
	teamKills: num(r.teamKills),
	suicides: num(r.suicides),
	matches: num(r.matches),
	wins: num(r.wins),
	losses: num(r.losses),
	draws: num(r.draws),
	cash: num(r.cash),
	lastSeen: iso(r.lastSeen)
});

/** The name the player was last seen with on these servers; null when never seen there. */
export async function lastNameOf(env: Env, ids: string[], steamId: string): Promise<string | null> {
	if (!ids.length) return null;
	const [row] = await env.db.execute<{ name: string }>(sql`
		SELECT name FROM player_sessions WHERE steam_id = ${steamId} AND server_id IN ${ids}
		 ORDER BY last_seen DESC LIMIT 1`);
	return row?.name ?? null;
}

/**
 * The player's position on the all-time kills board over these servers at the default floor:
 * one more than the players above them; null when they are under the floor or unknown.
 */
export async function rankOf(env: Env, ids: string[], steamId: string): Promise<number | null> {
	if (!ids.length) return null;
	const [row] = await env.db.execute<{ qualifies: boolean | null; above: string }>(sql`
		WITH ${base(ids, EPOCH)},
		me AS (SELECT kills, minutes FROM base WHERE steam_id = ${steamId})
		SELECT (SELECT minutes >= ${DEFAULT_FLOOR_MINUTES} FROM me) AS qualifies,
		       (SELECT COUNT(*) FROM base, me WHERE base.minutes >= ${DEFAULT_FLOOR_MINUTES} AND base.kills > me.kills) AS above`);
	return row?.qualifies ? num(row.above) + 1 : null;
}

interface CombatRow extends Record<string, unknown> {
	map: string;
	faction: string | null;
	kills: string;
	deaths: string;
}

interface PairRow extends Record<string, unknown> {
	matchId: string;
	serverId: string;
	startedAt: Date;
	endedAt: Date | null;
	map: string | null;
	faction: string | null;
	winner: string | null;
	finalScores: unknown;
}

/**
 * A player's career over these servers (all time): rank here and across the organisation, the
 * streak, results by map and by faction with the kills seen there, and the last ten matches.
 */
export async function loadCareer(
	env: Env,
	opts: { serverId: string; ids: string[]; nameOf: Map<string, string>; steamId: string }
): Promise<CareerView> {
	const { serverId, ids, steamId } = opts;
	const own = ids.includes(serverId) ? [serverId] : [];
	const [serverRank, orgRank, pairsRaw, combatRaw] = await Promise.all([
		rankOf(env, own, steamId),
		rankOf(env, ids, steamId),
		ids.length
			? env.db.execute<PairRow>(sql`
				WITH ${matchPairs(ids, EPOCH, steamId)}
				SELECT match_id AS "matchId", server_id AS "serverId", started_at AS "startedAt", ended_at AS "endedAt",
				       map, faction, winner, final_scores AS "finalScores"
				  FROM pairs ORDER BY started_at DESC, match_id DESC`)
			: Promise.resolve<PairRow[]>([]),
		ids.length
			? env.db.execute<CombatRow>(sql`
				SELECT map, CASE WHEN killer_steam_id = ${steamId} THEN killer_faction ELSE victim_faction END AS faction,
				       COUNT(*) FILTER (WHERE killer_steam_id = ${steamId} AND NOT suicide) AS kills,
				       COUNT(*) FILTER (WHERE victim_steam_id = ${steamId}) AS deaths
				  FROM kills WHERE server_id IN ${ids} AND (killer_steam_id = ${steamId} OR victim_steam_id = ${steamId})
				 GROUP BY map, faction`)
			: Promise.resolve<CombatRow[]>([])
	]);
	const pairs = pairsRaw as PairRow[];
	const combat = combatRaw as CombatRow[];
	const results = pairs.map((p) => ({
		...p,
		result: matchResult(p.winner, p.finalScores, p.faction)
	}));
	const lastTen = results.slice(0, 10);
	const inMatch = new Map<string, { kills: number; deaths: number }>();
	if (lastTen.length) {
		const rows = await env.db.execute<{ matchRow: string; kills: string; deaths: string }>(sql`
			SELECT match_row AS "matchRow",
			       COUNT(*) FILTER (WHERE killer_steam_id = ${steamId} AND NOT suicide) AS kills,
			       COUNT(*) FILTER (WHERE victim_steam_id = ${steamId}) AS deaths
			  FROM kills WHERE server_id IN ${ids} AND (killer_steam_id = ${steamId} OR victim_steam_id = ${steamId})
			   AND match_row IN ${lastTen.map((m) => Number(m.matchId))}
			 GROUP BY match_row`);
		for (const r of rows)
			inMatch.set(String(r.matchRow), { kills: num(r.kills), deaths: num(r.deaths) });
	}
	const count = (kind: MatchResult) => results.filter((r) => r.result === kind).length;
	const last: CareerMatch[] = lastTen.map((m) => ({
		matchId: Number(m.matchId),
		serverId: m.serverId,
		serverName: opts.nameOf.get(m.serverId) || m.serverId,
		startedAt: new Date(m.startedAt).toISOString(),
		endedAt: iso(m.endedAt),
		map: m.map,
		faction: m.faction,
		result: m.result,
		kills: inMatch.get(String(m.matchId))?.kills ?? 0,
		deaths: inMatch.get(String(m.matchId))?.deaths ?? 0
	}));
	return {
		rank: { server: serverRank, org: orgRank, floorMinutes: DEFAULT_FLOOR_MINUTES },
		streak: streak(results.map((r) => r.result)),
		matches: results.length,
		wins: count('win'),
		losses: count('loss'),
		draws: count('draw'),
		maps: groupCareer(
			results.map((r) => ({ key: r.map, result: r.result })),
			combat.map((c) => ({ key: c.map, kills: num(c.kills), deaths: num(c.deaths) }))
		),
		factions: groupCareer(
			results.map((r) => ({ key: r.faction, result: r.result })),
			combat.map((c) => ({ key: c.faction, kills: num(c.kills), deaths: num(c.deaths) }))
		),
		last
	};
}
