import { test, expect } from 'bun:test';
import {
	formatRotationEntry,
	parseRotationEntry,
	rotationFromText,
	rotationIntoText
} from './rotation-doc';
import { getArray, parseIni, setArrayInText } from './config-doc';

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
