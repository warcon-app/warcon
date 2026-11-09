// The map rotation as it lives in ServerSettings.ini, for builds without the live rotation routes
// (live build CL-499480): the same entries the rotation routes expose, read from and written to the
// config document's [/Script/WDGame.WDServerMapRotationSettings] section.
import { getArray, getScalar, parseIni, setArrayInText, setScalarInText } from './config-doc';
import { S_ROTATION } from './config-fields';
import type { MapSelection } from './types';

export interface RotationDoc {
	enabled: boolean;
	mode: 'ordered' | 'random';
	entries: MapSelection[];
}

/** `(Map="Kavkazi",Experience="X",Lighting="L",ZoneAlternator="Z")`; several experiences join with `+`. */
export function parseRotationEntry(value: string): MapSelection | null {
	const inner = value.trim().replace(/^\(/, '').replace(/\)$/, '');
	const fields: Record<string, string> = {};
	for (const m of inner.matchAll(/(\w+)\s*=\s*(?:"([^"]*)"|([^,)]*))/g)) {
		fields[m[1].toLowerCase()] = (m[2] ?? m[3] ?? '').trim();
	}
	if (!fields.map) return null;
	const exps = fields.experiences ?? fields.experience ?? '';
	return {
		map: fields.map,
		experiences: exps
			.split('+')
			.map((e) => e.trim())
			.filter(Boolean),
		lighting: fields.lighting ?? '',
		zoneAlternator: fields.zonealternator ?? ''
	};
}

export function formatRotationEntry(e: MapSelection): string {
	const parts = [`Map="${e.map}"`];
	if (e.experiences.length === 1) parts.push(`Experience="${e.experiences[0]}"`);
	else if (e.experiences.length > 1) parts.push(`Experiences="${e.experiences.join('+')}"`);
	if (e.lighting) parts.push(`Lighting="${e.lighting}"`);
	if (e.zoneAlternator) parts.push(`ZoneAlternator="${e.zoneAlternator}"`);
	return `(${parts.join(',')})`;
}

/**
 * Every entry with a modifier (`KOTH_InfantryOnly`) added or taken off. It is added after the
 * entry's game mode and only where `offered(map)` says the map has it, and not taken off an entry
 * it is the only experience of (that would leave no game mode); `skipped` counts those.
 */
export function setModifierOnAll(
	entries: MapSelection[],
	mod: string,
	on: boolean,
	offered: (map: string) => boolean
): { entries: MapSelection[]; changed: number; skipped: number } {
	const is = (id: string) => id.toLowerCase() === mod.toLowerCase();
	let changed = 0;
	let skipped = 0;
	const next = entries.map((e) => {
		const has = e.experiences.some(is);
		if (on === has) return e;
		const experiences = on ? [...e.experiences, mod] : e.experiences.filter((id) => !is(id));
		if (on ? !offered(e.map) : !experiences.length) {
			skipped++;
			return e;
		}
		changed++;
		return { ...e, experiences };
	});
	return { entries: next, changed, skipped };
}

