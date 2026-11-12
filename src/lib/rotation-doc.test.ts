import { test, expect } from 'bun:test';
import {
	formatRotationEntry,
	parseRotationEntry,
	alignRotation,
	entryFlags,
	entryKey,
	keepApart,
	mapsInOrder,
	nearLighting,
	setModifierOnAll,
	shuffleFor,
	shuffleRotation,
	rotationFromText,
	rotationIntoText,
	type EntryFlags
} from './rotation-doc';
import { getArray, parseIni, setArrayInText } from './config-doc';
import type { Catalog, MapSelection } from './types';

// A slice of the TLR server's document (live build CL-499480), as GET /v1/config returns it.
const TEXT = [
	'[/Script/WDGame.WDGameSession]',
	'ServerName=TLR',
	'',
	'[/Script/WDGame.WDServerMapRotationSettings]',
	'bEnabled=True',
	'RotationMode=Ordered',
	'!RotationEntries=ClearArray',
	'.RotationEntries=(Map="Kavkazi",Experience="Bakurani_KOTH_01",Lighting="DayEarlyClear",ZoneAlternator="ZoneAlternator.Bakurani.Default.Circle")',
	'.RotationEntries=(Map="Europe",Experiences="Madrid_KOTH_01+KOTH_InfantryOnly",Lighting="DayEarlyFog")',
	'',
	'[/Script/Engine.GameSession]',
	'MaxPlayers=100',
	''
].join('\r\n');

test('parses entries with one or several experiences and an optional alternator', () => {
	expect(
		parseRotationEntry(
			'(Map="Kavkazi",Experience="Bakurani_KOTH_01",Lighting="DayEarlyClear",ZoneAlternator="ZoneAlternator.Bakurani.Default.Circle")'
		)
	).toEqual({
		map: 'Kavkazi',
		experiences: ['Bakurani_KOTH_01'],
		lighting: 'DayEarlyClear',
		zoneAlternator: 'ZoneAlternator.Bakurani.Default.Circle'
	});
	expect(parseRotationEntry('(Map="Europe",Experiences="A+B",Lighting="L")')).toEqual({
		map: 'Europe',
		experiences: ['A', 'B'],
		lighting: 'L',
		zoneAlternator: ''
	});
	expect(parseRotationEntry('(Lighting="L")')).toBeNull();
});

test('formats the way the server writes them', () => {
	expect(
		formatRotationEntry({
			map: 'Europe',
			experiences: ['A', 'B'],
			lighting: 'L',
			zoneAlternator: ''
		})
	).toBe('(Map="Europe",Experiences="A+B",Lighting="L")');
	expect(
		formatRotationEntry({ map: 'Kavkazi', experiences: ['X'], lighting: 'L', zoneAlternator: 'Z' })
	).toBe('(Map="Kavkazi",Experience="X",Lighting="L",ZoneAlternator="Z")');
});

test('reads the rotation section', () => {
	const r = rotationFromText(TEXT);
	expect(r.enabled).toBe(true);
	expect(r.mode).toBe('ordered');
	expect(r.entries.map((e) => e.map)).toEqual(['Kavkazi', 'Europe']);
	expect(r.entries[1].experiences).toEqual(['Madrid_KOTH_01', 'KOTH_InfantryOnly']);
});

test('writes it back in place, leaving the rest of the file alone', () => {
	const r = rotationFromText(TEXT);
	const next = rotationIntoText(TEXT, {
		enabled: false,
		mode: 'random',
		entries: [r.entries[1], r.entries[0]]
	});
	const lines = next.split('\r\n');
	expect(lines.slice(0, 3)).toEqual(['[/Script/WDGame.WDGameSession]', 'ServerName=TLR', '']);
	expect(lines[4]).toBe('bEnabled=False');
	expect(lines[5]).toBe('RotationMode=Random');
	expect(lines[6]).toBe('!RotationEntries=ClearArray');
	expect(lines[7]).toContain('Map="Europe"');
	expect(lines[8]).toContain('Map="Kavkazi"');
	expect(lines.slice(9)).toEqual(['', '[/Script/Engine.GameSession]', 'MaxPlayers=100', '']);
	expect(next.includes('\r\n')).toBe(true);
	expect(rotationFromText(next).entries.map((e) => e.map)).toEqual(['Europe', 'Kavkazi']);
});

