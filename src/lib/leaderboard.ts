// Leaderboards and careers: the vocabulary (ranges, seasons, scopes, metrics, columns), how a board
// request travels in a query string, and the maths that turns stored counts into a result, a
// streak or a ratio. Pure and client-safe; the queries live in $lib/server/leaderboards.ts and
// mirror the result rule below in SQL where they aggregate.
import { SEASON_KEY_RE, type Season, type SeasonWinners, type WinnerCategory } from './seasons';

/** A rolling range, or all time. */
export type FixedRange = '7d' | '30d' | '90d' | 'all';
/**
 * What a board covers: a fixed range, a season (`s:<key>`), or `current`, whatever the
 * organisation's boards open on (its current official season unless it chose otherwise).
 */
export type BoardRange = FixedRange | 'current' | `s:${string}`;
export type BoardScope = 'server' | 'org';
export type BoardMetric =
	| 'kills'
	| 'deaths'
	| 'kd'
	| 'perHour'
	| 'playtime'
	| 'seeded'
	| 'matches'
	| 'wins'
	| 'winRate'
	| 'cash'
	| 'cashPerMin';
export type SortDir = 'asc' | 'desc';

export const BOARD_RANGES: { key: FixedRange; label: string; ms: number | null }[] = [
	{ key: '7d', label: '7 days', ms: 7 * 86400_000 },
	{ key: '30d', label: '30 days', ms: 30 * 86400_000 },
	{ key: '90d', label: '90 days', ms: 90 * 86400_000 },
	{ key: 'all', label: 'All time', ms: null }
];
export const BOARD_METRICS: { key: BoardMetric; label: string }[] = [
	{ key: 'kills', label: 'Kills' },
	{ key: 'deaths', label: 'Deaths' },
	{ key: 'kd', label: 'K/D' },
	{ key: 'perHour', label: 'Kills per hour' },
	{ key: 'playtime', label: 'Playtime' },
	{ key: 'seeded', label: 'Seed time' },
	{ key: 'matches', label: 'Matches' },
	{ key: 'wins', label: 'Wins' },
	{ key: 'winRate', label: 'Win rate' },
	{ key: 'cash', label: 'Cash' },
	{ key: 'cashPerMin', label: 'Cash per minute' }
];
const METRIC_KEYS = new Set<string>(BOARD_METRICS.map((m) => m.key));
const RANGE_KEYS = new Set<string>(BOARD_RANGES.map((r) => r.key));
const isBoardRange = (v: string): v is BoardRange =>
	v === 'current' || RANGE_KEYS.has(v) || (v.startsWith('s:') && SEASON_KEY_RE.test(v.slice(2)));
export const isFixedRange = (v: string): v is FixedRange => RANGE_KEYS.has(v);

/** Ten minutes on an empty server must not top the K/D board: this much playtime, or no rank. */
export const DEFAULT_FLOOR_MINUTES = 60;
export const MAX_FLOOR_MINUTES = 100_000;
export const BOARD_PAGE = 50;
/** How deep a public board goes (the top thousand): each page is a query over the whole range,
 *  and nobody without an account needs to walk a server's every player. */
export const PUBLIC_MAX_PAGE = 20;
/** The board a career rank is read off: all time, by kills, at the default floor. */
export const RANK_METRIC: BoardMetric = 'kills';

export interface BoardQuery {
	scope: BoardScope;
	range: BoardRange;
	sort: BoardMetric;
	dir: SortDir;
	/** 1-based */
	page: number;
	/** the playtime floor, in minutes */
	minMinutes: number;
}

export const DEFAULT_BOARD_QUERY: BoardQuery = {
	scope: 'server',
	range: 'current',
	sort: 'kills',
	dir: 'desc',
	page: 1,
	minMinutes: DEFAULT_FLOOR_MINUTES
};

/**
 * One player's row: everything the board can rank by, as stored counts. Kills, deaths and the
 * match results are summed from the player's match rows (the game's own scoreboard, per match);
 * headshots, team kills, suicides, vehicle kills and streaks are the feed's columns of those
 * rows; playtime, seed time, the name and cash come from sessions.
 */
export interface BoardRow {
	rank: number;
	steamId: string;
	/** the name last seen with, or the id when no session has one */
	name: string;
	minutes: number;
	/**
	 * the whole time of the sessions the cash came from, what cash per minute divides by: a session
	 * that began before the range or season counts all of its cash, so all of its minutes too, and
	 * one still going when a season ended counts in neither; the playtime itself on all time
	 */
	cashMinutes: number;
	/** minutes on with the server low, as the Seeding reward counts them (0 without a rule) */
	seedMinutes: number;
	/** minutes on in matches before any side had scored, the match waiting for its players */
	idleMinutes: number;
	kills: number;
	deaths: number;
	headshots: number;
	teamKills: number;
	suicides: number;
	vehicleKills: number;
	/** the best runs in any one match of the range */
	killStreak: number;
	deathStreak: number;
	matches: number;
	wins: number;
	losses: number;
	draws: number;
	/** cash over the range: the sum of the sessions' cash, each banked across its matches */
	cash: number;
	lastSeen: string | null;
}

