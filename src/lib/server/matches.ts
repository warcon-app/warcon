// Match history, read at page load: the list of a server's matches (the matches table alone,
// newest first, by page), and one match with every player's line, the score timeline from the
// samples of its window, and the awards. The match in progress is on the live page, not here: a
// match has a page once it has ended.
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { Env } from './env';
import { matches, matchPlayers, samples, serverLive, servers } from './db/schema';
import type { KillsOfMatch } from './feed';
import { matchResult } from '$lib/leaderboard';
import {
	awardsFor,
	durationOf,
	pagesOf,
	type LiveFaction,
	type MatchLine,
	type MatchListView,
	type MatchSummary,
	type MatchView,
	type TimelinePoint
} from '$lib/matches';

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
type Scores = { name: string; score: number }[];
const scoresOf = (v: unknown): Scores | null =>
	Array.isArray(v) && v.length
		? (v as Scores).map((f) => ({ name: f.name, score: Number(f.score) }))
		: null;

const summary = (m: typeof matches.$inferSelect, players: number): MatchSummary => ({
	id: m.id,
	startedAt: m.startedAt.toISOString(),
	endedAt: m.endedAt ? m.endedAt.toISOString() : null,
	map: m.map,
	experiences: m.experiences,
	lighting: m.lighting,
	peakPlayers: m.peakPlayers,
	players,
	finalScores: scoresOf(m.finalScores),
	winner: m.winner
});

/** Matches a page of the panel's tab holds. */
export const MATCHES_PAGE = 50;
/** Matches a page of the public list holds: cards, so fewer. */
export const PUBLIC_MATCHES_PAGE = 20;
/** How many of a match's kills a page shows at once. */
export const MATCH_KILLS_PAGE = 100;

/**
 * The server's factions as its last look saw them, with colours and the scores of the match
 * now running. A finished match keeps names and scores only, and a server's factions persist
 * from match to match, so this colours the history and shows the match in progress.
 */
export async function liveFactions(env: Env, serverId: string): Promise<LiveFaction[]> {
	const [live] = await env.db
		.select({ status: serverLive.status })
		.from(serverLive)
		.where(eq(serverLive.serverId, serverId));
	const scores =
		(live?.status as { scores?: { name: string; colorHex?: string; score?: number }[] } | null)
			?.scores ?? [];
	return scores.map((f) => ({ name: f.name, colorHex: f.colorHex || null, score: num(f.score) }));
}

/** One page of the server's matches, newest first, and how many there are in all. */
export async function listMatches(
	env: Env,
	serverId: string,
	page: number,
	pageSize: number
): Promise<{ matches: MatchSummary[]; total: number }> {
	const [[count], rows] = await Promise.all([
		env.db
			.select({ n: sql<string>`COUNT(*)` })
			.from(matches)
			.where(eq(matches.serverId, serverId)),
		env.db
			.select({
				match: matches,
				players: sql<string>`(SELECT COUNT(*) FROM match_players p WHERE p.match_id = ${matches.id})`
			})
			.from(matches)
			.where(eq(matches.serverId, serverId))
			.orderBy(desc(matches.id))
			.limit(pageSize)
			.offset((page - 1) * pageSize)
	]);
	return { matches: rows.map((r) => summary(r.match, num(r.players))), total: num(count?.n) };
}

/** A page of matches as the list routes and loads answer it. */
export async function matchListView(
	env: Env,
	serverId: string,
	page: number,
	pageSize: number
): Promise<MatchListView> {
	const [{ matches: rows, total }, live] = await Promise.all([
		listMatches(env, serverId, page, pageSize),
		liveFactions(env, serverId)
	]);
	return { matches: rows, live, page, pageSize, total, pages: pagesOf(total, pageSize) };
}

/**
 * One match of the server that has ended, with everything its page shows, or null when there
 * is no such match here (another server's id is not found either).
 */
