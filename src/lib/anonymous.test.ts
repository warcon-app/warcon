// Anonymous mode as the panel reads it from a player's row: the hidden name kept only while it is
// the one the other players see, and the name shown to anyone who is not staff.
import { describe, expect, test } from 'bun:test';
import { ANONYMOUS, hiddenNameOf, isAnonymous, seenAs } from './anonymous';

describe('hiddenNameOf', () => {
	test('a player in anonymous mode carries the hidden name; everyone else none', () => {
		expect(hiddenNameOf({ hiddenName: 'Falcon', anonymous: true })).toBe('Falcon');
		// everyone has a hidden name: one that is not in use is not kept
		expect(hiddenNameOf({ hiddenName: 'Falcon', anonymous: false })).toBeUndefined();
		expect(hiddenNameOf({ hiddenName: 'Falcon' })).toBeUndefined();
		// a build from before Season 3 sends neither
		expect(hiddenNameOf({})).toBeUndefined();
		for (const raw of [null, undefined]) expect(hiddenNameOf(raw)).toBeUndefined();
	});

	test('anonymous is the game’s own true, nothing that merely reads as it', () => {
		for (const anonymous of ['true', 1, {}, 'yes'])
			expect(hiddenNameOf({ hiddenName: 'Falcon', anonymous })).toBeUndefined();
	});

	test('an anonymous player with no usable hidden name still has no name of their own to show', () => {
		for (const hiddenName of ['', '   ', null, undefined, 42, String.fromCharCode(0, 9)])
			expect(hiddenNameOf({ hiddenName, anonymous: true })).toBe(ANONYMOUS);
	});

	test('the hidden name is one short line of text', () => {
		const line = `Fal${String.fromCharCode(10)}con${String.fromCharCode(0)}`;
		expect(hiddenNameOf({ hiddenName: line, anonymous: true })).toBe('Fal con');
		expect(hiddenNameOf({ hiddenName: 'x'.repeat(100), anonymous: true })).toBe('x'.repeat(64));
		expect(hiddenNameOf({ hiddenName: '  Heron ', anonymous: true })).toBe('Heron');
	});
});

describe('the name shown', () => {
	test('others see the hidden name of a player in anonymous mode, and anyone else’s own', () => {
		expect(seenAs({ name: 'Mad Marmalade', hiddenName: 'Falcon' })).toBe('Falcon');
		expect(seenAs({ name: 'Mad Marmalade' })).toBe('Mad Marmalade');
		expect(seenAs({ name: 'Mad Marmalade', hiddenName: null })).toBe('Mad Marmalade');
		expect(seenAs({ name: 'Mad Marmalade', hiddenName: '' })).toBe('Mad Marmalade');
	});

	test('a row says whether its player is anonymous', () => {
		expect(isAnonymous({ hiddenName: 'Falcon' })).toBe(true);
		expect(isAnonymous({})).toBe(false);
		expect(isAnonymous({ hiddenName: null })).toBe(false);
	});
});