/** What a board turned out to cover: the range it read and, for a season, which. */
export interface BoardWhen {
	/** the fixed range, or `s:<key>` */
	range: FixedRange | `s:${string}`;
	season: Season | null;
	/** a finished season: its board no longer changes */
	finished: boolean;
}

export interface BoardView {
	query: BoardQuery;
	when: BoardWhen;
	/** the organisation's seasons that have started, for the picker, newest first */
	seasons: Season[];
	/** a finished season's top three in each category */
	winners: SeasonWinners | null;
	rows: BoardRow[];
	/** players meeting the floor over the whole board */
	total: number;
	pageSize: number;
	/** the last page this reader may ask for (public boards); absent, the board has no ceiling */
	maxPage?: number;
	/** whether the feed's columns (headshots, team kills, suicides, vehicle kills, streaks) can
	 *  exist at all on these servers; kills, deaths and results come from the scoreboard everywhere */
	hasFeed: boolean;
}

const clampInt = (v: string | null, fallback: number, min: number, max: number): number => {
	if (v === null || v === '') return fallback;
	const n = Number(v);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, Math.trunc(n)));
};

/** The board a query string asks for; anything unknown falls back to the default. */
export function parseBoardQuery(params: URLSearchParams, maxPage = 100_000): BoardQuery {
	const range = params.get('range') ?? '';
	const sort = params.get('sort') ?? '';
	return {
		scope: params.get('scope') === 'org' ? 'org' : 'server',
		range: isBoardRange(range) ? range : DEFAULT_BOARD_QUERY.range,
		sort: METRIC_KEYS.has(sort) ? (sort as BoardMetric) : DEFAULT_BOARD_QUERY.sort,
		dir: params.get('dir') === 'asc' ? 'asc' : 'desc',
		page: clampInt(params.get('page'), 1, 1, maxPage),
		minMinutes: clampInt(params.get('minMinutes'), DEFAULT_FLOOR_MINUTES, 0, MAX_FLOOR_MINUTES)
	};
}

/** The query as parameters, defaults left out. */
export function boardQueryParams(q: BoardQuery): Record<string, string> {
	const out: Record<string, string> = {};
	if (q.scope !== 'server') out.scope = q.scope;
	if (q.range !== DEFAULT_BOARD_QUERY.range) out.range = q.range;
	if (q.sort !== DEFAULT_BOARD_QUERY.sort) out.sort = q.sort;
	if (q.dir !== 'desc') out.dir = q.dir;
	if (q.page !== 1) out.page = String(q.page);
	if (q.minMinutes !== DEFAULT_FLOOR_MINUTES) out.minMinutes = String(q.minMinutes);
	return out;
}

/**
 * The board's columns after rank and player, in table order: what each is called on the Seasons
 * tab and above the column, and the metric its header sorts by. Kills always show, since a board
 * opens ranked by them; an organisation's owners may leave any other out of its public boards.
 */
export const BOARD_COLUMNS = [
	{ key: 'playtime', label: 'Playtime', head: 'Playtime', sort: 'playtime' },
	{ key: 'seeded', label: 'Seed time', head: 'Seeded', sort: 'seeded' },
	{ key: 'kills', label: 'Kills', head: 'K', sort: 'kills' },
	{ key: 'deaths', label: 'Deaths', head: 'D', sort: 'deaths' },
	{ key: 'kd', label: 'Kills per death', head: 'K/D', sort: 'kd' },
	{ key: 'perHour', label: 'Kills per hour', head: 'K/h', sort: 'perHour' },
	{ key: 'headshots', label: 'Headshots', head: 'HS', sort: null },
	{ key: 'teamKills', label: 'Team kills', head: 'TK', sort: null },
	{ key: 'matches', label: 'Matches', head: 'Matches', sort: 'matches' },
	{ key: 'results', label: 'Wins, losses, draws', head: 'W-L-D', sort: 'wins' },
	{ key: 'winRate', label: 'Win rate', head: 'Win %', sort: 'winRate' },
	{ key: 'cash', label: 'Cash', head: 'Cash', sort: 'cash' },
	{ key: 'cashPerMin', label: 'Cash per minute', head: '$/min', sort: 'cashPerMin' },
	{ key: 'lastSeen', label: 'Last seen', head: 'Last seen', sort: null }
] as const satisfies readonly {
	key: string;
	label: string;
	head: string;
	sort: BoardMetric | null;
}[];
export type BoardColumn = (typeof BOARD_COLUMNS)[number]['key'];
/** The column no board leaves out. */
export const FIXED_COLUMN: BoardColumn = 'kills';

