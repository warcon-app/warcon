// Leaderboards and careers, read at page load from what the worker writes: each player's line
// of every match (match_players: the game's own kills and deaths, the feed's headshots, team
// kills, suicides, vehicle kills and streaks, time on and the side played) joined to its match
// for the result, and the sessions for playtime, seed time, the last name and cash.
// Nothing is precomputed. The queries ride the existing indexes: matches (server_id,
// started_at), match_players (match_id, steam_id) and (steam_id, match_id), player_sessions
// (server_id, last_seen) and (steam_id, joined_at). Only matches that have ended count, and a
// match is in a range by when it ended; the match in progress is on the live page. The result
// of a match for a player (win, loss, draw, none) is the rule in $lib/leaderboard, written out
// again in SQL below for the aggregates.
import { sql } from 'drizzle-orm';
import type { Env } from './env';
import { servers } from './db/schema';
import type { RiskPerformance } from './risk';
import {
	BOARD_PAGE,
	DEFAULT_FLOOR_MINUTES,
	groupCareer,
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
 * Per-player totals over these servers since `from`: playtime, seed time, the last look and
 * cash summed over sessions; matches, results, kills, deaths and the feed's columns from
 * the match lines; joined on the SteamID, so a player seen by one source only still gets a row.
 */
const base = (ids: string[], from: Date) => sql`
	sess AS (
		SELECT steam_id,
		       SUM(EXTRACT(EPOCH FROM (COALESCE(left_at, now()) - GREATEST(joined_at, ${from}::timestamptz)))) / 60 AS minutes,
		       SUM(seed_seconds) / 60.0 AS seed_minutes, MAX(last_seen) AS last_seen,
		       SUM(cash) AS cash
		  FROM player_sessions WHERE server_id IN ${ids} AND last_seen >= ${from}
		 GROUP BY steam_id),
	${lines(ids, from, null)},
	mt AS (
		SELECT steam_id, COUNT(*) AS matches,
		       SUM(kills) AS kills, SUM(deaths) AS deaths, SUM(headshots) AS headshots,
		       SUM(team_kills) AS team_kills, SUM(suicides) AS suicides, SUM(vehicle_kills) AS vehicle_kills,
		       MAX(kill_streak) AS kill_streak, MAX(death_streak) AS death_streak,
		       COUNT(*) FILTER (WHERE result = 'win') AS wins,
		       COUNT(*) FILTER (WHERE result = 'loss') AS losses,
		       COUNT(*) FILTER (WHERE result = 'draw') AS draws
		  FROM lines GROUP BY steam_id),
	base AS (
		SELECT steam_id,
		       COALESCE(sess.minutes, 0) AS minutes, COALESCE(sess.seed_minutes, 0) AS seed_minutes,
		       COALESCE(sess.cash, 0) AS cash, sess.last_seen,
		       COALESCE(mt.kills, 0) AS kills, COALESCE(mt.deaths, 0) AS deaths,
		       COALESCE(mt.headshots, 0) AS headshots, COALESCE(mt.team_kills, 0) AS team_kills,
		       COALESCE(mt.suicides, 0) AS suicides, COALESCE(mt.vehicle_kills, 0) AS vehicle_kills,
		       COALESCE(mt.kill_streak, 0) AS kill_streak, COALESCE(mt.death_streak, 0) AS death_streak,
		       COALESCE(mt.matches, 0) AS matches, COALESCE(mt.wins, 0) AS wins,
		       COALESCE(mt.losses, 0) AS losses, COALESCE(mt.draws, 0) AS draws
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
			WITH ${lines(serverIds, EPOCH, steamIds)}
			SELECT steam_id AS "steamId", COUNT(*) AS matches,
			       COUNT(*) FILTER (WHERE result = 'win') AS wins,
			       COUNT(*) FILTER (WHERE result = 'loss') AS losses,
			       COUNT(*) FILTER (WHERE result = 'draw') AS draws,
			       SUM(kills) AS kills, SUM(deaths) AS deaths
			  FROM lines GROUP BY steam_id`)
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
	perHour: sql`CASE WHEN minutes - seed_minutes > 0 THEN kills::float / ((minutes - seed_minutes) / 60) ELSE NULL END`,
	playtime: sql`minutes`,
	seeded: sql`seed_minutes`,
	headshots: sql`headshots`,
	teamKills: sql`team_kills`,
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

