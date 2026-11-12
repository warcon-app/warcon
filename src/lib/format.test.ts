import { describe, expect, test } from 'bun:test';
import {
	andList,
	expLabel,
	expSetLabel,
	factionColor,
	fmtAgo,
	fmtSpan,
	hexColor,
	isMod,
	lacksGameMode,
	lightingsOn,
	limitsLightings,
	mapId,
	mapLabel,
	mapName,
	saneScores,
	steamNameBeside,
	takesLighting
} from './format';
import type { Catalog } from './types';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('fmtSpan', () => {
	test('picks the coarsest unit that still reads', () => {
		expect(fmtSpan(0)).toBe('0 s');
		expect(fmtSpan(40_000)).toBe('40 s');
		expect(fmtSpan(12 * MIN)).toBe('12 min');
		expect(fmtSpan(90 * MIN)).toBe('2 h');
		expect(fmtSpan(35 * HOUR)).toBe('35 h');
		expect(fmtSpan(DAY)).toBe('24 h');
		expect(fmtSpan(36 * HOUR)).toBe('2 days');
		expect(fmtSpan(6 * DAY)).toBe('6 days');
	});
});

describe('fmtAgo', () => {
	const now = Date.parse('2026-09-17T12:00:00Z');
	test('reads as a status line', () => {
		expect(fmtAgo(now - 10_000, now)).toBe('just now');
		expect(fmtAgo(now - 2 * MIN, now)).toBe('2 min ago');
		expect(fmtAgo(now - 4 * HOUR, now)).toBe('4 h ago');
		expect(fmtAgo(now - 3 * DAY, now)).toBe('3 days ago');
	});
	test('takes ISO strings and never goes negative', () => {
		expect(fmtAgo(new Date(now - 5 * MIN).toISOString(), now)).toBe('5 min ago');
		expect(fmtAgo(now + 10 * MIN, now)).toBe('just now');
	});
	test('falls back to the date past a month', () => {
		expect(fmtAgo(now - 47 * DAY, now)).not.toContain('ago');
		expect(fmtAgo('not a date', now)).toBe('not a date');
	});
});

test('mapId: the name players know and the catalog id are one map', () => {
	expect(mapId('NorthAmerica')).toBe('NorthAmerica');
	expect(mapId('Zestafona')).toBe('NorthAmerica');
	expect(mapId('bakurani')).toBe('Kavkazi');
	expect(mapId('SomeNewMap')).toBe('SomeNewMap');
	expect(mapId('')).toBe('');
});

test('Sabatulo is the map the game calls Russia', () => {
	expect(mapId('Sabatulo')).toBe('Russia');
	expect(mapId('Russia')).toBe('Russia');
	expect(mapName('Russia')).toBe('Sabatulo');
	expect(mapName('Sabatulo')).toBe('Sabatulo');
});

/** No server at hand: the labels come from the ids alone. */
const NO_CATALOG: Catalog = { maps: [], lightings: [], experiences: [] };

