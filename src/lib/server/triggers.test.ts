import { describe, expect, test } from 'bun:test';
import { onTarget, renderTemplate, riskKickVerdict, validateConfig } from './trigger-rules';
import type { RiskKickConfig } from './trigger-rules';

describe('validateConfig', () => {
	test('welcome needs a message and trims it to 200 characters', () => {
		expect(() => validateConfig('welcome', { message: '  ' })).toThrow('empty');
		const c = validateConfig('welcome', { message: 'x'.repeat(300), onlyFirstVisit: 'yes' });
		expect(c).toEqual({ message: 'x'.repeat(200), onlyFirstVisit: true });
	});
	test('broadcast accepts a newline-separated string and drops blanks', () => {
		const c = validateConfig('broadcast', {
			messages: 'a\n\n b \n',
			everyMinutes: '15',
			minPlayers: -3
		});
		expect(c).toEqual({ messages: ['a', 'b'], everyMinutes: 15, minPlayers: 0 });
		expect(() => validateConfig('broadcast', { messages: [], everyMinutes: 5 })).toThrow(
			'at least one'
		);
		expect(() => validateConfig('broadcast', { messages: ['a'], everyMinutes: 0 })).toThrow(
			'1-1440'
		);
	});
	test('empty_reset needs a map and a wait', () => {
		expect(() => validateConfig('empty_reset', { afterMinutes: 5 })).toThrow('map');
		const c = validateConfig('empty_reset', {
			map: 'Kavkazi',
			experiences: ['Bakurani_KOTH_01'],
			afterMinutes: 20
		});
		expect(c).toMatchObject({
			map: 'Kavkazi',
			afterMinutes: 20,
			cooldownMinutes: 30,
			lighting: ''
		});
	});
	test('risk_kick refuses an empty rule set and defaults the reason', () => {
		expect(() => validateConfig('risk_kick', {})).toThrow('at least one rule');
		const c = validateConfig('risk_kick', { vacBans: true }) as RiskKickConfig;
		expect(c.spareReserved).toBe(true);
		expect(c.reason).toContain('requirements');
	});
});

describe('renderTemplate', () => {
	test('fills placeholders case-insensitively and leaves unknown ones', () => {
		expect(
			renderTemplate('Hi {NAME}, welcome to {server} ({players}/{max}) on {map} {nope}', {
				name: 'Nomad',
				server: 'EU #1',
				players: 3,
				max: 64,
				map: 'Kavkazi'
			})
		).toBe('Hi Nomad, welcome to EU #1 (3/64) on Kavkazi {nope}');
	});
	test('clips to 200 characters', () => {
		expect(renderTemplate('{name}', { name: 'y'.repeat(500) })).toHaveLength(200);
	});
});

describe('riskKickVerdict', () => {
	const cfg: RiskKickConfig = {
		vacBans: true,
		gameBans: false,
		minAccountDays: 30,
		privateProfiles: false,
		bannedElsewhere: true,
		watchlist: true,
		spareReserved: true,
		reason: 'no'
	};
	const now = new Date('2026-09-09T12:00:00Z');
	const profile = {
		steamId: '76561198000000001',
		persona: '',
		avatar: '',
		profileUrl: '',
		public: true,
		accountCreatedAt: new Date('2026-09-01T00:00:00Z'),
		vacBans: 0,
		gameBans: 0,
		daysSinceLastBan: null,
		communityBanned: false,
		economyBan: 'none',
		fetchedAt: now,
		error: ''
	};
	const base = { profile, steamEnabled: true, bannedOn: [], watched: null, reserved: false, now };

	test('reserved slots are spared', () => {
		expect(
			riskKickVerdict(cfg, { ...base, reserved: true, bannedOn: [{ serverName: 'x', reason: '' }] })
		).toBeNull();
		expect(
			riskKickVerdict(
				{ ...cfg, spareReserved: false },
				{ ...base, reserved: true, bannedOn: [{ serverName: 'x', reason: '' }] }
			)
		).toBe('banned on x');
	});
	test('order: ban elsewhere, watchlist, VAC, age', () => {
		expect(riskKickVerdict(cfg, { ...base, watched: { reason: 'tk' } })).toBe(
			'on the watchlist (tk)'
		);
		expect(riskKickVerdict(cfg, { ...base, profile: { ...profile, vacBans: 2 } })).toBe(
			'2 VAC bans on record'
		);
		expect(riskKickVerdict(cfg, base)).toBe('Steam account only 8 days old (minimum 30)');
		expect(
			riskKickVerdict(cfg, {
				...base,
				profile: { ...profile, accountCreatedAt: new Date('2020-01-01') }
			})
		).toBeNull();
	});
	test('private profiles pass unless asked to fail', () => {
		const priv = { ...profile, public: false, accountCreatedAt: null };
		expect(riskKickVerdict(cfg, { ...base, profile: priv })).toBeNull();
		expect(riskKickVerdict({ ...cfg, privateProfiles: true }, { ...base, profile: priv })).toBe(
			'private profile, account age unknown'
		);
	});
	test('without Steam only the local rules apply', () => {
		expect(riskKickVerdict(cfg, { ...base, steamEnabled: false, profile: null })).toBeNull();
		expect(
			riskKickVerdict(cfg, { ...base, profile: { ...profile, error: 'Not found on Steam.' } })
		).toBeNull();
	});
});

describe('onTarget', () => {
	test('map alone when the rule names no experiences, else the set must match', () => {
		expect(
			onTarget({ map: 'Kavkazi', experiences: [] }, { map: 'Kavkazi', experiences: ['a'] })
		).toBe(true);
		expect(
			onTarget(
				{ map: 'Kavkazi', experiences: ['b', 'a'] },
				{ map: 'Kavkazi', experiences: ['a', 'b'] }
			)
		).toBe(true);
		expect(
			onTarget({ map: 'Kavkazi', experiences: ['a'] }, { map: 'Kavkazi', experiences: ['a', 'b'] })
		).toBe(false);
		expect(onTarget({ map: 'Europe', experiences: [] }, { map: 'Kavkazi', experiences: [] })).toBe(
			false
		);
	});
});