function shuffled<T>(list: T[], random: () => number): T[] {
	const out = list.slice();
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/**
 * The piles dealt out one item at a time so that items of one pile stand apart. The piles take
 * turns in the order given, a whole round at a time, for as many rounds as leave the rest able to
 * stand apart; the rest follows in a smooth round robin over what is left of each pile, the earlier
 * pile first on a tie (and the list starts on the first pile that can start it). No pile plays
 * twice in a row wherever the counts allow it, and the list ends
 * on another pile than `endNot`, or, without one, than the pile it starts with, so it comes round
 * cleanly. A pile of more than half the items cannot be kept apart: it goes in runs as even as they
 * can be, with one other item between each.
 */
function deal<T>(piles: T[][], endNot = -1): T[] {
	const counts = piles.map((p) => p.length);
	const n = counts.reduce((a, b) => a + b, 0);
	if (!n) return [];
	const top = Math.max(...counts);
	if (2 * top > n + 1) {
		const big = counts.indexOf(top);
		const rest = deal(piles.filter((_, i) => i !== big));
		const runs = rest.length + 1;
		const out: T[] = [];
		for (let i = 0, from = 0; i < runs; i++) {
			const to = Math.round(((i + 1) * top) / runs);
			out.push(...piles[big].slice(from, to));
			from = to;
			if (i < rest.length) out.push(rest[i]);
		}
		return out;
	}
	const k = piles.length;
	let left = counts.slice();
	// With `slots` still to fill after pile `prev`, the last of them not pile `end`: can every pile's
	// remaining items stay apart?
	const fits = (slots: number, prev: number, end: number) =>
		left.every((have, m) => {
			if (!have) return true;
			const free = slots - (m === prev ? 1 : 0) - (m === end ? 1 : 0);
			return free > 0 && have <= Math.ceil(free / 2);
		});
	if (endNot >= 0 && !fits(n, -1, endNot)) endNot = -1;
	// Coming round onto the first pile again only where the counts leave room for it.
	const round = 2 * top <= n;
	const endFor = (first: number) => (endNot >= 0 ? endNot : round ? first : -1);
	let rounds = Math.min(...counts);
	for (; rounds > 0; rounds--) {
		left = counts.map((c) => c - rounds);
		// rounds that use up every item end on the last pile, which must be allowed to end it
		const rest = n - k * rounds;
		if (rest ? fits(rest, k - 1, endFor(0)) : k - 1 !== endFor(0)) break;
	}
	left = counts.map((c) => c - rounds);
	const out: T[] = [];
	for (let r = 0; r < rounds; r++) for (let m = 0; m < k; m++) out.push(piles[m][r]);
	const rest = n - k * rounds;
	const weight = left.slice();
	const credit = piles.map(() => 0);
	let first = rounds ? 0 : -1;
	let last = rounds ? k - 1 : -1;
	for (let t = 0; t < rest; t++) {
		for (let m = 0; m < k; m++) credit[m] += weight[m];
		let pick = -1;
		for (let m = 0; m < k; m++) {
			if (!left[m] || m === last) continue;
			left[m]--;
			const ok = fits(rest - t - 1, m, endFor(first < 0 ? m : first));
			left[m]++;
			if (ok && (pick < 0 || (first >= 0 && credit[m] > credit[pick]))) pick = m;
		}
		credit[pick] -= rest;
		out.push(piles[pick][counts[pick] - left[pick]--]);
		if (first < 0) first = pick;
		last = pick;
	}
	return out;
}

/**
 * `items` in an order that keeps those of one key apart (see `deal`), each key's own items in the
 * order `within` gives them, a shuffle by default. The keys take turns in `order`; a key it leaves
 * out follows the ones it names, in the order it first appears. Without `order`, a random order.
 * `last`: a key the order should not end on.
 */
export function keepApart<T>(
	items: T[],
	keyOf: (item: T) => string,
	opts: {
		order?: string[];
		within?: (items: T[]) => T[];
		last?: string;
		random?: () => number;
	} = {}
): T[] {
	const random = opts.random ?? Math.random;
	const byKey = new Map<string, T[]>();
	for (const item of items) {
		const k = keyOf(item);
		const pile = byKey.get(k);
		if (pile) pile.push(item);
		else byKey.set(k, [item]);
	}
	const keys = opts.order
		? [...new Set([...opts.order.filter((k) => byKey.has(k)), ...byKey.keys()])]
		: shuffled([...byKey.keys()], random);
	const within = opts.within ?? ((list: T[]) => shuffled(list, random));
	const piles = keys.map((k) => within(byKey.get(k)!));
	return deal(piles, opts.last === undefined ? -1 : keys.indexOf(opts.last));
}

const mapKey = (e: MapSelection) => e.map.toLowerCase();
const zoneKey = (e: MapSelection) => (e.zoneAlternator || '').toLowerCase();

/** One rotation entry as text, the same whichever of the server and the document gives it. */
export function entryKey(e: MapSelection): string {
	const v = (x: string | undefined) => (!x || /^none$/i.test(x) ? '' : x.toLowerCase());
	const exps = e.experiences.map((x) => x.toLowerCase()).sort();
	return [v(e.map), exps.join('+'), v(e.lighting), v(e.zoneAlternator)].join('|');
}

/** The maps of a rotation in the order it first has them, spelled as they first are. */
export function mapsInOrder(entries: MapSelection[]): string[] {
	const seen = new Map<string, string>();
	for (const e of entries) if (!seen.has(mapKey(e))) seen.set(mapKey(e), e.map);
	return [...seen.values()];
}

/**
 * The maps of a rotation in the order they take turns: those `maps` names first, in its order, then
 * the rotation's others in the order it first has them; spelled as the rotation has them.
 */
export function turnOf(entries: MapSelection[], maps: string[]): string[] {
	const spelled = new Map(mapsInOrder(entries).map((m) => [m.toLowerCase(), m]));
	return [...new Set([...maps.map((m) => m.toLowerCase()), ...spelled.keys()])]
		.filter((m) => spelled.has(m))
		.map((m) => spelled.get(m)!);
}

/**
 * The rotation in a new order. The maps take turns in `maps` (one it leaves out follows, in the
 * order the rotation first has it), and among each map's own entries its control zones take turns,
 * its times of day in a new order (`zones` can order a map's entries instead). `endNot`: a map the
 * order should not end on. Where the counts cannot be kept apart, see `deal`.
 */
export function shuffleRotation(
	entries: MapSelection[],
	maps: string[] = [],
	random: () => number = Math.random,
	opts: { endNot?: string; zones?: (own: MapSelection[]) => MapSelection[] } = {}
): MapSelection[] {
	return keepApart(entries, mapKey, {
		order: maps.map((m) => m.toLowerCase()),
		within: opts.zones ?? ((own) => keepApart(own, zoneKey, { random })),
		last: opts.endNot?.toLowerCase(),
		random
	});
}

/** How often a map comes twice in a row: within the list, then once more when it comes round. */
const repeatsIn = (list: MapSelection[]) => {
	const within = list.filter((e, i) => i > 0 && mapKey(e) === mapKey(list[i - 1])).length;
	const round = list.length > 1 && mapKey(list[0]) === mapKey(list[list.length - 1]) ? 1 : 0;
	return within * 2 + round;
};

/**
 * The rotation in a new order (`shuffleRotation`) for a server playing `on` when it is written. The
 * turn starts with the map after the one on, and the entry on goes last: a server that stays on
 * the entry it is playing then goes on from the top of the new order, as one that starts from the
 * top does (a restart), and either way the map after the one on comes next. The map on's control
 * zones likewise start after the zone on, so its next turn is on another. Where the counts do not
 * allow that, or the rotation does not hold the entry, the plain shuffle with that turn.
 */
export function shuffleFor(
	entries: MapSelection[],
	maps: string[],
	on: MapSelection | null,
	random: () => number = Math.random
): MapSelection[] {
	const turn = turnOf(entries, maps).map((m) => m.toLowerCase());
	const at = on ? turn.indexOf(mapKey(on)) : -1;
	const after = at < 0 ? turn : [...turn.slice(at + 1), ...turn.slice(0, at + 1)];
	// The map on's entries: its zones in turn from the one after the zone on, so its next turn is
	// on another zone, and ending on another too (the entry on follows them) unless that costs the
	// next turn, which comes first: the end only shows when the whole list comes round.
	const zones = (own: MapSelection[]) => {
		if (!on || mapKey(own[0]) !== mapKey(on)) return keepApart(own, zoneKey, { random });
		const keys = shuffled([...new Set(own.map(zoneKey))], random);
		const z = keys.indexOf(zoneKey(on));
		const order = z < 0 ? keys : [...keys.slice(z + 1), ...keys.slice(0, z + 1)];
		const both = keepApart(own, zoneKey, { order, last: zoneKey(on), random });
		if (z < 0 || zoneKey(both[0]) !== zoneKey(on)) return both;
		const next = keepApart(own, zoneKey, { order, random });
		return zoneKey(next[0]) !== zoneKey(on) ? next : both;
	};
	const plain = shuffleRotation(entries, after, random, { zones });
	const i = on ? entries.findIndex((e) => entryKey(e) === entryKey(on)) : -1;
	if (i < 0) return plain;
	const rest = [...entries.slice(0, i), ...entries.slice(i + 1)];
	const last = [
		...shuffleRotation(rest, after, random, { endNot: entries[i].map, zones }),
		entries[i]
	];
	return repeatsIn(last) <= repeatsIn(plain) ? last : plain;
}

/**
 * A shuffled rotation turned round by fewer places than it has maps, so its whole rounds stay at
 * the top, to suit the map on when it is written. `after` lists where the server may take its next
 * entry from once the order changes, the likeliest first: each should hold the map that follows
 * `playing` in the turn, or at least another map. Among the turns that do best, one at random. A
 * list that comes round onto its own map is left as it is: turning it would put a map twice in a
 * row.
 */
export function alignRotation(
	list: MapSelection[],
	playing: string,
	after: number[],
	random: () => number = Math.random
): MapSelection[] {
	const n = list.length;
	if (n < 2 || mapKey(list[0]) === mapKey(list[n - 1])) return list;
	const turn = [...new Set(list.map(mapKey))];
	const now = playing.toLowerCase();
	const at = turn.indexOf(now);
	const next = at < 0 ? null : turn[(at + 1) % turn.length];
	const score = (r: number) =>
		after.map((p) => {
			const m = mapKey(list[(((p + r) % n) + n) % n]);
			return m === next ? 2 : m === now ? 0 : 1;
		});
	let best: number[] = [];
	let top: number[] = [];
	for (let r = 0; r < Math.min(turn.length, n); r++) {
		const s = score(r);
		const i = s.findIndex((v, j) => v !== top[j]);
		const better = !best.length || (i >= 0 && s[i] > top[i]);
		if (better) [best, top] = [[r], s];
		else if (i < 0) best.push(r);
	}
	const r = best[Math.floor(random() * best.length)];
	return r ? [...list.slice(r), ...list.slice(0, r)] : list;
}

export function rotationFromText(text: string): RotationDoc {
	const doc = parseIni(text);
	const enabled = getScalar(doc, S_ROTATION, 'bEnabled');
	const mode = getScalar(doc, S_ROTATION, 'RotationMode');
	return {
		enabled: enabled === null ? true : /^true$/i.test(enabled),
		mode: /random/i.test(mode || '') ? 'random' : 'ordered',
		entries: getArray(doc, S_ROTATION, 'RotationEntries')
			.map(parseRotationEntry)
			.filter((e): e is MapSelection => !!e)
	};
}

/** Writes the rotation back into the document text, touching only the three rotation keys. */
export function rotationIntoText(text: string, r: RotationDoc): string {
	let out = setScalarInText(text, S_ROTATION, 'bEnabled', r.enabled ? 'True' : 'False');
	out = setScalarInText(
		out,
		S_ROTATION,
		'RotationMode',
		r.mode === 'random' ? 'Random' : 'Ordered'
	);
	return setArrayInText(out, S_ROTATION, 'RotationEntries', r.entries.map(formatRotationEntry));
}