/**
 * The columns to leave out of an organisation's public boards, as an owner sends them: column
 * keys, never kills, in the table's order with repeats dropped. Null for anything else.
 */
export function hiddenColumns(v: unknown): BoardColumn[] | null {
	if (!Array.isArray(v)) return null;
	const keys = new Set<unknown>(v);
	for (const k of keys)
		if (k === FIXED_COLUMN || !BOARD_COLUMNS.some((c) => c.key === k)) return null;
	return BOARD_COLUMNS.filter((c) => keys.has(c.key)).map((c) => c.key);
}

/** The stored list read back: whatever is not one of today's columns (or is kills) is left out. */
export const storedHidden = (v: unknown): BoardColumn[] =>
	Array.isArray(v)
		? BOARD_COLUMNS.filter((c) => c.key !== FIXED_COLUMN && v.includes(c.key)).map((c) => c.key)
		: [];

/** A public board's query: a sort by a column the organisation leaves out ranks by kills instead. */
export function publicQuery(q: BoardQuery, hidden: readonly BoardColumn[]): BoardQuery {
	const off = BOARD_COLUMNS.some((c) => c.sort === q.sort && hidden.includes(c.key));
	return off ? { ...q, sort: DEFAULT_BOARD_QUERY.sort, dir: DEFAULT_BOARD_QUERY.dir } : q;
}

/** Where a rolling range starts; null for all time. */
export const rangeStart = (range: FixedRange, now = Date.now()): Date | null => {
	const ms = BOARD_RANGES.find((r) => r.key === range)?.ms ?? null;
	return ms === null ? null : new Date(now - ms);
};

// ---- maths -------------------------------------------------------------------------------------

/** Kills per death; kills alone with no deaths; nothing with neither. */
export const kdRatio = (kills: number, deaths: number): number | null =>
	deaths > 0 ? kills / deaths : kills > 0 ? kills : null;

/**
 * Kills per hour of playtime, the wait for players left out: seed time and idle time both count
 * it, mostly over the same minutes, so the larger of the two goes. Nothing without playtime beyond it.
 */
export const perHour = (
	kills: number,
	minutes: number,
	seedMinutes = 0,
	idleMinutes = 0
): number | null => {
	const played = minutes - Math.max(seedMinutes, idleMinutes);
	return played > 0 ? kills / (played / 60) : null;
};

/**
 * Cash per minute of the time it was made in (a board row's cashMinutes), the wait for players
 * left out as for kills per hour; nothing without such time.
 */
export const perMinute = (
	cash: number,
	minutes: number,
	seedMinutes = 0,
	idleMinutes = 0
): number | null => {
	const played = minutes - Math.max(seedMinutes, idleMinutes);
	return played > 0 ? cash / played : null;
};

/** Wins over the matches that had a result; nothing without one. */
export const winRate = (wins: number, losses: number, draws: number): number | null => {
	const played = wins + losses + draws;
	return played > 0 ? wins / played : null;
};

export const meetsFloor = (minutes: number, floorMinutes: number): boolean =>
	minutes >= floorMinutes;

export type MatchResult = 'win' | 'loss' | 'draw' | null;

/** The biggest score in a final_scores document, or 0 when it has none. */
export function topScore(finalScores: unknown): number {
	if (!Array.isArray(finalScores)) return 0;
	let top = 0;
	for (const f of finalScores as { score?: unknown }[]) {
		const n = Number(f && typeof f === 'object' ? f.score : NaN);
		if (Number.isFinite(n) && n > top) top = n;
	}
	return top;
}

/** Whether the faction is one of the match's teams; true when no scoreboard was kept. */
function onScoreboard(finalScores: unknown, faction: string): boolean {
	if (!Array.isArray(finalScores) || !finalScores.length) return true;
	return finalScores.some((f) => f && typeof f === 'object' && f.name === faction);
}

/**
 * A player's result in a match: their faction against the winner. With no winner, a match
 * somebody scored in is a draw; one nobody scored in, or a player with no faction, has no
 * result. Nor has a player whose faction is not on the match's scoreboard: the game's holding
 * team ("White") did not lose. (The board's SQL aggregates mirror this rule.)
 */