test('setArrayInText adds a block to a section that has none, or a missing section', () => {
	const t = setArrayInText('[A]\nx=1\n', 'A', 'K', ['v1', 'v2']);
	expect(t).toBe('[A]\nx=1\n!K=ClearArray\n.K=v1\n.K=v2\n');
	const u = setArrayInText('[A]\nx=1\n', 'B', 'K', []);
	expect(u).toBe('[A]\nx=1\n\n[B]\n!K=ClearArray\n');
	expect(getArray(parseIni(t), 'A', 'K')).toEqual(['v1', 'v2']);
});

test('setModifierOnAll adds a modifier after the game mode where the map offers it', () => {
	const r = rotationFromText(TEXT);
	const out = setModifierOnAll(r.entries, 'KOTH_InfantryOnly', true, (map) => map !== 'Mars');
	expect(out.changed).toBe(1);
	expect(out.skipped).toBe(0);
	expect(out.entries[0].experiences).toEqual(['Bakurani_KOTH_01', 'KOTH_InfantryOnly']);
	// Already on: left as it was, not doubled.
	expect(out.entries[1]).toBe(r.entries[1]);
	expect(formatRotationEntry(out.entries[0])).toBe(
		'(Map="Kavkazi",Experiences="Bakurani_KOTH_01+KOTH_InfantryOnly",Lighting="DayEarlyClear",ZoneAlternator="ZoneAlternator.Bakurani.Default.Circle")'
	);
	const mars = { map: 'Mars', experiences: ['Mars_KOTH_01'], lighting: 'L', zoneAlternator: '' };
	const skip = setModifierOnAll([mars], 'KOTH_InfantryOnly', true, (map) => map !== 'Mars');
	expect(skip).toEqual({ entries: [mars], changed: 0, skipped: 1 });
});

test('setModifierOnAll takes a modifier off every entry, in any case, and keeps the rest', () => {
	const entries = [
		{
			map: 'Europe',
			experiences: ['Madrid_KOTH_01', 'koth_infantryonly', 'KOTH_Hardcore'],
			lighting: 'L',
			zoneAlternator: ''
		},
		{ map: 'Kavkazi', experiences: ['Bakurani_KOTH_01'], lighting: 'L', zoneAlternator: 'Z' }
	];
	const out = setModifierOnAll(entries, 'KOTH_InfantryOnly', false, () => false);
	expect(out.changed).toBe(1);
	expect(out.skipped).toBe(0);
	expect(out.entries[0].experiences).toEqual(['Madrid_KOTH_01', 'KOTH_Hardcore']);
	expect(out.entries[1]).toBe(entries[1]);
	// The input is not changed in place.
	expect(entries[0].experiences).toHaveLength(3);
	// Not taken off an entry it is the only experience of: that would leave no game mode.
	const only = {
		map: 'Europe',
		experiences: ['KOTH_InfantryOnly'],
		lighting: 'L',
		zoneAlternator: ''
	};
	expect(setModifierOnAll([only], 'KOTH_InfantryOnly', false, () => true)).toEqual({
		entries: [only],
		changed: 0,
		skipped: 1
	});
});

// The Season 3 server notes' own examples: Sabatulo (map Russia), and the Limited Gear modifier
// stacked on a game mode, alone and with another modifier.
const SEASON_3 = [
	'(Map="Russia",Experience="Moscow_KOTH_01",Lighting="DayClear")',
	'(Map="Russia",Experiences="Moscow_KOTH_01+KOTH_LimitedGear",Lighting="DayLateRain")',
	'(Map="Kavkazi",Experiences="Bakurani_KOTH_02+KOTH_LimitedGear",Lighting="DayLateClear")',
	'(Map="Europe",Experiences="Madrid_KOTH_01+KOTH_InfantryOnly+KOTH_LimitedGear",Lighting="DayClear")'
];

