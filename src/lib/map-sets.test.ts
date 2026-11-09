import { describe, expect, test } from 'bun:test';
import {
	cleanMapSetEntries,
	cleanMapSetEntry,
	cleanMapSetName,
	entriesFromText,
	entriesToText,
	mapCounts,
	mapSetNamed,
	mapSetOf,
	MAX_MAP_SET_ENTRIES,
	storedMapSetEntries,
	type MapSet
} from './map-sets';
import { formatRotationEntry, rotationFromText, rotationIntoText } from './rotation-doc';
import type { MapSelection } from './types';

const BAKU: MapSelection = {
	map: 'Kavkazi',
	experiences: ['Bakurani_KOTH_02', 'KOTH_InfantryOnly'],
	lighting: 'DayClear',
	zoneAlternator: 'ZoneAlternator.Bakurani.Default.Circle'
};
const OZETI: MapSelection = {
	map: 'Europe',
	experiences: ['Madrid_KOTH_01'],
	lighting: 'DayEarlyFog',
	zoneAlternator: ''
};
const ZEST: MapSelection = {
	map: 'NorthAmerica',
	experiences: ['Detroit_KOTH_01', 'KOTH_Hardcore'],
	lighting: 'DayLateRain',
	zoneAlternator: 'ZoneAlternator.Zestafona.Houses.Circle'
};

describe('an entry of a map set', () => {
	test('is the game ids of its map, modes, time of day and zone', () => {
		expect(cleanMapSetEntry(BAKU)).toEqual(BAKU);
		expect(cleanMapSetEntry({ map: ' Europe ', experiences: [' Madrid_KOTH_01 ', ''] })).toEqual({
			map: 'Europe',
			experiences: ['Madrid_KOTH_01'],
			lighting: '',
			zoneAlternator: ''
		});
		// a zone of None is no zone, and a mode named twice is kept once
		expect(
			cleanMapSetEntry({
				map: 'Kavkazi',
				experiences: ['Bakurani_KOTH_01', 'bakurani_koth_01'],
				zoneAlternator: 'None'
			})
		).toEqual({
			map: 'Kavkazi',
			experiences: ['Bakurani_KOTH_01'],
			lighting: '',
			zoneAlternator: ''
		});
	});

	test('says what is wrong with one that is not', () => {
		expect(cleanMapSetEntry(null)).toBe('it is not a rotation entry');
		expect(cleanMapSetEntry(['Kavkazi'])).toBe('it is not a rotation entry');
		expect(cleanMapSetEntry({ experiences: ['Bakurani_KOTH_01'] })).toBe('it names no map');
		expect(cleanMapSetEntry({ map: 'Kavkazi', experiences: 'Bakurani_KOTH_01' })).toBe(
			'its game modes are not a list'
		);
		expect(cleanMapSetEntry({ map: 'Kavkazi', lighting: 'Day Clear' })).toBe(
			'"Day Clear" is not a time of day id'
		);
		expect(
			cleanMapSetEntry({
				map: 'Kavkazi',
				experiences: Array(9)
					.fill(0)
					.map((_, i) => `M${i}`)
			})
		).toBe('it has more than 8 game modes and modifiers');
		expect(cleanMapSetEntry({ map: 'x'.repeat(101) })).toMatch(/^"x{40}…" is not a map id$/);
	});

	test('never carries what would break the config document', () => {
		// a value that closes the entry and starts a section of its own, with the RCON password in it
		const breakOut = 'DayClear")\n[/Script/WDRCON.WDRCONSettings]\nPassword="mine';
		for (const entry of [
			{ map: breakOut },
			{ map: 'Kavkazi', experiences: [breakOut] },
			{ map: 'Kavkazi', lighting: breakOut },
			{ map: 'Kavkazi', zoneAlternator: breakOut },
			{ map: 'Kav,kazi' },
			{ map: 'Kav=kazi' },
			{ map: 'Kavkazi', experiences: ['A+B'] },
			{ map: 'Kav(kazi)' },
			{ map: 'Kav\tkazi' }
		])
			expect({ entry, clean: typeof cleanMapSetEntry(entry) }).toEqual({ entry, clean: 'string' });
	});

	test('a whole list: one entry at least, the first bad one numbered', () => {
		expect(cleanMapSetEntries([BAKU, OZETI])).toEqual([BAKU, OZETI]);
		expect(cleanMapSetEntries('BAKU')).toBe('Send the rotation entries as a list.');
		expect(cleanMapSetEntries([])).toBe('A map set needs at least one rotation entry.');
		expect(cleanMapSetEntries([BAKU, { map: '' }, { map: 'a b' }])).toBe(
			'Entry 2: it names no map.'
		);
		expect(cleanMapSetEntries(Array(MAX_MAP_SET_ENTRIES).fill(OZETI))).toHaveLength(
			MAX_MAP_SET_ENTRIES
		);
		expect(cleanMapSetEntries(Array(MAX_MAP_SET_ENTRIES + 1).fill(OZETI))).toBe(
			`A map set holds at most ${MAX_MAP_SET_ENTRIES} rotation entries.`
		);
	});

	test('stored entries are read leaving out whatever would not save', () => {
		expect(storedMapSetEntries('nope')).toEqual([]);
		expect(storedMapSetEntries([BAKU, { map: 'a b' }, 7, OZETI])).toEqual([BAKU, OZETI]);
	});

	test('a name is one line, cut to 48', () => {
		expect(cleanMapSetName('  Infantry\n only ')).toBe('Infantry only');
		expect(cleanMapSetName('x'.repeat(60))).toBe('x'.repeat(48));
		expect(cleanMapSetName(null)).toBe('');
	});
});

