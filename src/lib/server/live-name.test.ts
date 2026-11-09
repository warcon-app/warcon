import { describe, expect, test } from 'bun:test';
import {
	LIVE_NAME_EVERY_MS,
	LIVE_NAME_SAME_MS,
	liveNameState,
	nameDue,
	validateLiveName,
	type NameMemory
} from './live-name';

describe('Live server name settings', () => {
	test('the server name is needed; what is appended defaults to the score line', () => {
		expect(() => validateLiveName({})).toThrow(/server's own name/);
		expect(() => validateLiveName({ base: ' \n ' })).toThrow(/server's own name/);
		expect(validateLiveName({ base: ' Demo ' })).toEqual({ base: 'Demo', append: '| {scoreline}' });
		expect(() => validateLiveName({ base: 'Demo', append: '  ' })).toThrow(/what to append/);
	});

	test('saved on one line, and no longer than the name and the appended part may be', () => {
		const c = validateLiveName({
			base: `Demo\r\n[/Script/WDRCON.WDRCONSettings]\r\nPassword=stolen${'x'.repeat(200)}`,
			append: `|\n{scoreline}${'y'.repeat(100)}`
		});
		expect(c.base).not.toMatch(/[\r\n]/);
		expect(c.append).not.toMatch(/[\r\n]/);
		expect(Array.from(c.base)).toHaveLength(100);
		expect(Array.from(c.append)).toHaveLength(60);
	});

	test('the row state reads back, and anything else is no state', () => {
		expect(liveNameState(null)).toBeNull();
		expect(liveNameState({ name: 'A', at: 5, refused: '', since: 0, restored: true })).toEqual({
			name: 'A',
			at: 5,
			refused: '',
			since: 0,
			restored: true
		});
		expect(liveNameState({ name: 3, at: 'x' })).toEqual({
			name: '',
			at: 0,
			refused: '',
			since: 0,
			restored: false
		});
	});
});

describe('when the worker writes', () => {
	const mem = (over: Partial<NameMemory> = {}): NameMemory => ({
		ruleId: 'r',
		base: 'Demo',
		attemptAt: 0,
		written: '',
		writtenAt: 0,
		refused: '',
		...over
	});
	const now = 10_000_000;

	test('when the server shows another name, at most once a minute', () => {
		expect(nameDue(mem(), 'Demo | 1-2', 'Demo', now)).toBe(true);
		expect(nameDue(mem(), 'Demo | 1-2', 'Demo | 1-2', now)).toBe(false);
		expect(
			nameDue(mem({ attemptAt: now - LIVE_NAME_EVERY_MS + 1 }), 'Demo | 1-3', 'Demo', now)
		).toBe(false);
		expect(nameDue(mem({ attemptAt: now - LIVE_NAME_EVERY_MS }), 'Demo | 1-3', 'Demo', now)).toBe(
			true
		);
	});

	test('the name it wrote last, which the server shows otherwise, only every ten minutes', () => {
		const wrote = mem({
			attemptAt: now - 120_000,
			written: 'Demo | 1-2',
			writtenAt: now - 120_000
		});
		expect(nameDue(wrote, 'Demo | 1-2', 'Demo | 1-', now)).toBe(false);
		expect(
			nameDue({ ...wrote, writtenAt: now - LIVE_NAME_SAME_MS }, 'Demo | 1-2', 'Demo | 1-', now)
		).toBe(true);
		expect(nameDue(wrote, 'Demo | 1-3', 'Demo | 1-', now)).toBe(true);
	});

	test('never an empty name', () => {
		expect(nameDue(mem(), '', 'Demo', now)).toBe(false);
	});
});