test('reads the Season 3 examples and writes them back as they came, the game mode first', () => {
	const entries = SEASON_3.map((line) => parseRotationEntry(line)!);
	expect(entries[0]).toEqual({
		map: 'Russia',
		experiences: ['Moscow_KOTH_01'],
		lighting: 'DayClear',
		zoneAlternator: ''
	});
	expect(entries[1].experiences).toEqual(['Moscow_KOTH_01', 'KOTH_LimitedGear']);
	expect(entries[3].experiences).toEqual([
		'Madrid_KOTH_01',
		'KOTH_InfantryOnly',
		'KOTH_LimitedGear'
	]);
	expect(entries.map(formatRotationEntry)).toEqual(SEASON_3);
});

test('setModifierOnAll adds Limited Gear after the game mode and beside another modifier', () => {
	const entries = [
		SEASON_3[0],
		SEASON_3[2],
		'(Map="Europe",Experiences="Madrid_KOTH_01+KOTH_InfantryOnly")'
	].map((line) => parseRotationEntry(line)!);
	const out = setModifierOnAll(entries, 'KOTH_LimitedGear', true, () => true);
	expect(out.changed).toBe(2);
	expect(out.entries.map((e) => e.experiences)).toEqual([
		['Moscow_KOTH_01', 'KOTH_LimitedGear'],
		['Bakurani_KOTH_02', 'KOTH_LimitedGear'],
		['Madrid_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_LimitedGear']
	]);
	// taken off again, the other modifier stays
	const off = setModifierOnAll(out.entries, 'KOTH_LimitedGear', false, () => true);
	expect(off.entries.map((e) => e.experiences)).toEqual([
		['Moscow_KOTH_01'],
		['Bakurani_KOTH_02'],
		['Madrid_KOTH_01', 'KOTH_InfantryOnly']
	]);
});

// ---- what a server would not play of an entry ----

const listOf = (...ids: string[]) => ids.map((id) => ({ id, display: id }));
/** A server whose hosting provider has allowed Season 3's map, game mode and modifier. */
const SEASON_3_SERVER: Catalog = {
	maps: listOf('Kavkazi', 'Europe', 'NorthAmerica', 'Russia'),
	lightings: listOf(
		'DayStartClear',
		'DayEarlyClear',
		'DayEarlyFog',
		'DayClear',
		'DayLateClear',
		'DayLateGray',
		'DayLateGrayFog',
		'DayEndClear',
		'DayLateRain'
	),
	experiences: listOf(
		'Bakurani_KOTH_01',
		'Bakurani_KOTH_02',
		'Madrid_KOTH_01',
		'Detroit_KOTH_01',
		'Moscow_KOTH_01',
		'KOTH_InfantryOnly',
		'KOTH_Hardcore',
		'KOTH_LimitedGear'
	)
};
/** One whose provider has not: Season 2's lists. */
const SEASON_2_SERVER: Catalog = {
	maps: SEASON_3_SERVER.maps.filter((m) => m.id !== 'Russia'),
	lightings: SEASON_3_SERVER.lightings,
	experiences: SEASON_3_SERVER.experiences.filter(
		(e) => e.id !== 'Moscow_KOTH_01' && e.id !== 'KOTH_LimitedGear'
	)
};
const SOUND: EntryFlags = { map: false, mode: '', lighting: '', unlisted: [] };
const entry = (line: string) => parseRotationEntry(line)!;

test('entryFlags: the Season 3 examples are sound on a server that lists them', () => {
	for (const line of SEASON_3) expect(entryFlags(entry(line), SEASON_3_SERVER)).toEqual(SOUND);
	// ids are the game's whatever their letter case, and no lighting or zone is no fault
	expect(
		entryFlags(
			entry('(Map="russia",Experience="moscow_koth_01",Lighting="daylaterain")'),
			SEASON_3_SERVER
		)
	).toEqual(SOUND);
	expect(
		entryFlags(entry('(Map="Kavkazi",Experience="Bakurani_KOTH_01")'), SEASON_3_SERVER)
	).toEqual(SOUND);
	expect(
		entryFlags(
			entry('(Map="Kavkazi",Experience="Bakurani_KOTH_01",Lighting="None")'),
			SEASON_3_SERVER
		)
	).toEqual(SOUND);
	// an entry that names no experience at all is left to the game
	expect(entryFlags(entry('(Map="Kavkazi",Lighting="DayClear")'), SEASON_3_SERVER)).toEqual(SOUND);
});