/** One page of the board over these servers. */
/** The most rows an export writes: the top ten thousand of the board as it is set. */
export const EXPORT_ROWS = 10_000;

/**
 * `limit` rows of the board as `q` sets it (scope, range, sort, floor), from `offset`: the
 * aggregate covers the whole range either way, then the page, or an export, takes its slice.
 */
async function boardSlice(
	env: Env,
	ids: string[],
	q: BoardQuery,
	limit: number,
	offset: number
): Promise<BaseRow[]> {
	const from = rangeStart(q.range) ?? EPOCH;
	const order = q.dir === 'asc' ? sql`ASC NULLS LAST` : sql`DESC NULLS LAST`;
	return (await env.db.execute<BaseRow>(sql`
		WITH ${base(ids, from)},
		page AS (
			SELECT *, COUNT(*) OVER () AS total FROM base
			 WHERE minutes >= ${q.minMinutes}
			 ORDER BY ${METRIC_SQL[q.sort]} ${order}, kills DESC, steam_id
			 LIMIT ${limit} OFFSET ${offset})
		SELECT r.steam_id AS "steamId", r.minutes, r.seed_minutes AS "seedMinutes", r.cash, r.last_seen AS "lastSeen",
		       r.kills, r.headshots, r.team_kills AS "teamKills", r.deaths, r.suicides,
		       r.vehicle_kills AS "vehicleKills", r.kill_streak AS "killStreak", r.death_streak AS "deathStreak",
		       r.matches, r.wins, r.losses, r.draws, r.total,
		       (SELECT name FROM player_sessions ps WHERE ps.steam_id = r.steam_id AND ps.server_id IN ${ids}
		         ORDER BY ps.last_seen DESC LIMIT 1) AS name
		  FROM page r`)) as BaseRow[];
}

export async function loadBoard(env: Env, ids: string[], q: BoardQuery): Promise<BoardView> {
	const empty: BoardView = { query: q, rows: [], total: 0, pageSize: BOARD_PAGE, hasFeed: false };
	if (!ids.length) return empty;
	const offset = (q.page - 1) * BOARD_PAGE;
	const [rows, hasFeed] = await Promise.all([
		boardSlice(env, ids, q, BOARD_PAGE, offset),
		anyFeed(env, ids)
	]);
	return {
		query: q,
		rows: rows.map((r, i) => shapeRow(r, offset + i + 1)),
		total: rows.length ? num(rows[0].total) : 0,
		pageSize: BOARD_PAGE,
		hasFeed
	};
}

/** The board as `q` sets it from the top, every page of it up to EXPORT_ROWS; `q.page` is ignored. */
export async function exportBoard(env: Env, ids: string[], q: BoardQuery): Promise<BoardRow[]> {
	if (!ids.length) return [];
	return (await boardSlice(env, ids, q, EXPORT_ROWS, 0)).map((r, i) => shapeRow(r, i + 1));
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

/**
 * A player's career over these servers (all time): rank here and across the organisation, the
 * streak, the totals, results by map and by faction, and the last ten matches, all from the
 * player's match lines.
 */
export async function loadCareer(
	env: Env,
	opts: { serverId: string; ids: string[]; nameOf: Map<string, string>; steamId: string }
): Promise<CareerView> {
	const { serverId, ids, steamId } = opts;
	const own = ids.includes(serverId) ? [serverId] : [];
	const [serverRank, orgRank, linesRaw] = await Promise.all([
		rankOf(env, own, steamId),
		rankOf(env, ids, steamId),
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
		last
	};
}
