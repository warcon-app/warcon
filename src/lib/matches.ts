// Match history: the vocabulary of the Matches tab and a match page (panel and public), and the
// maths that turns a match's player lines into awards and rates. Pure and client-safe; the
// queries live in $lib/server/matches.ts.
import { kdRatio, type MatchResult } from './leaderboard';

/** One match as the list shows it. */
export interface MatchSummary {
	id: number;
	startedAt: string;
	/** null while in progress */
	endedAt: string | null;
	map: string | null;
	experiences: string | null;
	lighting: string | null;
	peakPlayers: number;
	/** how many players have a line of it (everyone who was on, once it ended) */
	players: number;
	finalScores: { name: string; score: number }[] | null;
	winner: string | null;
}

/** A player's line of the match, as the scoreboard shows it. */
export interface MatchLine {
	/** on a public page, a stand-in that is no SteamID for a player who played the match in the
	 *  game's anonymous mode (publicMatch) */
	steamId: string;
	name: string;
	/** the name the other players saw in place of `name`: the player was in the game's anonymous
	 *  mode during the match ($lib/anonymous). There only then, and only for staff. */
	hiddenName?: string;
	faction: string | null;
	seconds: number;
	kills: number;
	deaths: number;
	cashDelta: number;
	headshots: number;
	teamKills: number;
	suicides: number;
	vehicleKills: number;
	longestM: number | null;
	killStreak: number;
	deathStreak: number;
	result: MatchResult;
}

/** A faction as the server's last look saw it: its colour, and its score in the match now on. */
export interface LiveFaction {
	name: string;
	colorHex: string | null;
	score: number;
}

/** One page of a server's match history, newest first. */
export interface MatchListView {
	matches: MatchSummary[];
	/** the server's factions now: colours for the history, scores for the match in progress */
	live: LiveFaction[];
	/** 1-based */
	page: number;
	pageSize: number;
	total: number;
	pages: number;
}

/** How many pages a total makes; never fewer than one. */
export const pagesOf = (total: number, pageSize: number): number =>
	Math.max(1, Math.ceil(total / pageSize));

/** The page a query string asks for: a whole number from 1, else the first. */
export function parsePage(raw: string | null | undefined): number {
	const n = Number(raw);
	return Number.isInteger(n) && n >= 1 ? Math.min(n, 100_000) : 1;
}

/** One point of the score timeline: seconds into the match, then each faction's score in the
 *  order of `factions`. */
export type TimelinePoint = number[];

export interface MatchAward {
	key: 'kills' | 'kd' | 'longest' | 'streak' | 'cash';
	label: string;
	steamId: string;
	name: string;
	/** the figure, already formatted */
	value: string;
}

/** A match page: the match, its lines, the score timeline and the awards. */
export interface MatchView {
	match: MatchSummary;
	/** the factions in scoreboard order, with their colours where the last look knew them */
	factions: { name: string; colorHex: string | null }[];
	lines: MatchLine[];
	timeline: TimelinePoint[];
	awards: MatchAward[];
	/** how many kills the feed recorded for it; 0 on a server without a feed */
	kills: number;
	/** whether the server has a kill feed, so the feed columns mean something */
	hasFeed: boolean;
}

/** How long a match must have lasted for awards to mean anything. */
export const AWARD_MIN_SECONDS = 20 * 60;
/** Best K/D is judged among players with at least this many kills. */
export const AWARD_MIN_KILLS = 10;

/** A match that ended with no scores: closed by a restart or an outage, not played out. */
export const abandoned = (m: Pick<MatchSummary, 'endedAt' | 'finalScores'>): boolean =>
	m.endedAt !== null && !m.finalScores?.length;

/** Seconds a match lasted, or has lasted so far. */
export const durationOf = (m: Pick<MatchSummary, 'startedAt' | 'endedAt'>, now = Date.now()) =>
	Math.max(
		0,
		Math.round(((m.endedAt ? Date.parse(m.endedAt) : now) - Date.parse(m.startedAt)) / 1000)
	);

/** Kills per minute of time on; nothing without time. */
export const perMinute = (kills: number, seconds: number): number | null =>
	seconds > 0 ? kills / (seconds / 60) : null;

/**
 * The match's awards, judged at read time: most kills, best K/D (at ten kills or more), the
 * longest shot, the best kill streak and the biggest gain in cash. A tie goes to the first in
 * the lines' order (kills first), and a match shorter than twenty minutes gets none.
 */