test('entryFlags: what a server does not list is named, part by part', () => {
	// a server whose provider has not added Sabatulo or Limited Gear to its allow lists
	expect(entryFlags(entry(SEASON_3[1]), SEASON_2_SERVER)).toEqual({
		map: true,
		mode: 'unlisted',
		lighting: '',
		unlisted: ['Russia', 'Moscow_KOTH_01', 'KOTH_LimitedGear']
	});
	expect(entryFlags(entry(SEASON_3[2]), SEASON_2_SERVER)).toEqual({
		map: false,
		mode: 'unlisted',
		lighting: '',
		unlisted: ['KOTH_LimitedGear']
	});
	// the notes spell the grey lighting DayLateGrey; the game lists DayLateGray and does not know it
	expect(
		entryFlags(
			entry('(Map="Russia",Experience="Moscow_KOTH_01",Lighting="DayLateGrey")'),
			SEASON_3_SERVER
		)
	).toEqual({ map: false, mode: '', lighting: 'unlisted', unlisted: ['DayLateGrey'] });
});

test('entryFlags: a lighting Sabatulo does not take, and Limited Gear with no game mode', () => {
	const fog = entry('(Map="Russia",Experience="Moscow_KOTH_01",Lighting="DayEarlyFog")');
	expect(entryFlags(fog, SEASON_3_SERVER)).toEqual({ ...SOUND, lighting: 'map' });
	// the same lighting on another map is sound
	expect(
		entryFlags(
			entry('(Map="Europe",Experience="Madrid_KOTH_01",Lighting="DayEarlyFog")'),
			SEASON_3_SERVER
		)
	).toEqual(SOUND);
	const bare = entry('(Map="Russia",Experience="KOTH_LimitedGear",Lighting="DayClear")');
	expect(entryFlags(bare, SEASON_3_SERVER)).toEqual({ ...SOUND, mode: 'none' });
	expect(
		entryFlags(
			entry('(Map="Europe",Experiences="KOTH_InfantryOnly+KOTH_LimitedGear",Lighting="DayClear")'),
			SEASON_3_SERVER
		).mode
	).toBe('none');
	// Infantry Only alone is not known to fail (the demo's own rotation has it), so it is not marked
	expect(
		entryFlags(
			entry('(Map="Europe",Experience="KOTH_InfantryOnly",Lighting="DayEarlyFog")'),
			SEASON_3_SERVER
		)
	).toEqual(SOUND);
});

test('entryFlags: an entry as the game sends it, parts missing or oddly named, never throws', () => {
	const partial = (e: Record<string, unknown>) =>
		entryFlags(e as unknown as MapSelection, SEASON_3_SERVER);
	// a live rotation entry is passed through as the game gave it
	expect(partial({ experiences: ['Bakurani_KOTH_01'], lighting: 'DayClear' })).toEqual(SOUND);
	expect(partial({ map: null, experiences: null, lighting: null })).toEqual(SOUND);
	expect(partial({ map: 'Kavkazi' })).toEqual(SOUND);
	expect(partial({ map: 'Kavkazi', experiences: [7, null, 'Bakurani_KOTH_01'] })).toEqual(SOUND);
	// a map named like one of Object's own members is only a map the server does not list
	for (const odd of ['constructor', '__proto__', 'toString'])
		expect(
			entryFlags(
				entry(`(Map="${odd}",Experience="Bakurani_KOTH_01",Lighting="DayEarlyFog")`),
				SEASON_3_SERVER
			)
		).toEqual({ map: true, mode: '', lighting: '', unlisted: [odd] });
});