describe('entries read from text', () => {
	test("the game's own lines, as the rotation tab writes them, read back the same", () => {
		const text = rotationIntoText('', {
			enabled: true,
			mode: 'ordered',
			entries: [BAKU, OZETI, ZEST]
		});
		expect(text).toContain('!RotationEntries=ClearArray');
		expect(entriesFromText(text)).toEqual({ entries: [BAKU, OZETI, ZEST], unread: [] });
		expect(entriesFromText(entriesToText([BAKU, OZETI, ZEST]))).toEqual({
			entries: [BAKU, OZETI, ZEST],
			unread: []
		});
		expect(rotationFromText(text).entries).toEqual([BAKU, OZETI, ZEST]);
	});

	test('any of the ways a host writes them', () => {
		const text = [
			'[/Script/WDGame.WDServerMapRotationSettings]',
			'bEnabled=True',
			'RotationMode=Ordered',
			'; infantry nights',
			'+RotationEntries=(Map="Kavkazi",Experiences="Bakurani_KOTH_02+KOTH_InfantryOnly",Lighting="DayClear",ZoneAlternator="ZoneAlternator.Bakurani.Default.Circle")',
			'.RotationEntries=(Map="Europe",Experience="Madrid_KOTH_01",Lighting="DayEarlyFog")',
			'  (Map="NorthAmerica",Experiences="Detroit_KOTH_01+KOTH_Hardcore",Lighting="DayLateRain",ZoneAlternator="ZoneAlternator.Zestafona.Houses.Circle")  ',
			// quoted whole, as the config writer quotes a value it must
			'.RotationEntries="(Map="Europe",Experience="Madrid_KOTH_01",Lighting="DayEarlyFog")"',
			// another section's key of the same name is not the rotation's
			'[/Script/WDGame.WDGameSession]',
			'.RotationEntries=(Map="Kavkazi")',
			''
		].join('\r\n');
		expect(entriesFromText(text)).toEqual({ entries: [BAKU, OZETI, ZEST, OZETI], unread: [] });
	});

	test('read as the server reads its file, so a set plays as the pasted lines would', () => {
		const line = (cmd: string, e: MapSelection) =>
			`${cmd}RotationEntries=${formatRotationEntry(e)}`;
		const lines = [
			line('.', OZETI), // gone: the ClearArray below starts the list again
			'!RotationEntries=ClearArray',
			line('+', BAKU),
			line('+', BAKU), // + adds an entry it does not have yet
			line('.', OZETI),
			line('.', OZETI), // . adds it every time
			line('-', OZETI), // - takes out every copy
			line('.', ZEST)
		];
		expect(entriesFromText(lines.join('\n'))).toEqual({ entries: [BAKU, ZEST], unread: [] });
		// a key without a command sets the list to its one entry
		const set = [line('.', BAKU), line('', OZETI), line('.', ZEST)];
		expect(entriesFromText(set.join('\n')).entries).toEqual([OZETI, ZEST]);
		// exactly what the Map rotation tab reads from a document holding the same lines
		for (const paste of [lines, set])
			expect(entriesFromText(paste.join('\n')).entries).toEqual(
				rotationFromText(`[/Script/WDGame.WDServerMapRotationSettings]\n${paste.join('\n')}`)
					.entries
			);
	});

	test("the community rotation builder's output, headings and all", () => {
		const text = [
			'!! Bakurani',
			'',
			'!! KOTH Infantry Only',
			'',
			'.RotationEntries=(Map="Kavkazi",Experiences="Bakurani_KOTH_02+KOTH_InfantryOnly",Lighting="DayClear",ZoneAlternator="ZoneAlternator.Bakurani.Default.Circle")',
			'',
			'',
			'!! Ozeti',
			'',
			'!! KOTH',
			'',
			'.RotationEntries=(Map="Europe",Experience="Madrid_KOTH_01",Lighting="DayEarlyFog",ZoneAlternator="ZoneAlternator.Ozeti.Default.Circle")'
		].join('\n');
		expect(entriesFromText(text)).toEqual({
			entries: [BAKU, { ...OZETI, zoneAlternator: 'ZoneAlternator.Ozeti.Default.Circle' }],
			unread: []
		});
	});

	test('a line that sets an entry and cannot be read is listed with the reason', () => {
		const read = entriesFromText(
			[
				'.RotationEntries=(Map="Kavkazi",Lighting="Day Clear")',
				'.RotationEntries=(Experience="Madrid_KOTH_01")',
				'.RotationEntries=(Map="Europe")'
			].join('\n')
		);
		expect(read.entries).toEqual([
			{ map: 'Europe', experiences: [], lighting: '', zoneAlternator: '' }
		]);
		expect(read.unread).toEqual([
			{ line: 1, why: '"Day Clear" is not a time of day id' },
			{ line: 2, why: 'it names no map' }
		]);
	});

	test('nothing at all reads as no entries', () => {
		expect(entriesFromText('')).toEqual({ entries: [], unread: [] });
		expect(entriesFromText('bEnabled=True\n[Section]\n# note')).toEqual({
			entries: [],
			unread: []
		});
	});
});