describe('game modes and modifiers', () => {
	test('a game mode is named for its place, a modifier for the mode it changes', () => {
		for (const id of [
			'Bakurani_KOTH_01',
			'Bakurani_KOTH_02',
			'Madrid_KOTH_01',
			'Detroit_KOTH_01',
			'Moscow_KOTH_01'
		])
			expect(isMod(id)).toBe(false);
		for (const id of ['KOTH_InfantryOnly', 'KOTH_Hardcore', 'KOTH_LimitedGear', 'koth_limitedgear'])
			expect(isMod(id)).toBe(true);
	});

	test('a modifier the panel has not heard of is still one, named from its id', () => {
		expect(isMod('KOTH_NightOps')).toBe(true);
		expect(expLabel(NO_CATALOG, 'KOTH_NightOps')).toBe('Night Ops');
		expect(expSetLabel(NO_CATALOG, ['Moscow_KOTH_01', 'KOTH_NightOps'])).toBe(
			'King of the Hill + Night Ops'
		);
	});

	test('Limited Gear with no game mode lacks one; the older modifiers alone are not held to it', () => {
		expect(lacksGameMode(['KOTH_LimitedGear'])).toBe(true);
		expect(lacksGameMode(['KOTH_InfantryOnly', 'koth_limitedgear'])).toBe(true);
		expect(lacksGameMode(['Moscow_KOTH_01', 'KOTH_LimitedGear'])).toBe(false);
		expect(lacksGameMode(['KOTH_LimitedGear', 'Moscow_KOTH_01'])).toBe(false);
		// not known of these two (the official console's demo rotation has an Infantry Only entry)
		expect(lacksGameMode(['KOTH_InfantryOnly'])).toBe(false);
		expect(lacksGameMode(['KOTH_Hardcore', 'KOTH_InfantryOnly'])).toBe(false);
		expect(lacksGameMode([])).toBe(false);
	});

	test('a modifier listed without the mode’s prefix is the same modifier, named the same', () => {
		// a live Season 3 server's list: both ids, each with its id for a display name
		const live: Catalog = {
			maps: [],
			lightings: [],
			experiences: [
				{ id: 'Moscow_KOTH_01', display: 'Moscow KOTH 01' },
				{ id: 'KOTH_LimitedGear', display: 'KOTH LimitedGear' },
				{ id: 'LimitedGear', display: 'LimitedGear' },
				{ id: 'KOTH_InfantryOnly', display: 'KOTH InfantryOnly' }
			]
		};
		for (const id of ['KOTH_LimitedGear', 'LimitedGear', 'limitedgear']) {
			expect(isMod(id)).toBe(true);
			expect(expLabel(live, id)).toBe(id === 'limitedgear' ? 'limitedgear' : 'Limited Gear');
		}
		expect(expLabel(live, 'KOTH_InfantryOnly')).toBe('Infantry Only');
		expect(expLabel(live, 'Moscow_KOTH_01')).toBe('King of the Hill');
		expect(expSetLabel(live, ['Moscow_KOTH_01', 'LimitedGear'])).toBe(
			'King of the Hill + Limited Gear'
		);
		expect(lacksGameMode(['LimitedGear'])).toBe(true);
	});

	test('Limited Gear goes on a game mode, alone or with the other modifiers', () => {
		expect(expLabel(NO_CATALOG, 'KOTH_LimitedGear')).toBe('Limited Gear');
		expect(expSetLabel(NO_CATALOG, ['Moscow_KOTH_01', 'KOTH_LimitedGear'])).toBe(
			'King of the Hill + Limited Gear'
		);
		expect(
			expSetLabel(NO_CATALOG, ['Madrid_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_LimitedGear'])
		).toBe('King of the Hill + Infantry Only + Limited Gear');
		// on its own it is no game mode, and is not called one
		expect(expSetLabel(NO_CATALOG, ['KOTH_LimitedGear'])).toBe('Limited Gear');
	});
});

describe('the lightings a map takes', () => {
	const ALL = [
		'DayStartClear',
		'DayEarlyClear',
		'DayEarlyFog',
		'DayClear',
		'DayLateClear',
		'DayLateGray',
		'DayLateGrayFog',
		'DayEndClear',
		'DayLateRain'
	].map((id) => ({ id }));
	const ids = (list: { id: string }[]) => list.map((l) => l.id);

	test('Sabatulo takes four, by its id or its name; every other map takes them all', () => {
		const four = ['DayClear', 'DayLateClear', 'DayLateGray', 'DayLateRain'];
		for (const map of ['Russia', 'russia', 'Sabatulo', 'sabatulo']) {
			expect(ids(lightingsOn(map, ALL))).toEqual(four);
			expect(limitsLightings(map)).toBe(true);
		}
		for (const map of ['Kavkazi', 'Bakurani', 'Europe', 'NorthAmerica', 'SomeNewMap', '', null]) {
			expect(lightingsOn(map, ALL)).toEqual(ALL);
			expect(limitsLightings(map)).toBe(false);
		}
		expect(takesLighting('Russia', 'DayEarlyFog')).toBe(false);
		expect(takesLighting('Sabatulo', 'DayLateGrayFog')).toBe(false);
		expect(takesLighting('Russia', ' daylaterain ')).toBe(true);
		expect(takesLighting('Kavkazi', 'DayEarlyFog')).toBe(true);
		expect(takesLighting(null, 'DayEarlyFog')).toBe(true);
	});

	test('the grey one is DayLateGray, as the game lists it, not the notes’ DayLateGrey', () => {
		expect(takesLighting('Russia', 'DayLateGray')).toBe(true);
		expect(takesLighting('Russia', 'DayLateGrey')).toBe(false);
	});

	test('a list holding none of them leaves none', () => {
		expect(lightingsOn('Russia', [{ id: 'NightStorm' }, { id: 'DayEarlyFog' }])).toEqual([]);
		expect(lightingsOn('Russia', [])).toEqual([]);
	});

	test('a map named like one of Object’s own members is a map like any other', () => {
		for (const odd of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
			expect(takesLighting(odd, 'DayEarlyFog')).toBe(true);
			expect(limitsLightings(odd)).toBe(false);
			expect(lightingsOn(odd, ALL)).toEqual(ALL);
			expect(mapId(odd)).toBe(odd);
			expect(typeof mapName(odd)).toBe('string');
			expect(typeof mapLabel(NO_CATALOG, odd)).toBe('string');
		}
		expect(mapName('constructor')).toBe('constructor');
	});
});