test('entryFlags: a server that could not be asked flags nothing as unlisted', () => {
	const none: Catalog = { maps: [], lightings: [], experiences: [] };
	for (const line of SEASON_3) expect(entryFlags(entry(line), none)).toEqual(SOUND);
	expect(entryFlags(entry('(Map="Mars",Experience="Mars_KOTH_01",Lighting="Dusk")'), none)).toEqual(
		SOUND
	);
	// what needs no list is still told
	expect(
		entryFlags(entry('(Map="Russia",Experience="KOTH_LimitedGear",Lighting="DayEarlyFog")'), none)
	).toEqual({ ...SOUND, mode: 'none', lighting: 'map' });
});

test('nearLighting: the lighting a mistyped one meant, a letter or two off', () => {
	const lightings = SEASON_3_SERVER.lightings;
	// the Season 3 notes' spelling of the grey one
	expect(nearLighting('DayLateGrey', lightings)).toBe('DayLateGray');
	expect(nearLighting('daylategreyfog', lightings)).toBe('DayLateGrayFog');
	expect(nearLighting('DayLateRian', lightings)).toBe('DayLateRain');
	expect(nearLighting('DayClera', lightings)).toBe('DayClear');
	// nothing for one that is listed, one that is far off, or a map or game mode
	expect(nearLighting('DayLateGray', lightings)).toBeNull();
	expect(nearLighting('NightStorm', lightings)).toBeNull();
	expect(nearLighting('Russia', lightings)).toBeNull();
	expect(nearLighting('Moscow_KOTH_01', lightings)).toBeNull();
	expect(nearLighting('KOTH_LimitedGear', lightings)).toBeNull();
	expect(nearLighting('DayLateGrey', [])).toBeNull();
});

// A rotation of `counts[m]` entries on map m, with `zones` control zones each, told apart by lighting.
const MAPS = ['Kavkazi', 'Europe', 'NorthAmerica', 'Mars'];
const rotationOf = (counts: number[], zones = 1): MapSelection[] =>
	counts.flatMap((c, m) =>
		Array.from({ length: c }, (_, i) => ({
			map: MAPS[m],
			experiences: [],
			lighting: `L${Math.floor(i / zones)}`,
			zoneAlternator: zones > 1 ? `Zone${i % zones}` : ''
		}))
	);
const repeats = (list: MapSelection[]) =>
	list.filter((e, i) => i > 0 && e.map.toLowerCase() === list[i - 1].map.toLowerCase()).length;
const initials = (list: MapSelection[]) => list.map((e) => e.map[0]).join('');
const seeded = (seed: number) => () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

test('shuffleRotation keeps every entry and the maps apart wherever the counts allow it', () => {
	const random = seeded(1);
	const each = (counts: number[]) => {
		const entries = rotationOf(counts);
		const n = entries.length;
		const top = Math.max(...counts);
		for (const maps of [[], MAPS.slice(0, counts.length).reverse()]) {
			const out = shuffleRotation(entries, maps, random);
			expect(new Set(out)).toEqual(new Set(entries));
			expect(out).toHaveLength(n);
			// No repeat at all unless one map has more than half; then no more than it must.
			expect(repeats(out)).toBe(Math.max(0, 2 * top - n - 1));
			// Coming round again, last and then first are different maps whenever they can be.
			if (n >= 2 && 2 * top <= n) expect(out[n - 1].map).not.toBe(out[0].map);
		}
	};
	for (let a = 1; a <= 7; a++) {
		each([a]);
		for (let b = 1; b <= 7; b++) {
			each([a, b]);
			for (let c = 1; c <= 7; c++) each([a, b, c]);
		}
	}
	each([3, 2, 2, 1]);
	each([5, 1, 1, 1]);
	expect(shuffleRotation([])).toEqual([]);
});

