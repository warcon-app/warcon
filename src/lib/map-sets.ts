// The organisation's map sets: rotations saved under a name (an infantry set, a standard one), so a
// server's whole rotation can be swapped for one in a single apply and switched back later. A set
// is a name and its rotation entries, the same entries the Map rotation tab edits; whether the
// rotation is on, and Ordered or Random, stay as each server has them. Shared by the owners'
// editor, the Map rotation tab and the server's check of what an owner saves.
import { unquote } from './config-doc';
import { S_ROTATION } from './config-fields';
import { entryKey, formatRotationEntry, parseRotationEntry } from './rotation-doc';
import { oneLine } from './saved-messages';
import type { MapSelection } from './types';

export interface MapSet {
	id: string;
	name: string;
	entries: MapSelection[];
}

export const MAX_MAP_SETS = 20;
export const MAX_MAP_SET_NAME = 48;
/** Every map, time of day and control zone, twice over (with and without a modifier), fits. */
export const MAX_MAP_SET_ENTRIES = 300;
/** A game mode and its modifiers. */
const MAX_EXPERIENCES = 8;

/**
 * How the game writes its ids (maps, game modes, times of day, control zones). Nothing else goes
 * into the config document: a quote, a bracket or a line break in a value would break the line.
 */
const GAME_ID = /^[A-Za-z0-9_.-]+$/;

/** A value as a message quotes it: on one line and short. */
const quoted = (v: string) => {
	const line = oneLine(v, 41);
	return `"${line.length > 40 ? `${line.slice(0, 40)}…` : line}"`;
};
const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const isId = (v: string, max: number) => v.length <= max && GAME_ID.test(v);

export const cleanMapSetName = (value: unknown): string => oneLine(value, MAX_MAP_SET_NAME);

/**
 * One entry as it is saved: its map, game mode and modifiers, time of day and control zone, each
 * an id of the game's (a zone of None is no zone), or what is wrong with it, to follow "Entry 3: ".
 */
export function cleanMapSetEntry(raw: unknown): MapSelection | string {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'it is not a rotation entry';
	const o = raw as Record<string, unknown>;
	const map = text(o.map);
	if (!map) return 'it names no map';
	if (!isId(map, 100)) return `${quoted(map)} is not a map id`;
	const listed = o.experiences ?? [];
	if (!Array.isArray(listed)) return 'its game modes are not a list';
	const experiences: string[] = [];
	for (const item of listed) {
		const id = text(item);
		if (!id) continue;
		if (!isId(id, 100)) return `${quoted(id)} is not a game mode id`;
		if (!experiences.some((x) => x.toLowerCase() === id.toLowerCase())) experiences.push(id);
	}
	if (experiences.length > MAX_EXPERIENCES)
		return `it has more than ${MAX_EXPERIENCES} game modes and modifiers`;
	const lighting = text(o.lighting);
	if (lighting && !isId(lighting, 100)) return `${quoted(lighting)} is not a time of day id`;
	const zone = /^none$/i.test(text(o.zoneAlternator)) ? '' : text(o.zoneAlternator);
	if (zone && !isId(zone, 200)) return `${quoted(zone)} is not a control zone id`;
	return { map, experiences, lighting, zoneAlternator: zone };
}

/** A set's entries as sent, or a sentence on why they cannot be saved. */
export function cleanMapSetEntries(raw: unknown): MapSelection[] | string {
	if (!Array.isArray(raw)) return 'Send the rotation entries as a list.';
	if (!raw.length) return 'A map set needs at least one rotation entry.';
	if (raw.length > MAX_MAP_SET_ENTRIES)
		return `A map set holds at most ${MAX_MAP_SET_ENTRIES} rotation entries.`;
	const out: MapSelection[] = [];
	for (let i = 0; i < raw.length; i++) {
		const entry = cleanMapSetEntry(raw[i]);
		if (typeof entry === 'string') return `Entry ${i + 1}: ${entry}.`;
		out.push(entry);
	}
	return out;
}

/** Stored entries, trusted but read defensively: anything that would not save is left out. */
export function storedMapSetEntries(raw: unknown): MapSelection[] {
	if (!Array.isArray(raw)) return [];
	return raw
		.slice(0, MAX_MAP_SET_ENTRIES)
		.map(cleanMapSetEntry)
		.filter((e): e is MapSelection => typeof e !== 'string');
}