export async function loadMatch(
	env: Env,
	serverId: string,
	matchId: number
): Promise<MatchView | null> {
	const [m] = await env.db
		.select()
		.from(matches)
		.where(and(eq(matches.id, matchId), eq(matches.serverId, serverId), isNotNull(matches.endedAt)))
		.limit(1);
	if (!m || !m.endedAt) return null;
	const finalScores = scoresOf(m.finalScores);
	const [rows, points, [feed], live, [killCount]] = await Promise.all([
		env.db
			.select()
			.from(matchPlayers)
			.where(eq(matchPlayers.matchId, matchId))
			.orderBy(desc(matchPlayers.kills), desc(matchPlayers.seconds), matchPlayers.steamId),
		// The samples of the match's window. The look that saw the boundary writes its sample at
		// the match's end with the next match's scores already on it, so the window stops short of it.
		env.db
			.select({ ts: samples.ts, scores: samples.scores })
			.from(samples)
			.where(
				and(
					eq(samples.serverId, serverId),
					eq(samples.ok, true),
					sql`${samples.ts} >= ${m.startedAt} AND ${samples.ts} < ${m.endedAt}`
				)
			)
			.orderBy(samples.ts),
		env.db
			.select({ on: sql<boolean>`${servers.feedTokenHash} IS NOT NULL` })
			.from(servers)
			.where(eq(servers.id, serverId)),
		liveFactions(env, serverId),
		env.db.execute<{ n: string }>(sql`
			SELECT COUNT(*) AS n FROM kills
			 WHERE event_type = 'killed' AND parsed_kill
			   AND server_id = ${serverId} AND ts >= ${new Date(m.startedAt.getTime() - 120_000)} AND match_row = ${matchId}::bigint`)
	]);
	const lines: MatchLine[] = rows.map((r) => ({
		steamId: r.steamId,
		name: r.name,
		faction: r.faction,
		seconds: r.seconds,
		kills: r.kills,
		deaths: r.deaths,
		cashDelta: r.cashDelta,
		headshots: r.headshots,
		teamKills: r.teamKills,
		suicides: r.suicides,
		vehicleKills: r.vehicleKills,
		longestM: r.longestM,
		killStreak: r.killStreak,
		deathStreak: r.deathStreak,
		result: matchResult(m.winner, m.finalScores, r.faction)
	}));
	// The factions in scoreboard order: the final scores, else whatever the samples or the lines
	// name. Colours come from the last look's status, which the samples do not keep.
	const names = finalScores?.map((f) => f.name) ?? [];
	for (const p of points)
		for (const f of scoresOf(p.scores) ?? []) if (!names.includes(f.name)) names.push(f.name);
	for (const l of lines) if (l.faction && !names.includes(l.faction)) names.push(l.faction);
	const factions = names.map((name) => ({
		name,
		colorHex: live.find((f) => f.name === name)?.colorHex || null
	}));
	const t0 = m.startedAt.getTime();
	const timeline: TimelinePoint[] = [];
	for (const p of points) {
		const s = scoresOf(p.scores);
		if (!s) continue;
		timeline.push([
			Math.round((p.ts.getTime() - t0) / 1000),
			...names.map((n) => s.find((f) => f.name === n)?.score ?? 0)
		]);
	}
	const match = summary(m, lines.length);
	return {
		match,
		factions,
		lines,
		timeline,
		awards: awardsFor(lines, durationOf(match)),
		kills: num(killCount?.n),
		hasFeed: !!feed?.on
	};
}

/** A match id as a path carries it, or null for anything that is not one. */
export const parseMatchId = (raw: string | null | undefined): number | null =>
	raw && /^\d{1,18}$/.test(raw) ? Number(raw) : null;

/**
 * The window of one of the server's matches for a kills read (feed.ts), or null when there is no
 * such match here: the rows carry the match's id, and its window on (server_id, ts) is what the
 * index serves. A kill received up to two minutes before the row was opened may still be its.
 */
export async function matchWindow(
	env: Env,
	serverId: string,
	matchId: number
): Promise<KillsOfMatch | null> {
	const [m] = await env.db
		.select({ startedAt: matches.startedAt, endedAt: matches.endedAt })
		.from(matches)
		.where(and(eq(matches.id, matchId), eq(matches.serverId, serverId)))
		.limit(1);
	if (!m) return null;
	return {
		matchRow: matchId,
		from: new Date(m.startedAt.getTime() - 120_000),
		to: m.endedAt ? new Date(m.endedAt.getTime() + 120_000) : null
	};
}