test('shuffleRotation plays the maps in the order given, round after round', () => {
	// Fewer entries on one map: whole rounds until it runs out, then the other two in turn.
	const out = shuffleRotation(rotationOf([32, 32, 24]), ['Europe', 'Kavkazi', 'NorthAmerica']);
	expect(initials(out)).toBe('EKN'.repeat(24) + 'EK'.repeat(8));
	// A map the order leaves out follows those it names; no order is the order the rotation has.
	expect(initials(shuffleRotation(rotationOf([2, 2, 2]), ['NorthAmerica']))).toBe('NKENKE');
	expect(initials(shuffleRotation(rotationOf([2, 2, 2]), []))).toBe('KENKEN');
	// Rounds stop where going on would put a map twice in a row later: the rest is spread instead.
	const uneven = shuffleRotation(rotationOf([40, 30, 18]), ['Kavkazi', 'Europe', 'NorthAmerica']);
	expect(initials(uneven).startsWith('KEN'.repeat(8))).toBe(true);
	expect(initials(uneven).startsWith('KEN'.repeat(9))).toBe(false);
	expect(repeats(uneven)).toBe(0);
});

test("shuffleRotation takes each map's control zones in turn, its times of day in a new order", () => {
	const out = shuffleRotation(rotationOf([32, 32, 24], 4), [], seeded(2));
	for (const map of MAPS.slice(0, 3)) {
		const own = out.filter((e) => e.map === map);
		const zones = own.map((e) => e.zoneAlternator);
		expect(zones.filter((z, i) => i > 0 && z === zones[i - 1])).toEqual([]);
		// a whole round of zones before any comes again
		expect(new Set(zones.slice(0, 4)).size).toBe(4);
		expect(zones.slice(4, 8)).toEqual(zones.slice(0, 4));
	}
	const lightings = out.filter((e) => e.map === 'Kavkazi').map((e) => e.lighting);
	expect(lightings).not.toEqual([...lightings].sort());
});

test('shuffleRotation plays a map with over half the entries in even runs between the others', () => {
	const out = shuffleRotation(rotationOf([10, 2, 2]), [], seeded(3));
	expect(out.map((e) => (e.map === 'Kavkazi' ? 'K' : '-')).join('')).toBe('KK-KK-KK-KK-KK');
	expect(repeats(out)).toBe(5);
});

test('shuffleRotation tells maps apart in any letter case', () => {
	const entries = [
		{ map: 'Kavkazi', experiences: [], lighting: 'A', zoneAlternator: '' },
		{ map: 'kavkazi', experiences: [], lighting: 'B', zoneAlternator: '' },
		{ map: 'Europe', experiences: [], lighting: 'C', zoneAlternator: '' }
	];
	for (let seed = 1; seed < 20; seed++) {
		const out = shuffleRotation(entries, ['EUROPE'], seeded(seed));
		expect(out.map((e) => e.lighting[0] && e.map.toLowerCase())).toEqual([
			'kavkazi',
			'europe',
			'kavkazi'
		]);
	}
	expect(mapsInOrder(entries)).toEqual(['Kavkazi', 'Europe']);
});

test('alignRotation puts the map that follows the one on where the server takes its next entry', () => {
	const list = shuffleRotation(rotationOf([3, 3, 3]), ['Europe', 'Kavkazi', 'NorthAmerica']);
	expect(initials(list)).toBe('EKNEKNEKN');
	// On Europe, next from the top of the new order (a restart): Kavkazi first.
	expect(initials(alignRotation(list, 'Europe', [0]))).toBe('KNEKNEKNE');
	// From the entry after place 4 (a pointer that keeps its place): Kavkazi there.
	expect(initials(alignRotation(list, 'Europe', [5]))[5]).toBe('K');
	// Two places that cannot both hold Kavkazi: the first listed gets it, then the second does as well
	// as the turn allows (after Kavkazi at the top, Northamerica: at least not Europe).
	const both = initials(alignRotation(list, 'Europe', [0, 1]));
	expect(both.slice(0, 2)).toBe('KN');
	// The other way round, the second place cannot avoid Europe: in turn, it comes just before.
	expect(initials(alignRotation(list, 'Europe', [1, 0])).slice(0, 2)).toBe('EK');
	// Turned by less than one round, so the rounds stay whole; nothing is lost or doubled.
	const turned = alignRotation(list, 'NorthAmerica', [0]);
	expect(new Set(turned)).toEqual(new Set(list));
	expect(repeats(turned)).toBe(0);
	expect(turned[turned.length - 1].map).not.toBe(turned[0].map);
	// A map not in the rotation: anything but it will do, so the list may stay as it is.
	expect(initials(alignRotation(list, 'Mars', [0], () => 0))).toBe('EKNEKNEKN');
	// A list that comes round onto its own map is not turned.
	const wraps = rotationOf([3, 1, 1]);
	const odd = shuffleRotation(wraps, [], seeded(4));
	expect(alignRotation(odd, 'Kavkazi', [0])).toBe(odd);
});