describe('which set a rotation is', () => {
	const sets: MapSet[] = [
		{ id: 'a', name: 'Infantry', entries: [BAKU, OZETI, ZEST] },
		{ id: 'b', name: 'Two maps', entries: [OZETI, ZEST] }
	];

	test('the same entries in the same order, then in another, ignoring case and None', () => {
		expect(mapSetOf(sets, [BAKU, OZETI, ZEST])).toEqual({ set: sets[0], reordered: false });
		expect(mapSetOf(sets, [ZEST, BAKU, OZETI])).toEqual({ set: sets[0], reordered: true });
		expect(
			mapSetOf(sets, [{ ...OZETI, map: 'europe', zoneAlternator: 'None' }, { ...ZEST }])
		).toEqual({ set: sets[1], reordered: false });
		expect(mapSetOf(sets, [BAKU, OZETI])).toBeNull();
		expect(mapSetOf(sets, [])).toBeNull();
		expect(mapSetOf(sets, [BAKU, OZETI, ZEST, ZEST])).toBeNull();
	});

	test('a set is found by name ignoring case and spacing', () => {
		expect(mapSetNamed(sets, '  INFANTRY ')).toBe(sets[0]);
		expect(mapSetNamed(sets, 'Hardcore')).toBeUndefined();
		expect(mapSetNamed(sets, '')).toBeUndefined();
	});

	test('how many entries each map has, in the order it first comes', () => {
		expect(mapCounts([OZETI, BAKU, OZETI, ZEST, { ...BAKU, map: 'kavkazi' }])).toEqual([
			{ map: 'Europe', count: 2 },
			{ map: 'Kavkazi', count: 2 },
			{ map: 'NorthAmerica', count: 1 }
		]);
	});
});