test('andList: a list as a sentence has it', () => {
	expect(andList([])).toBe('');
	expect(andList(['Day Clear'])).toBe('Day Clear');
	expect(andList(['Day Clear', 'Day Late Rain'])).toBe('Day Clear and Day Late Rain');
	expect(andList(['Day Clear', 'Day Late Gray', 'Day Late Rain'])).toBe(
		'Day Clear, Day Late Gray and Day Late Rain'
	);
});

describe('steamNameBeside', () => {
	test('shows the Steam name when the in-game name does not carry it', () => {
		expect(steamNameBeside('Anonymous', 'shadowfox')).toBe('shadowfox');
		expect(steamNameBeside('Lt. Dan', 'dan_1987')).toBe('dan_1987');
		expect(steamNameBeside('Anonymous', '  Kestrel ')).toBe('Kestrel');
		// inside another word is not carrying it
		expect(steamNameBeside('Jordan', 'dan')).toBe('dan');
		expect(steamNameBeside('Ghostpepper2', 'Ghostpepper')).toBe('Ghostpepper');
	});

	test('says nothing when the in-game name already has it, or there is none', () => {
		expect(steamNameBeside('[ABC] Night Owl', 'Night Owl')).toBeNull();
		expect(steamNameBeside('ghostpepper', 'GhostPepper')).toBeNull();
		expect(steamNameBeside('Lt. Dan', 'dan')).toBeNull();
		expect(steamNameBeside('[ABC]xX_Sn1per_Xx', 'xx_sn1per_xx')).toBeNull();
		expect(steamNameBeside('Ｋｅｓｔｒｅｌ', 'Kestrel')).toBeNull();
		expect(steamNameBeside('Anonymous', '')).toBeNull();
		expect(steamNameBeside('Anonymous', '   ')).toBeNull();
		expect(steamNameBeside('Anonymous', null)).toBeNull();
		expect(steamNameBeside('Anonymous', undefined)).toBeNull();
	});
});

// A game server's colours land in style attributes on every viewer's page: anything but #rrggbb
// could carry CSS (a background image that reports each viewer's address, an overlay).
const HOSTILE = 'red;background:url(https://evil.example/beacon?v=1);position:fixed;inset:0';

describe('hexColor', () => {
	test('keeps #rrggbb and nothing else', () => {
		expect(hexColor('#D86060')).toBe('#D86060');
		expect(hexColor('#5b95d8')).toBe('#5b95d8');
		for (const bad of [
			HOSTILE,
			'red',
			'#fff',
			'#12345',
			'#1234567',
			' #D86060',
			'#D86060;',
			'url(x)',
			7,
			null
		])
			expect(hexColor(bad)).toBe('');
	});
});

describe('saneScores', () => {
	test('names as text, colours as #rrggbb or nothing, scores as finite numbers', () => {
		expect(
			saneScores([
				{ name: 'Valkyra', colorHex: '#D86060', score: 34 },
				{ name: 'Lonestar', colorHex: HOSTILE, score: 'abc' },
				{ name: 7, colorHex: '#7BC462', score: '12' },
				null,
				'junk'
			])
		).toEqual([
			{ name: 'Valkyra', colorHex: '#D86060', score: 34 },
			{ name: 'Lonestar', colorHex: '', score: 0 },
			{ name: '7', colorHex: '#7BC462', score: 12 }
		]);
		expect(saneScores(undefined)).toEqual([]);
		expect(saneScores({ scores: [] })).toEqual([]);
	});

	test('factionColor falls back rather than pass a hostile colour on', () => {
		expect(factionColor('Lonestar', [{ name: 'Lonestar', colorHex: HOSTILE, score: 0 }])).toBe(
			'#5E5E66'
		);
		expect(factionColor('Valkyra', [{ name: 'Valkyra', colorHex: '#D86060', score: 0 }])).toBe(
			'#D86060'
		);
	});
});