test('shuffleFor starts on the map after the one on and puts the entry on last', () => {
	const order = ['Europe', 'Kavkazi', 'NorthAmerica'];
	for (const [counts, zones] of [
		[[12, 12, 12], 4],
		[[32, 32, 24], 4],
		[[5, 7, 6], 1]
	] as [number[], number][]) {
		const entries = rotationOf(counts, zones);
		for (const on of [entries[0], entries[counts[0]], entries[entries.length - 1]]) {
			const out = shuffleFor(entries, order, on, seeded(5));
			expect(new Set(out)).toEqual(new Set(entries));
			expect(repeats(out)).toBe(0);
			expect(out[0].map).not.toBe(out[out.length - 1].map);
			// a server that stays on its entry, or goes to the top, goes on to the map after it
			expect(out[out.length - 1]).toBe(on);
			const turn = order.filter((m) => counts[MAPS.indexOf(m)] > 0);
			expect(out[0].map).toBe(turn[(turn.indexOf(on.map) + 1) % turn.length]);
		}
	}
	// An entry the rotation does not hold: only the turn starts after its map.
	const entries = rotationOf([3, 3, 3]);
	const other = { map: 'Kavkazi', experiences: [], lighting: 'Elsewhere', zoneAlternator: '' };
	expect(initials(shuffleFor(entries, ['Europe', 'Kavkazi', 'NorthAmerica'], other))).toBe(
		'NEKNEKNEK'
	);
	expect(initials(shuffleFor(entries, ['Europe', 'Kavkazi', 'NorthAmerica'], null))).toBe(
		'EKNEKNEKN'
	);
	expect(entryKey(other)).toBe(entryKey({ ...other, map: 'KAVKAZI', zoneAlternator: 'None' }));
});

test('keepApart ends on another key than the one asked, where the counts allow it', () => {
	const items = [...'aaaabbbbcccc'].map((k, i) => ({ k, i }));
	for (let seed = 1; seed < 30; seed++) {
		const out = keepApart(items, (x) => x.k, {
			order: ['a', 'b', 'c'],
			last: 'c',
			random: seeded(seed)
		});
		expect(out.map((x) => x.k).join('')).not.toMatch(/(.)\1/);
		expect(out[out.length - 1].k).not.toBe('c');
	}
	// Twelve of one key and eleven of another can only alternate from it to it: asked to end on
	// another, it still keeps them apart.
	const tight = [...('a'.repeat(12) + 'b'.repeat(11))].map((k, i) => ({ k, i }));
	const out = keepApart(tight, (x) => x.k, { order: ['b', 'a'], last: 'a' });
	expect(out.map((x) => x.k).join('')).toBe('ab'.repeat(11) + 'a');
});

test('shuffleFor does not start on the map on when it has half the entries, nor its zone', () => {
	const order = ['Europe', 'Kavkazi', 'NorthAmerica'];
	const entries = rotationOf([16, 8, 8], 4);
	for (let seed = 1; seed < 40; seed++) {
		const on = entries[(seed * 7) % 16];
		const out = shuffleFor(entries, order, on, seeded(seed));
		// Kavkazi has half: after it in the turn comes NorthAmerica
		expect(out[0].map).toBe('NorthAmerica');
		expect(out[out.length - 1]).toBe(on);
		expect(repeats(out)).toBe(0);
		const next = out.find((e) => e.map === on.map && e !== on)!;
		expect(next.zoneAlternator).not.toBe(on.zoneAlternator);
	}
});