export interface EntriesRead {
	entries: MapSelection[];
	/** lines that set an entry but could not be read, numbered from 1 */
	unread: { line: number; why: string }[];
}

/**
 * The rotation entries in a text, as the server reads them from its file, so a set plays what the
 * pasted lines would: the rotation section of a ServerSettings.ini, or a text file of its lines
 * (`.RotationEntries=(…)` and the other array commands, or a bare `(Map=…)` line, which adds one).
 * Lines before any section header are read as the rotation section's; under another section's
 * header nothing counts. The commands do what the panel's own parser (`parseIni`) makes of them:
 * `!` empties the list, `+` adds an entry it does not have yet, `.` adds it every time, `-` takes
 * out every copy, and the key alone sets the list to its one entry. Blank lines, comments, headings
 * such as the community rotation builder's `!! Kavkazi` and the section's other keys are passed
 * over; a line that adds an entry and cannot be read is listed with the reason.
 */
export function entriesFromText(source: string): EntriesRead {
	/** each value as written, which `+` and `-` compare as the parser does, and its entry */
	let list: { value: string; entry: MapSelection }[] = [];
	const unread: EntriesRead['unread'] = [];
	let inRotation = true;
	source.split(/\r\n|\n|\r/).forEach((raw, i) => {
		const line = raw.trim();
		if (line.startsWith('[') && line.endsWith(']')) {
			const name = line.slice(1, -1).trim();
			if (name) inRotation = name.toLowerCase() === S_ROTATION.toLowerCase();
			return;
		}
		const key = /^([+.!-]?)\s*RotationEntries\s*=(.*)$/i.exec(line);
		if (!inRotation || (!key && !line.startsWith('('))) return;
		const [cmd, value] = key ? [key[1], key[2].trim()] : ['.', line];
		if (cmd === '!') list = [];
		else if (cmd === '-') list = list.filter((x) => x.value !== value);
		else if (cmd !== '+' || !list.some((x) => x.value === value)) {
			const parsed = parseRotationEntry(unquote(value));
			const entry = parsed ? cleanMapSetEntry(parsed) : 'it names no map';
			if (typeof entry === 'string') unread.push({ line: i + 1, why: entry });
			else list = cmd ? [...list, { value, entry }] : [{ value, entry }];
		}
	});
	return { entries: list.map((x) => x.entry), unread };
}

/** The entries as the lines of a ServerSettings.ini's rotation section, as the game writes them. */
export const entriesToText = (entries: MapSelection[]): string =>
	entries.map((e) => `.RotationEntries=${formatRotationEntry(e)}`).join('\n');

const keys = (entries: MapSelection[]) => entries.map(entryKey);

/**
 * The set a rotation is, if any: one with the same entries in the same order, else one with the
 * same entries in another order (`reordered`), as a shuffle leaves it.
 */
export function mapSetOf(
	sets: MapSet[],
	entries: MapSelection[]
): { set: MapSet; reordered: boolean } | null {
	if (!entries.length) return null;
	const these = keys(entries);
	const same = sets.find((s) => {
		const k = keys(s.entries);
		return k.length === these.length && k.every((x, i) => x === these[i]);
	});
	if (same) return { set: same, reordered: false };
	const sorted = [...these].sort().join('\n');
	const moved = sets.find(
		(s) => s.entries.length === these.length && keys(s.entries).sort().join('\n') === sorted
	);
	return moved ? { set: moved, reordered: true } : null;
}

/** The set of that name, ignoring case. */
export const mapSetNamed = (sets: MapSet[], name: string): MapSet | undefined => {
	const wanted = cleanMapSetName(name).toLowerCase();
	return wanted ? sets.find((s) => s.name.toLowerCase() === wanted) : undefined;
};

/** How many entries each map has, in the order the set first has them. */
export function mapCounts(entries: MapSelection[]): { map: string; count: number }[] {
	const out = new Map<string, { map: string; count: number }>();
	for (const e of entries) {
		const k = e.map.toLowerCase();
		const hit = out.get(k);
		if (hit) hit.count++;
		else out.set(k, { map: e.map, count: 1 });
	}
	return [...out.values()];
}
