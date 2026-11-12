import type { Catalog, FactionScore } from './types';

export const fmtTime = (value: string | number | Date | null | undefined): string => {
	if (value === null || value === undefined || value === '') return '—';
	const d = new Date(value);
	if (Number.isNaN(d.getTime())) return String(value);
	return d.toLocaleString(undefined, {
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit'
	});
};

/**
 * An ISO timestamp as the local wall-clock value a datetime-local input holds (YYYY-MM-DDTHH:MM),
 * or '' when it is not a date. toISOString() alone would put the UTC clock in a field the browser
 * reads as local time, shifting the filter by the timezone offset on every apply.
 */
export function toDatetimeLocal(iso: string | null | undefined): string {
	if (!iso) return '';
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return '';
	return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

export const fmtDuration = (sec: number | null | undefined): string => {
	if (sec === null || sec === undefined) return '—';
	const s = Math.max(0, Math.floor(sec));
	const hh = Math.floor(s / 3600);
	const mm = Math.floor((s % 3600) / 60);
	const ss = s % 60;
	return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
};

/** A span of time in its coarsest readable unit: "40 s", "12 min", "3 h", "2 days". */
export function fmtSpan(ms: number): string {
	const s = Math.max(0, Math.round(ms / 1000));
	if (s < 60) return `${s} s`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m} min`;
	const h = Math.round(m / 60);
	if (h < 36) return `${h} h`;
	const d = Math.round(h / 24);
	return `${d} day${d === 1 ? '' : 's'}`;
}

/**
 * How long ago a moment was, for status lines that are read at a glance: "just now", "2 min ago",
 * "4 h ago", "3 days ago"; past a month the date itself, since "47 days ago" is not read.
 */
export function fmtAgo(value: string | number | Date, now = Date.now()): string {
	const t = new Date(value).getTime();
	if (Number.isNaN(t)) return String(value);
	const ms = Math.max(0, now - t);
	if (ms < 45_000) return 'just now';
	if (ms > 31 * 86400_000)
		return new Date(t).toLocaleDateString(undefined, {
			year: 'numeric',
			month: 'short',
			day: '2-digit'
		});
	return `${fmtSpan(ms)} ago`;
}

/** Minutes of playtime in the unit that reads best: "45 min", "2.5 h". */
export const fmtMinutes = (m: number): string =>
	m >= 90 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`;

export const fmtNum = (n: number | null | undefined): string =>
	n === null || n === undefined ? '—' : Number(n).toLocaleString();

export function prettify(id: string | null | undefined): string {
	return String(id || '')
		.replace(/[_-]+/g, ' ')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.trim();
}

/** "Day Clear, Day Late Gray and Day Late Rain": a list as a sentence has it. */
export const andList = (items: string[]): string =>
	items.length > 1
		? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
		: (items[0] ?? '');

export const initials = (name: string): string =>
	name
		.split(/\s+/)
		.map((w) => w[0] || '')
		.join('')
		.slice(0, 2)
		.toUpperCase() || '?';

// --- game labels ---------------------------------------------------------------

/**
 * Looked up with names the game and the config document give, so neither table below has a
 * prototype: a map called `constructor` finds nothing in them rather than a function of Object's.
 */
const table = <T>(entries: Record<string, T>): Record<string, T> =>
	Object.assign(Object.create(null), entries);

export const MAP_DISPLAY: Record<string, string> = table({
	Kavkazi: 'Bakurani',
	Europe: 'Ozeti',
	NorthAmerica: 'Zestafona',
	Russia: 'Sabatulo'
});
/**
 * The catalog id of a map however it was named: the status route gives the id ("NorthAmerica"),
 * the kill feed has been seen giving the name players know ("Zestafona"). Unknown names pass.
 */
export function mapId(name: string): string {
	if (MAP_DISPLAY[name]) return name;
	const shown = prettify(name).toLowerCase();
	return Object.keys(MAP_DISPLAY).find((id) => MAP_DISPLAY[id].toLowerCase() === shown) ?? name;
}
/**
 * Whether an experience is a modifier (Infantry Only, Hardcore, Limited Gear) and not a game mode.
 * The game's lists do not say which an id is; the ids do: a game mode is named for its place
 * (`Moscow_KOTH_01`), a modifier for the mode it changes (`KOTH_LimitedGear`), so a modifier the
 * panel has not heard of is still told apart.
 */
export const isMod = (id: string) => /^KOTH_|infantry|hardcore|limitedgear/i.test(id);
/**
 * Whether a rotation entry's experiences name no game mode for a modifier that needs one. The
 * season's notes say so of Limited Gear ("an entry with only KOTH_LimitedGear has no game mode"
 * and starts no match). Whether Infantry Only or Hardcore alone is the same is not known (the
 * official console's demo data has such an entry), so those are not held to it.
 */
export const lacksGameMode = (experiences: string[]): boolean =>
	experiences.length > 0 &&
	experiences.every(isMod) &&
	experiences.some((id) => /limitedgear/i.test(id));

/**
 * The lightings a map takes, where it does not take them all, by the map's id in lower case.
 * Sabatulo takes four (Season 3). The game gives one list of lightings for every map, so nothing a
 * server sends says this: the official console carries the same table and has art for these four
 * alone. The season's notes spell the third DayLateGrey; the game's id is DayLateGray.
 */
const MAP_LIGHTINGS: Record<string, string[]> = table({
	russia: ['DayClear', 'DayLateClear', 'DayLateGray', 'DayLateRain']
});
const ownLightings = (map: string | null | undefined) =>
	map ? MAP_LIGHTINGS[mapId(map).toLowerCase()] : undefined;
/** Whether the map takes only some of the game's lightings. */
export const limitsLightings = (map: string | null | undefined): boolean => !!ownLightings(map);
/** Whether a map takes a lighting: every map takes every lighting, but for the maps named above. */
export function takesLighting(map: string | null | undefined, lighting: string): boolean {
	const own = ownLightings(map);
	const id = lighting.trim().toLowerCase();
	return !own || own.some((l) => l.toLowerCase() === id);
}
/** The lightings of a list that a map takes: none, should the list hold none of them. */
export const lightingsOn = <T extends { id: string }>(
	map: string | null | undefined,
	all: T[]
): T[] => all.filter((l) => takesLighting(map, l.id));

export const mapLabel = (catalog: Catalog, id: string) =>
	MAP_DISPLAY[id] || catalog.maps.find((m) => m.id === id)?.display || prettify(id) || '—';
/** The map's display name where no catalog is at hand (dashboard cards). */
export const mapName = (id: string | null | undefined) =>
	(id && MAP_DISPLAY[id]) || prettify(id) || '—';

export const lightingLabel = (catalog: Catalog, id: string) =>
	catalog.lightings.find((l) => l.id === id)?.display || prettify(id) || '—';

export const expLabel = (catalog: Catalog, id: string) => {
	// A modifier is named from its id, with or without the mode's prefix: a live Season 3 server
	// lists `LimitedGear` beside `KOTH_LimitedGear`, each with its id for a display name.
	if (isMod(id)) return prettify(id.replace(/^KOTH_/i, ''));
	if (/koth/i.test(id)) return 'King of the Hill';
	return catalog.experiences.find((e) => e.id === id)?.display || prettify(id);
};

export const expSetLabel = (catalog: Catalog, ids: string[] | null | undefined) => {
	const list = ids || [];
	if (!list.length) return '—';
	const mode = list.find((i) => !isMod(i));
	return [
		mode ? expLabel(catalog, mode) : null,
		...list.filter(isMod).map((i) => expLabel(catalog, i))
	]
		.filter(Boolean)
		.join(' + ');
};

export const zoneLabel = (tag: string | null | undefined) => {
	if (!tag || /^none$/i.test(tag)) return 'Default';
	return prettify(
		String(tag)
			.replace(/^ZoneAlternator\./i, '')
			.replace(/\./g, ' ')
	);
};

/**
 * A faction colour from the game as `#rrggbb`, else ''. It lands in style attributes, where
 * anything else could carry CSS: a background image that reports every viewer, an overlay.
 */
export function hexColor(v: unknown): string {
	return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : '';
}

/** Faction scores as the game sent them, kept only in the shapes the panel renders: a name, a
 *  `#rrggbb` colour or '', a finite number. */
export function saneScores(raw: unknown): FactionScore[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
		.map((f) => ({
			name: String(f.name ?? ''),
			colorHex: hexColor(f.colorHex),
			score: Number.isFinite(Number(f.score)) ? Number(f.score) : 0
		}));
}

const FACTION_FALLBACK: Record<string, string> = { RED: '#D86060', BLU: '#5B95D8', GRN: '#7BC462' };
export function factionColor(
	faction: string | null | undefined,
	scores?: FactionScore[] | null
): string {
	if (!faction) return '#5E5E66';
	const hit = (scores || []).find((s) => s.name === faction);
	return hexColor(hit?.colorHex) || FACTION_FALLBACK[faction] || '#5E5E66';
}

export function prettyJson(text: string): string {
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

/** One decimal below a hundred, whole numbers above: 6.2, 12.9, 318. */
const scaled = (v: number) => (v < 100 ? v.toFixed(1) : String(Math.round(v)));

/** 6.2 GB, 640 MB, 48 KB, 812 B. */
export function fmtBytes(bytes: number): string {
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let v = Math.max(0, bytes);
	let i = 0;
	while (v >= 1000 && i < units.length - 1) {
		v /= 1000;
		i++;
	}
	return `${i === 0 ? Math.round(v) : scaled(v)} ${units[i]}`;
}

/** 12.9 M, 318 K, 964: row counts and other big tallies at a glance. */
export function fmtCompact(n: number): string {
	const v = Math.max(0, n);
	if (v >= 1e6) return `${scaled(v / 1e6)} M`;
	if (v >= 1e3) return `${scaled(v / 1e3)} K`;
	return String(Math.round(v));
}

/**
 * The Steam name to show under an in-game name, or null when there is none or the in-game name
 * already carries it (a clan tag around the same name): what a name that hides the player, such
 * as a streamer's, does not say.
 */
export function steamNameBeside(inGame: string, steam: string | null | undefined): string | null {
	const name = (steam ?? '').trim();
	if (!name) return null;
	const fold = (v: string) => v.normalize('NFKC').toLowerCase();
	const whole = fold(inGame);
	const part = fold(name);
	// Carried only where it stands on its own (a clan tag around it), not inside another word:
	// "dan" is not in "Jordan".
	const wordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
	for (let at = whole.indexOf(part); at >= 0; at = whole.indexOf(part, at + 1))
		if (!wordChar(whole[at - 1]) && !wordChar(whole[at + part.length])) return null;
	return name;
}