export function awardsFor(lines: MatchLine[], durationSeconds: number): MatchAward[] {
	if (durationSeconds < AWARD_MIN_SECONDS || !lines.length) return [];
	const out: MatchAward[] = [];
	const best = <T extends number | null>(
		pick: (l: MatchLine) => T,
		better: (a: number, b: number) => boolean
	): { line: MatchLine; value: number } | null => {
		let top: { line: MatchLine; value: number } | null = null;
		for (const l of lines) {
			const v = pick(l);
			if (v === null || v === undefined) continue;
			if (!top || better(v, top.value)) top = { line: l, value: v };
		}
		return top;
	};
	const more = (a: number, b: number) => a > b;
	const kills = best((l) => l.kills, more);
	if (kills && kills.value > 0)
		out.push({
			key: 'kills',
			label: 'Most kills',
			steamId: kills.line.steamId,
			name: kills.line.name,
			value: String(kills.value)
		});
	const kd = best((l) => (l.kills >= AWARD_MIN_KILLS ? kdRatio(l.kills, l.deaths) : null), more);
	if (kd)
		out.push({
			key: 'kd',
			label: 'Best K/D',
			steamId: kd.line.steamId,
			name: kd.line.name,
			value: kd.value.toFixed(2)
		});
	const longest = best((l) => l.longestM, more);
	if (longest && longest.value > 0)
		out.push({
			key: 'longest',
			label: 'Longest shot',
			steamId: longest.line.steamId,
			name: longest.line.name,
			value: `${Math.round(longest.value)} m`
		});
	const streak = best((l) => l.killStreak, more);
	if (streak && streak.value >= 3)
		out.push({
			key: 'streak',
			label: 'Best streak',
			steamId: streak.line.steamId,
			name: streak.line.name,
			value: String(streak.value)
		});
	const cash = best((l) => l.cashDelta, more);
	if (cash && cash.value > 0)
		out.push({
			key: 'cash',
			label: 'Richest match',
			steamId: cash.line.steamId,
			name: cash.line.name,
			value: `+$${Math.round(cash.value).toLocaleString('en-US')}`
		});
	return out;
}

/** One side's players in a match, as its scoreboard shows them; `name` null for the unassigned. */
export interface MatchTeam {
	name: string | null;
	result: MatchResult;
	lines: MatchLine[];
}

/**
 * A match's players by the side they ended on: the sides by final score, highest first (in
 * scoreboard order when the match has no scores), then any other side a player was on, then the
 * players never on a side. Each side keeps the order of `lines`, so one sort orders every table.
 */
export function matchTeams(
	view: Pick<MatchView, 'match' | 'factions'>,
	lines: MatchLine[]
): MatchTeam[] {
	const scored = [...(view.match.finalScores ?? [])].sort((a, b) => b.score - a.score);
	const order = (scored.length ? scored : view.factions).map((f) => f.name);
	const sides = new Map<string, MatchLine[]>();
	const unassigned: MatchLine[] = [];
	for (const l of lines) {
		if (!l.faction) unassigned.push(l);
		else sides.get(l.faction)?.push(l) ?? sides.set(l.faction, [l]);
	}
	const known = order.filter((name) => sides.has(name));
	const others = [...sides.keys()].filter((name) => !order.includes(name)).sort();
	const teams: MatchTeam[] = [...known, ...others].map((name) => {
		const of = sides.get(name)!;
		return { name, result: of[0].result, lines: of };
	});
	if (unassigned.length) teams.push({ name: null, result: null, lines: unassigned });
	return teams;
}

/** "1 h 42 min", "47 min", "40 s": how long a match lasted, in its two coarsest units. */
export function fmtLength(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	if (s < 60) return `${s} s`;
	const h = Math.floor(s / 3600);
	const m = Math.round((s % 3600) / 60);
	if (h && m) return `${h} h ${m} min`;
	if (h) return `${h} h`;
	return `${m} min`;
}

/** The match's result as one line: the winner and every final score, or why there is none. */
export function resultLine(m: Pick<MatchSummary, 'endedAt' | 'finalScores' | 'winner'>): {
	kind: 'won' | 'draw' | 'abandoned' | 'running';
	scores: string;
} {
	if (m.endedAt === null) return { kind: 'running', scores: '' };
	if (abandoned(m)) return { kind: 'abandoned', scores: '' };
	const scores = [...(m.finalScores ?? [])]
		.sort((a, b) => b.score - a.score)
		.map((f) => `${f.name} ${f.score}`)
		.join(' · ');
	return { kind: m.winner ? 'won' : 'draw', scores };
}