export function matchResult(
	winner: string | null,
	finalScores: unknown,
	faction: string | null
): MatchResult {
	if (!faction || !onScoreboard(finalScores, faction)) return null;
	if (winner) return winner === faction ? 'win' : 'loss';
	return topScore(finalScores) > 0 ? 'draw' : null;
}

export interface Streak {
	kind: 'win' | 'loss';
	n: number;
}

/**
 * The run of wins or losses the player is on, newest match first. Matches without a result are
 * skipped; a draw ends the run, so a draw after three wins is no streak at all.
 */
export function streak(results: MatchResult[]): Streak | null {
	let kind: Streak['kind'] | null = null;
	let n = 0;
	for (const r of results) {
		if (r === null) continue;
		if (r === 'draw') break;
		if (kind === null) kind = r;
		if (r !== kind) break;
		n++;
	}
	return kind && n ? { kind, n } : null;
}

/** The number a board column shows for a row, or null where there is nothing to rank. */
export function metricValue(row: BoardRow, metric: BoardMetric): number | null {
	switch (metric) {
		case 'kills':
			return row.kills;
		case 'deaths':
			return row.deaths;
		case 'kd':
			return kdRatio(row.kills, row.deaths);
		case 'perHour':
			return perHour(row.kills, row.minutes, row.seedMinutes, row.idleMinutes);
		case 'playtime':
			return row.minutes;
		case 'seeded':
			return row.seedMinutes;
		case 'matches':
			return row.matches;
		case 'wins':
			return row.wins;
		case 'winRate':
			return winRate(row.wins, row.losses, row.draws);
		case 'cash':
			return row.cash;
		case 'cashPerMin':
			return perMinute(row.cash, row.cashMinutes, row.seedMinutes, row.idleMinutes);
	}
}

// ---- careers -----------------------------------------------------------------------------------

/** The player's line of one match, newest first on a career. */
export interface CareerMatch {
	matchId: number;
	serverId: string;
	serverName: string;
	startedAt: string;
	endedAt: string | null;
	map: string | null;
	faction: string | null;
	result: MatchResult;
	/** time on during the match */
	seconds: number;
	kills: number;
	deaths: number;
	/** the change in the player's cash over the match */
	cashDelta: number;
	headshots: number;
	killStreak: number;
}

export interface CareerGroup {
	key: string;
	matches: number;
	wins: number;
	losses: number;
	draws: number;
	kills: number;
	deaths: number;
}

export interface CareerRank {
	/** 1-based position on the all-time kills board; null when under the floor or never seen */
	server: number | null;
	org: number | null;
	floorMinutes: number;
}

export interface CareerView {
	rank: CareerRank;
	streak: Streak | null;
	matches: number;
	wins: number;
	losses: number;
	draws: number;
	/** over every match that ended: the scoreboard's kills and deaths, time on in matches */
	kills: number;
	deaths: number;
	minutes: number;
	/** the feed's columns, 0 (or null) on servers without a feed */
	headshots: number;
	vehicleKills: number;
	longestM: number | null;
	/** the best runs in any one match */
	killStreak: number;
	deathStreak: number;
	maps: CareerGroup[];
	factions: CareerGroup[];
	/** the last ten matches, newest first */
	last: CareerMatch[];
	/** the organisation's last ten seasons that have started, newest first */
	seasons: CareerSeason[];
}

/** A place the player won when a season finished: first, second or third in a category. */
export interface CareerPlace {
	category: WinnerCategory;
	place: number;
}

/** The player's matches in one season, from the same lines as the rest of the career. */
export interface CareerSeason {
	season: Season;
	matches: number;
	wins: number;
	losses: number;
	draws: number;
	kills: number;
	deaths: number;
	/** their places on this server's board when the season finished; none while it runs */
	places: CareerPlace[];
}

/** Match lines grouped by map or faction (most played first): results, kills and deaths. */
export function groupCareer(
	lines: { key: string | null; result: MatchResult; kills: number; deaths: number }[]
): CareerGroup[] {
	const out = new Map<string, CareerGroup>();
	for (const l of lines) {
		if (!l.key) continue;
		let g = out.get(l.key);
		if (!g) {
			g = { key: l.key, matches: 0, wins: 0, losses: 0, draws: 0, kills: 0, deaths: 0 };
			out.set(l.key, g);
		}
		g.matches++;
		if (l.result === 'win') g.wins++;
		else if (l.result === 'loss') g.losses++;
		else if (l.result === 'draw') g.draws++;
		g.kills += l.kills;
		g.deaths += l.deaths;
	}
	return [...out.values()].sort((a, b) => b.matches - a.matches || b.kills - a.kills);
}
