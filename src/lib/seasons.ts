// Seasons: a name and a start, each running until the next season of its kind starts. The
// official ones are the game's own (Bulkhead's), the same for every community and listed here;
// a community's own are kept per organisation (the seasons table). A season's board is a range
// over the history that is kept anyway, so nothing is reset and a past season is read-only by
// nature. Pure and client-safe; the reads live in $lib/server/seasons.ts.

export type SeasonKind = 'official' | 'custom';

export interface Season {
	/** an official season's key here, a community's season's row id */
	key: string;
	name: string;
	kind: SeasonKind;
	startsAt: string;
	/** when the next season of its kind starts; null while none is set */
	endsAt: string | null;
}

/**
 * WARDOGS's seasons, from the moment each began. Season 1 is the early-access release
 * (10 September 2026); Season 2 launched on 15 October 2026 at 9:00 Pacific (16:00 UTC), Season 3
 * on 12 November 2026 at 08:00 UTC. A season added here after it began still starts on its real
 * date: the boards read the kept history.
 */
export const OFFICIAL_SEASONS: readonly { key: string; name: string; startsAt: string }[] = [
	{ key: 'wardogs-1', name: 'Season 1', startsAt: '2026-09-10T00:00:00.000Z' },
	{ key: 'wardogs-2', name: 'Season 2', startsAt: '2026-10-15T16:00:00.000Z' },
	{ key: 'wardogs-3', name: 'Season 3', startsAt: '2026-11-12T08:00:00.000Z' }
];

/** How a season is named in a board's range: `s:<key>`. */
export const SEASON_KEY_RE = /^[A-Za-z0-9-]{1,64}$/;

/** Seasons of one kind in start order, each ending where the next begins. */
export function chainSeasons(
	kind: SeasonKind,
	list: readonly { key: string; name: string; startsAt: string }[]
): Season[] {
	const sorted = [...list].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
	return sorted.map((s, i) => ({
		key: s.key,
		name: s.name,
		kind,
		startsAt: s.startsAt,
		endsAt: sorted[i + 1]?.startsAt ?? null
	}));
}

export const isStarted = (s: Season, now = Date.now()): boolean => Date.parse(s.startsAt) <= now;
export const isFinished = (s: Season, now = Date.now()): boolean =>
	s.endsAt !== null && Date.parse(s.endsAt) <= now;

/** The season of a kind running at `now`, or null. */
export function currentSeason(
	seasons: readonly Season[],
	kind: SeasonKind,
	now = Date.now()
): Season | null {
	return seasons.find((s) => s.kind === kind && isStarted(s, now) && !isFinished(s, now)) ?? null;
}

/** What an organisation's boards open on when nobody picked anything. */
export type BoardOpens = 'official' | 'custom' | '30d' | 'all';
export const BOARD_OPENS: readonly { key: BoardOpens; label: string }[] = [
	{ key: 'official', label: 'The current official season' },
	{ key: 'custom', label: 'Our current season' },
	{ key: '30d', label: 'The last 30 days' },
	{ key: 'all', label: 'All time' }
];
export const isBoardOpens = (v: unknown): v is BoardOpens => BOARD_OPENS.some((o) => o.key === v);

/** A finished season's top three in each category. */
export interface SeasonPlace {
	steamId: string;
	name: string;
	value: number;
}
export type WinnerCategory = 'kills' | 'kd' | 'playtime' | 'wins';
export const WINNER_CATEGORIES: readonly { key: WinnerCategory; label: string }[] = [
	{ key: 'kills', label: 'Most kills' },
	{ key: 'kd', label: 'Best K/D' },
	{ key: 'playtime', label: 'Most playtime' },
	{ key: 'wins', label: 'Most wins' }
];
export type SeasonWinners = Record<WinnerCategory, SeasonPlace[]>;
/** One lucky match must not win K/D: a winner on it played at least this many in the season. */
export const WINNER_MIN_MATCHES = 10;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A season's day in UTC: "15 Oct 2026", or "15 Oct" short. Spelled out here rather than by Intl,
 * whose month names differ between the server and the browser ("Sep", "Sept").
 */
export function seasonDay(iso: string, short = false): string {
	const d = new Date(iso);
	const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
	return short ? day : `${day} ${d.getUTCFullYear()}`;
}

/**
 * When a season runs, in UTC days: "since 15 Oct 2026", "10 Sep – 15 Oct 2026" (both years when
 * they differ), "from 1 Nov 2026"; `short` leaves the years off ("since 15 Oct").
 */
export function seasonSpan(s: Season, now = Date.now(), short = false): string {
	const day = (iso: string) => seasonDay(iso, short);
	if (!isStarted(s, now)) return `from ${day(s.startsAt)}`;
	if (s.endsAt && isFinished(s, now)) {
		const sameYear = s.startsAt.slice(0, 4) === s.endsAt.slice(0, 4);
		return `${seasonDay(s.startsAt, short || sameYear)} – ${day(s.endsAt)}`;
	}
	return `since ${day(s.startsAt)}`;
}

/** The season of the same kind that starts when this one ends, among these. */
export const nextSeason = (seasons: readonly Season[], s: Season): Season | null =>
	(s.endsAt && seasons.find((x) => x.kind === s.kind && x.startsAt === s.endsAt)) || null;
