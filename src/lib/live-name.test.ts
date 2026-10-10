import { describe, expect, test } from 'bun:test';
import { LIVE_NAME_MAX, liveName, liveNameVars, oneLine } from './live-name';

const look = {
	map: 'Kavkazi',
	playerCount: 27,
	maxPlayers: 30,
	scores: [
		{ name: 'Valkyra', colorHex: '#D86060', score: 34 },
		{ name: 'Lonestar', colorHex: '#5B95D8', score: 27 },
		{ name: 'Manticore', colorHex: '#7BC462', score: 30 }
	]
};

describe('the live server name', () => {
	test('the server name, a space, and the appended part filled in', () => {
		expect(liveName({ base: 'Demo Clan #1 | Infantry Only', append: '| {scoreline}' }, look)).toBe(
			'Demo Clan #1 | Infantry Only | 34-27-30'
		);
		expect(liveName({ base: 'Demo', append: '| {map} {scoreline} ({players}/{max})' }, look)).toBe(
			'Demo | Bakurani 34-27-30 (27/30)'
		);
	});

	test('scores in the order the game lists them, whole and never below nothing', () => {
		expect(
			liveNameVars({
				...look,
				scores: [
					{ name: 'A', colorHex: '', score: 2.6 },
					{ name: 'B', colorHex: '', score: -1 }
				]
			}).get('scoreline')
		).toBe('3-0');
		expect(liveNameVars({ ...look, scores: [] }).get('scoreline')).toBe('');
	});

	test('a name it does not know stays as typed, including the names every object has', () => {
		expect(liveName({ base: 'Demo', append: '{constructor} {Scoreline} {nope}' }, look)).toBe(
			'Demo {constructor} 34-27-30 {nope}'
		);
	});

	test('one line, whatever was typed or sent: a line break cannot start a new line of the config', () => {
		const name = liveName(
			{ base: 'Demo\r\n[/Script/WDRCON.WDRCONSettings]\nPassword=stolen', append: '|\u2028{map}' },
			{ ...look, map: 'Kavkazi\nPassword=x' }
		);
		expect(name).not.toMatch(/[\r\n\u2028\u2029\u0085]/);
		expect(oneLine('a\tb\u0000c\u007f')).toBe('a b c');
	});

	test('cut to the longest name it writes, never through an emoji', () => {
		const base = `${'x'.repeat(LIVE_NAME_MAX - 3)}`;
		const name = liveName({ base, append: '🎯🎯🎯🎯' }, look);
		expect(Array.from(name)).toHaveLength(LIVE_NAME_MAX);
		expect(name.endsWith(' 🎯🎯')).toBe(true);
	});
});
