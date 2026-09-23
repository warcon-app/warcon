import { describe, expect, test } from 'bun:test';
import {
	broadcastWanted,
	factionChangeTargets,
	onTarget,
	renderTemplate,
	restartNoticeStage,
	fullMoments,
	lowStretches,
	matchBoundary,
	matchBroadcastMessages,
	matchReplay,
	pingKickStep,
	riskKickVerdict,
	seedRule,
	seedReplay,
	teamKillStage,
	validateConfig,
	welcomeTargets
} from './trigger-rules';
import type { MatchBroadcastConfig, RiskKickConfig } from './trigger-rules';

describe('validateConfig', () => {
	test('welcome needs a message and trims it to 200 characters', () => {
		expect(() => validateConfig('welcome', { message: '  ' })).toThrow('empty');
		const c = validateConfig('welcome', { message: 'x'.repeat(300), onlyFirstVisit: 'yes' });
		expect(c).toEqual({ message: 'x'.repeat(200), onlyFirstVisit: true, afterFaction: false });
		expect(validateConfig('welcome', { message: 'hi', afterFaction: 1 })).toMatchObject({
			afterFaction: true
		});
	});
	test('faction_change needs a message', () => {
		expect(() => validateConfig('faction_change', {})).toThrow('empty');
		expect(validateConfig('faction_change', { message: ' hi ' })).toEqual({ message: 'hi' });
	});
	test('broadcast accepts a newline-separated string and drops blanks', () => {
		const c = validateConfig('broadcast', {
			messages: 'a\n\n b \n',
			everyMinutes: '15',
			minPlayers: -3
		});
		expect(c).toEqual({ messages: ['a', 'b'], everyMinutes: 15, minPlayers: 0, maxPlayers: null });
		expect(() => validateConfig('broadcast', { messages: [], everyMinutes: 5 })).toThrow(
			'at least one'
		);
		expect(() => validateConfig('broadcast', { messages: ['a'], everyMinutes: 0 })).toThrow(
			'1-1440'
		);
	});
	test('broadcast takes an optional player ceiling that cannot sit below the floor', () => {
		const base = { messages: ['a'], everyMinutes: 5 };
		expect(validateConfig('broadcast', { ...base, minPlayers: 2, maxPlayers: '' })).toMatchObject({
			maxPlayers: null
		});
		expect(validateConfig('broadcast', { ...base, minPlayers: 2, maxPlayers: '20' })).toMatchObject(
			{ minPlayers: 2, maxPlayers: 20 }
		);
		expect(() => validateConfig('broadcast', { ...base, minPlayers: 5, maxPlayers: 4 })).toThrow(
			'ceiling'
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
	test('restart_notice needs the main message, and a heads-up message when the heads-up is on', () => {
		expect(() => validateConfig('restart_notice', {})).toThrow('empty');
		expect(() =>
			validateConfig('restart_notice', { message: 'bye', leadMinutes: 30, leadMessage: '' })
		).toThrow('heads-up');
		expect(validateConfig('restart_notice', { message: ' bye ', leadMinutes: 0 })).toEqual({
			message: 'bye',
			leadMinutes: 0,
			leadMessage: '',
			repeatMinutes: 0,
			minPlayers: 1
		});
		// the heads-up cannot be earlier than the game start
		expect(
			validateConfig('restart_notice', { message: 'bye', leadMinutes: 5000, leadMessage: 'soon' })
		).toMatchObject({ leadMinutes: 1439 });
	});
	test('risk_kick refuses an empty rule set and defaults the reason', () => {
		expect(() => validateConfig('risk_kick', {})).toThrow('at least one rule');
		const c = validateConfig('risk_kick', { vacBans: true }) as RiskKickConfig;
		expect(c.spareReserved).toBe(true);
		expect(c.maxBanAgeDays).toBe(0);
		expect(c.kickAtLevel).toBeNull();
		expect(c.reason).toContain('requirements');
		expect(validateConfig('risk_kick', { kickAtLevel: 'medium' })).toMatchObject({
			kickAtLevel: 'medium'
		});
		expect(() => validateConfig('risk_kick', { kickAtLevel: 'low' })).toThrow('at least one rule');
	});
	test('ping_kick validates the ping and duration and supplies a reason', () => {
		expect(validateConfig('ping_kick', {})).toEqual({
			maxPingMs: 200,
			durationSeconds: 60,
			reason: 'Ping too high for too long.'
		});
		expect(() => validateConfig('ping_kick', { maxPingMs: 0 })).toThrow('ping limit');
		expect(() => validateConfig('ping_kick', { durationSeconds: 0 })).toThrow('duration');
		expect(validateConfig('ping_kick', { maxPingMs: 250, durationSeconds: 30 })).toMatchObject({
			maxPingMs: 250,
			durationSeconds: 30
		});
	});
	test('seed_reward needs a seed time that fits its window, and fills in the rest', () => {
		expect(() => validateConfig('seed_reward', {})).toThrow('minutes');
		expect(() => validateConfig('seed_reward', { minutes: 60 * 24 * 8, windowDays: 7 })).toThrow(
			'window'
		);
		expect(() => validateConfig('seed_reward', { minutes: 60, lowAt: 20, fullAt: 20 })).toThrow(
			'Filled'
		);
		expect(validateConfig('seed_reward', { minutes: 60, lowAt: 20, fullAt: '90' })).toMatchObject({
			fullAt: 90
		});
		expect(validateConfig('seed_reward', { minutes: '45' })).toEqual({
			scope: 'org',
			lowAt: 20,
			untilFull: true,
			fullAt: null,
			minutes: 45,
			windowDays: 7,
			slotDays: 7,
			message: ''
		});
		expect(
			validateConfig('seed_reward', {
				lowAt: 0,
				minutes: 30,
				windowDays: 200,
				slotDays: 0,
				untilFull: false,
				message: ' thanks {name} '
			})
		).toEqual({
			scope: 'org',
			lowAt: 1,
			untilFull: false,
			fullAt: null,
			minutes: 30,
			windowDays: 90,
			slotDays: 1,
			message: 'thanks {name}'
		});
	});
	test('seed_reward keeps a slot on this server only when asked, org-wide otherwise', () => {
		expect(validateConfig('seed_reward', { minutes: 60, scope: 'server' })).toMatchObject({
			scope: 'server'
		});
		expect(validateConfig('seed_reward', { minutes: 60, scope: 'org' })).toMatchObject({
			scope: 'org'
		});
		expect(validateConfig('seed_reward', { minutes: 60, scope: 'everywhere' })).toMatchObject({
			scope: 'org'
		});
	});
});

describe('pingKickStep', () => {
	const cfg = { maxPingMs: 200, durationSeconds: 30, reason: 'High ping' };
	const high = [{ steamId: 'a', ping: 250 }];
	const step = (state: Parameters<typeof pingKickStep>[1], players: typeof high, now: number) =>
		pingKickStep(cfg, state, players, now, 5000);
	test('fires only after a continuous high-ping duration, and only once per streak', () => {
		const first = step(null, high, 1000);
		expect(first.kicks).toEqual([]);
		const early = step(first.state, high, 29_000);
		// A gap in player sampling restarts the timer.
		expect(early.kicks).toEqual([]);
		expect(early.state.players.a.since).toBe(29_000);
		let state = step(null, high, 0).state;
		for (const at of [5000, 10_000, 15_000, 20_000, 25_000]) state = step(state, high, at).state;
		const due = step(state, high, 30_000);
		expect(due.kicks).toEqual(['a']);
		expect(step(due.state, high, 35_000).kicks).toEqual([]);
		const recovered = step(due.state, [{ steamId: 'a', ping: 100 }], 35_000);
		let again = step(recovered.state, high, 40_000).state;
		for (const at of [45_000, 50_000, 55_000, 60_000, 65_000]) again = step(again, high, at).state;
		expect(step(again, high, 70_000).kicks).toEqual(['a']);
	});
	test('normal or missing ping and leaving reset the streak', () => {
		const first = step(null, high, 0);
		for (const players of [[{ steamId: 'a', ping: 200 }], [{ steamId: 'a', ping: null }], []]) {
			const reset = pingKickStep(cfg, first.state, players, 1000, 5000);
			expect(reset.state.players.a).toBeUndefined();
			expect(step(reset.state, high, 2000).state.players.a.since).toBe(2000);
		}
	});
});

describe('validateConfig match_broadcast', () => {
	test('needs at least one of the two messages and defaults the player floor', () => {
		expect(() => validateConfig('match_broadcast', {})).toThrow(/message/);
		expect(validateConfig('match_broadcast', { startMessage: 'Go!' })).toEqual({
			endMessage: '',
			startMessage: 'Go!',
			minPlayers: 1
		});
		expect(
			validateConfig('match_broadcast', { endMessage: ' {faction} won ', minPlayers: 10 })
		).toMatchObject({ endMessage: '{faction} won', minPlayers: 10 });
	});
});

describe('seedRule', () => {
	test('is the seeding rule with the highest threshold, or null without one', () => {
		expect(seedRule([])).toBeNull();
		expect(seedRule([{ kind: 'welcome', config: { lowAt: 5 } }])).toBeNull();
		expect(
			seedRule([
				{ kind: 'seed_reward', config: { lowAt: 10, untilFull: false, fullAt: 90 } },
				{ kind: 'seed_reward', config: { lowAt: 1, untilFull: true, fullAt: null } },
				{ kind: 'broadcast', config: {} }
			])
		).toEqual({ lowAt: 10, untilFull: false, fullAt: 90 });
		expect(seedRule([{ kind: 'seed_reward', config: { lowAt: 1, untilFull: true } }])).toEqual({
			lowAt: 1,
			untilFull: true,
			fullAt: null
		});
	});
});

describe('seed replay', () => {
	const M = 60_000;
	const rows = [
		{ ts: 0, ok: true, count: 3, max: 32 },
		{ ts: 10 * M, ok: true, count: 5, max: 32 },
		{ ts: 20 * M, ok: true, count: 25, max: 32 },
		{ ts: 30 * M, ok: false, count: 0, max: 32 },
		{ ts: 40 * M, ok: true, count: 20, max: 32 },
		{ ts: 45 * M, ok: true, count: 32, max: 32 }
	];
	test('lowStretches merges neighbouring low samples and ends the last one at the window end', () => {
		expect(lowStretches(rows, 20, 50 * M)).toEqual([
			{ from: 0, to: 20 * M },
			{ from: 40 * M, to: 45 * M }
		]);
		expect(lowStretches(rows, 4, 50 * M)).toEqual([{ from: 0, to: 10 * M }]);
		expect(lowStretches([], 20, 50 * M)).toEqual([]);
		// a sample holds for at most the cap: the worker was away for the rest of the gap
		expect(lowStretches(rows, 20, 50 * M, 3 * M)).toEqual([
			{ from: 0, to: 3 * M },
			{ from: 10 * M, to: 13 * M },
			{ from: 40 * M, to: 43 * M }
		]);
	});
	test('fullMoments are the samples at or over the fill line, or the server limit without one', () => {
		expect(fullMoments(rows, null)).toEqual([45 * M]);
		expect(fullMoments(rows, 25)).toEqual([20 * M, 45 * M]);
		expect(fullMoments(rows, 40)).toEqual([]);
		// no limit reported: never full on its own
		expect(
			fullMoments(
				rows.map((r) => ({ ...r, max: 0 })),
				null
			)
		).toEqual([]);
		expect(
			fullMoments(
				rows.map((r) => ({ ...r, max: 0 })),
				25
			)
		).toEqual([20 * M, 45 * M]);
	});
	test('seedReplay banks pending low time at a full moment for players still on', () => {
		const stretches = [
			{ from: 0, to: 30 * M },
			{ from: 60 * M, to: 90 * M }
		];
		const fulls = [50 * M];
		const totals = seedReplay(
			stretches,
			fulls,
			[
				// on throughout: 30 min pending, banked when it filled at 50 min; the later stretch
				// never fills, so it stays pending
				{ steamId: 'a', joinedAt: -5 * M, leftAt: null },
				// joined 10 min in, stayed past the fill: 20 min banked; later session never fills
				{ steamId: 'b', joinedAt: 10 * M, leftAt: 55 * M },
				{ steamId: 'b', joinedAt: 80 * M, leftAt: null },
				// only on while the server was busy
				{ steamId: 'c', joinedAt: 30 * M, leftAt: 45 * M },
				// left before it filled: forfeited
				{ steamId: 'd', joinedAt: 0, leftAt: 20 * M }
			],
			25 * 60,
			100 * M
		);
		expect(totals.get('a')).toEqual({ seconds: 1800, crossedAt: 50 * M });
		expect(totals.get('b')).toEqual({ seconds: 1200, crossedAt: null });
		expect(totals.has('c')).toBe(false);
		expect(totals.has('d')).toBe(false);
		// two fills: each banks what was pending since the last
		expect(
			seedReplay(
				stretches,
				[50 * M, 95 * M],
				[{ steamId: 'a', joinedAt: 0, leftAt: null }],
				55 * 60,
				100 * M
			).get('a')
		).toEqual({ seconds: 3600, crossedAt: 95 * M });
	});
	test('seedReplay without the fill requirement credits every low minute as it passes', () => {
		const stretches = [
			{ from: 0, to: 30 * M },
			{ from: 60 * M, to: 90 * M }
		];
		const totals = seedReplay(
			stretches,
			[],
			[
				{ steamId: 'a', joinedAt: -5 * M, leftAt: null },
				{ steamId: 'd', joinedAt: 0, leftAt: 20 * M }
			],
			45 * 60,
			100 * M,
			false
		);
		// 30 min then 30 min; crosses 45 min fifteen minutes into the second stretch
		expect(totals.get('a')).toEqual({ seconds: 3600, crossedAt: 75 * M });
		// left before it filled, but the twenty minutes still count
		expect(totals.get('d')).toEqual({ seconds: 1200, crossedAt: null });
	});
});

describe('broadcastWanted', () => {
	test('a floor alone, a band, and rules saved before the ceiling existed', () => {
		expect(broadcastWanted({ minPlayers: 3, maxPlayers: null }, 2)).toBe(false);
		expect(broadcastWanted({ minPlayers: 3, maxPlayers: null }, 60)).toBe(true);
		expect(broadcastWanted({ minPlayers: 0, maxPlayers: 20 }, 0)).toBe(true);
		expect(broadcastWanted({ minPlayers: 0, maxPlayers: 20 }, 20)).toBe(true);
		expect(broadcastWanted({ minPlayers: 0, maxPlayers: 20 }, 21)).toBe(false);
		expect(broadcastWanted({ minPlayers: 1 } as { minPlayers: number; maxPlayers: null }, 40)).toBe(
			true
		);
	});
});

describe('welcomeTargets', () => {
	const a = { steamId: 'a' };
	const b = { steamId: 'b' };
	const c = { steamId: 'c' };
	const tick = {
		joined: [a],
		factioned: [
			{ player: b, from: null },
			{ player: c, from: 'Valkyra' }
		],
		firstVisit: new Set(['a', 'c'])
	};
	test('whispers joiners by default, and only first faction picks when waiting for one', () => {
		expect(welcomeTargets({ onlyFirstVisit: false, afterFaction: false }, tick)).toEqual([a]);
		expect(welcomeTargets({ onlyFirstVisit: false, afterFaction: true }, tick)).toEqual([b]);
	});
	test('first-visit applies to whichever list is in use', () => {
		expect(welcomeTargets({ onlyFirstVisit: true, afterFaction: false }, tick)).toEqual([a]);
		expect(welcomeTargets({ onlyFirstVisit: true, afterFaction: true }, tick)).toEqual([]);
	});
	test('faction changes are switches only, never the first pick', () => {
		expect(factionChangeTargets(tick).map((f) => f.player)).toEqual([c]);
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
		maxBanAgeDays: 0,
		minAccountDays: 30,
		privateProfiles: false,
		bannedElsewhere: true,
		watchlist: true,
		kickAtLevel: null,
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
		friendsState: 'unknown',
		friendsTotal: 0,
		friendsChecked: 0,
		bannedFriends: 0,
		friendsCheckedAt: null,
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
	test('ban age window ignores older VAC and game bans, while 0 means forever', () => {
		const oldVac = { ...profile, vacBans: 1, daysSinceLastBan: 366 };
		expect(
			riskKickVerdict(
				{ ...cfg, maxBanAgeDays: 365, minAccountDays: 0 },
				{ ...base, profile: oldVac }
			)
		).toBeNull();
		expect(
			riskKickVerdict(
				{ ...cfg, maxBanAgeDays: 366, minAccountDays: 0 },
				{ ...base, profile: oldVac }
			)
		).toBe('1 VAC ban on record');
		expect(
			riskKickVerdict({ ...cfg, maxBanAgeDays: 0, minAccountDays: 0 }, { ...base, profile: oldVac })
		).toBe('1 VAC ban on record');

		const oldGame = { ...profile, gameBans: 2, daysSinceLastBan: 500 };
		expect(
			riskKickVerdict(
				{ ...cfg, vacBans: false, gameBans: true, maxBanAgeDays: 30, minAccountDays: 0 },
				{ ...base, profile: oldGame }
			)
		).toBeNull();
	});
	test('a ban with unknown age is still enforced when an age window is set', () => {
		expect(
			riskKickVerdict(
				{ ...cfg, maxBanAgeDays: 30, minAccountDays: 0 },
				{ ...base, profile: { ...profile, vacBans: 1, daysSinceLastBan: null } }
			)
		).toBe('1 VAC ban on record');
	});
	test('a rule saved before the ban age field existed still considers all bans', () => {
		const legacy = { ...cfg } as Partial<RiskKickConfig>;
		delete legacy.maxBanAgeDays;
		expect(
			riskKickVerdict(legacy as RiskKickConfig, {
				...base,
				profile: { ...profile, vacBans: 1, daysSinceLastBan: 5000 }
			})
		).toBe('1 VAC ban on record');
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
	test('the risk level catches combinations no single rule covers', () => {
		const none: RiskKickConfig = {
			...cfg,
			vacBans: false,
			minAccountDays: 0,
			bannedElsewhere: false,
			watchlist: false
		};
		// an 8-day-old account (20) with a lookalike name (20) is medium, not high
		const lookalike = {
			...base,
			resembles: [{ name: 'Nomad', steamId: '76561198000000009', serverName: 'EU #2' }]
		};
		expect(riskKickVerdict({ ...none, kickAtLevel: 'high' }, lookalike)).toBeNull();
		expect(riskKickVerdict({ ...none, kickAtLevel: 'medium' }, lookalike)).toMatch(
			/^medium risk \(40\): Steam account is 8 days old; Name resembles banned Nomad/
		);
		// a clean, old account is low and passes either setting
		const old = { ...base, profile: { ...profile, accountCreatedAt: new Date('2020-01-01') } };
		expect(riskKickVerdict({ ...none, kickAtLevel: 'medium' }, old)).toBeNull();
		// the checklist still answers first with its own wording
		expect(
			riskKickVerdict(
				{ ...cfg, kickAtLevel: 'high' },
				{ ...base, profile: { ...profile, vacBans: 1 } }
			)
		).toBe('1 VAC ban on record');
	});
	test('recorded games count towards the risk-level rule', () => {
		const levelOnly = {
			...cfg,
			vacBans: false,
			minAccountDays: 0,
			bannedElsewhere: false,
			watchlist: false,
			kickAtLevel: 'medium' as const
		};
		const performance = {
			matches: 30,
			wins: 26,
			losses: 4,
			draws: 0,
			kills: 200,
			deaths: 30,
			feedKills: 100,
			headshots: 70
		};
		const old = { ...base, profile: { ...profile, accountCreatedAt: new Date('2015-01-01') } };
		expect(riskKickVerdict(levelOnly, { ...old, performance })).toStartWith('medium risk (28)');
		expect(riskKickVerdict(levelOnly, old)).toBeNull();
	});
	test('the risk level works from local signals alone and says when Steam was not checked', () => {
		const v = riskKickVerdict(
			{ ...cfg, bannedElsewhere: false, kickAtLevel: 'high' },
			{ ...base, steamEnabled: false, profile: null, bannedOn: [{ serverName: 'x', reason: 'tk' }] }
		);
		expect(v).toBe('high risk (60): Banned on x: tk [Steam not checked]');
		expect(
			riskKickVerdict(
				{ ...cfg, kickAtLevel: 'high' },
				{
					...base,
					steamEnabled: false,
					profile: null,
					watched: null,
					reserved: true,
					bannedOn: [{ serverName: 'x', reason: '' }]
				}
			)
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

describe('restartNoticeStage', () => {
	const H = 3600_000;
	const start = Date.parse('2026-09-14T00:00:00Z');
	const cfg = { leadMinutes: 30, repeatMinutes: 0, minPlayers: 1 };
	const at = (hours: number, players = 10) => ({
		startedAt: start,
		playerCount: players,
		now: start + hours * H
	});

	test('nothing before the heads-up, nothing without a start time or players', () => {
		expect(restartNoticeStage(cfg, null, at(9))).toBeNull();
		expect(restartNoticeStage(cfg, null, { ...at(23.9), startedAt: 0 })).toBeNull();
		expect(restartNoticeStage(cfg, null, at(23.9, 0))).toBeNull();
	});
	test('the heads-up goes once inside the lead window, then the main message once due', () => {
		const lead = restartNoticeStage(cfg, null, at(23.6))!;
		expect(lead.stage).toBe('lead');
		expect(lead.minutes).toBe(24);
		expect(lead.state).toEqual({ startedAt: start, leadAt: start + 23.6 * H });
		expect(restartNoticeStage(cfg, lead.state, at(23.8))).toBeNull();
		const due = restartNoticeStage(cfg, lead.state, at(24.1))!;
		expect(due.stage).toBe('due');
		expect(due.minutes).toBe(0);
		expect(due.state.dueAt).toBe(start + 24.1 * H);
		expect(restartNoticeStage(cfg, due.state, at(25))).toBeNull();
	});
	test('a missed heads-up is skipped, not sent late, once the window is open', () => {
		const hit = restartNoticeStage(cfg, null, at(24.5))!;
		expect(hit.stage).toBe('due');
		expect(hit.state.leadAt).toBeUndefined();
	});
	test('repeat resends the main message on its cadence while the window stays open', () => {
		const c = { ...cfg, repeatMinutes: 15 };
		const first = restartNoticeStage(c, null, at(24))!;
		expect(restartNoticeStage(c, first.state, at(24.2))).toBeNull();
		const again = restartNoticeStage(c, first.state, at(24.3))!;
		expect(again.stage).toBe('due');
		expect(again.state.dueAt).toBe(start + 24.3 * H);
	});
	test('a new game start resets the cycle', () => {
		const old = { startedAt: start - 40 * H, leadAt: 1, dueAt: 2 };
		expect(restartNoticeStage(cfg, old, at(23.7))!.stage).toBe('lead');
	});
	test('no heads-up when leadMinutes is 0', () => {
		expect(restartNoticeStage({ ...cfg, leadMinutes: 0 }, null, at(23.9))).toBeNull();
		expect(restartNoticeStage({ ...cfg, leadMinutes: 0 }, null, at(24))!.stage).toBe('due');
	});
	test('a daily schedule opens the window at its time of day, not 24 hours up', () => {
		// the start is 19:00 the evening before in Chicago, so 07:00 there comes twelve hours later
		const daily = { kind: 'daily', time: '07:00', timeZone: 'America/Chicago' } as const;
		const on = (hours: number) => ({ ...at(hours), schedule: daily });
		const lead = restartNoticeStage(cfg, null, on(11.6))!;
		expect(lead.stage).toBe('lead');
		expect(lead.minutes).toBe(24);
		expect(restartNoticeStage(cfg, lead.state, on(12.1))!.stage).toBe('due');
		// the game's default would still be twelve hours off
		expect(restartNoticeStage(cfg, null, at(12.1))).toBeNull();
	});
	test('no scheduled restart, no notice', () => {
		expect(restartNoticeStage(cfg, null, { ...at(200), schedule: { kind: 'none' } })).toBeNull();
	});
});

describe('team_kill', () => {
	test('validateConfig needs at least one threshold, in order, and fills the texts', () => {
		expect(() => validateConfig('team_kill', {})).toThrow(/threshold/);
		expect(() => validateConfig('team_kill', { warnAt: 3, kickAt: 2 })).toThrow(/below/);
		expect(validateConfig('team_kill', { warnAt: 2, kickAt: 4 })).toEqual({
			warnAt: 2,
			warnMessage: 'Careful, {name}: that was a team kill ({count} this session).',
			kickAt: 4,
			kickReason: 'Team killing ({count} this session).'
		});
		expect(validateConfig('team_kill', { kickAt: 3, kickReason: 'Out.' })).toMatchObject({
			warnAt: 0,
			kickAt: 3,
			kickReason: 'Out.'
		});
	});

	test('teamKillStage: a whisper from warnAt on, a kick from kickAt on', () => {
		const cfg = { warnAt: 2, kickAt: 4 };
		expect(teamKillStage(cfg, 1)).toBeNull();
		expect(teamKillStage(cfg, 2)).toBe('warn');
		expect(teamKillStage(cfg, 3)).toBe('warn');
		expect(teamKillStage(cfg, 4)).toBe('kick');
		expect(teamKillStage(cfg, 9)).toBe('kick');
		expect(teamKillStage({ warnAt: 0, kickAt: 3 }, 2)).toBeNull();
		expect(teamKillStage({ warnAt: 1, kickAt: 0 }, 50)).toBe('warn');
	});
});

describe('matchBoundary', () => {
	const look = (map: string, scores: number[], matchSeconds: number | null = null) => ({
		map,
		scores: ['Lonestar', 'Valkyra', 'Manticore'].map((name, i) => ({
			name,
			score: scores[i] ?? 0
		})),
		matchSeconds
	});
	test('no previous look is never a boundary', () => {
		expect(matchBoundary(null, look('Bakurani', [0, 0, 0]))).toBeNull();
	});
	test('the same match: scores rising or level on the same map', () => {
		expect(matchBoundary(look('Bakurani', [10, 4, 0]), look('Bakurani', [12, 4, 0]))).toBeNull();
		expect(matchBoundary(look('Bakurani', [10, 4, 0]), look('Bakurani', [10, 4, 0]))).toBeNull();
	});
	test('the scores falling back is a round ending on the same map, leader as winner', () => {
		const end = matchBoundary(look('Bakurani', [812, 1000, 640]), look('Bakurani', [0, 0, 0]));
		expect(end).toMatchObject({ map: 'Bakurani', winner: 'Valkyra', leaders: ['Valkyra'] });
		expect(end!.scores.map((f) => f.name)).toEqual(['Valkyra', 'Lonestar', 'Manticore']);
	});
	test('a look that lands a tick into the next round still counts: the total fell', () => {
		expect(
			matchBoundary(look('Bakurani', [812, 1000, 640]), look('Bakurani', [24, 0, 0]))?.winner
		).toBe('Valkyra');
	});
	test('a map change ends the match whatever the scores did', () => {
		expect(matchBoundary(look('Bakurani', [5, 0, 0]), look('Madrid', [9, 0, 0]))?.map).toBe(
			'Bakurani'
		);
	});
	test('the match clock going backwards ends it on builds that send one', () => {
		expect(
			matchBoundary(look('Bakurani', [5, 0, 0], 1800), look('Bakurani', [5, 0, 0], 20))?.map
		).toBe('Bakurani');
		expect(
			matchBoundary(look('Bakurani', [5, 0, 0], 1800), look('Bakurani', [5, 0, 0], 1790))
		).toBeNull();
	});
	test('a tie has leaders but no winner; a match nobody scored in has neither', () => {
		const tie = matchBoundary(look('Bakurani', [7, 7, 1]), look('Bakurani', [0, 0, 0]));
		expect(tie).toMatchObject({ winner: null, leaders: ['Lonestar', 'Valkyra'] });
		const blank = matchBoundary(look('Bakurani', [0, 0, 0]), look('Madrid', [0, 0, 0]));
		expect(blank).toMatchObject({ winner: null, leaders: [] });
	});
});

describe('matchBroadcastMessages', () => {
	const cfg: MatchBroadcastConfig = {
		endMessage: '{faction} won on {previous} with {score} ({scores})',
		startMessage: 'Now on {map} with {players} on',
		minPlayers: 2
	};
	const end = {
		map: 'Bakurani',
		scores: [
			{ name: 'Valkyra', score: 1000 },
			{ name: 'Lonestar', score: 812 },
			{ name: 'Manticore', score: 640 }
		],
		winner: 'Valkyra',
		leaders: ['Valkyra']
	};
	const vars = { server: 'TLR', map: 'Madrid', players: 40, max: 100 };
	test('end message first, then start, with the result filled in', () => {
		expect(matchBroadcastMessages(cfg, end, 40, vars)).toEqual([
			{
				stage: 'end',
				message: 'Valkyra won on Bakurani with 1000 (Valkyra 1000 · Lonestar 812 · Manticore 640)'
			},
			{ stage: 'start', message: 'Now on Madrid with 40 on' }
		]);
	});
	test('a tie names both; nobody scoring drops the end message; a blank message is skipped', () => {
		const tie = { ...end, winner: null, leaders: ['Valkyra', 'Lonestar'] };
		expect(matchBroadcastMessages(cfg, tie, 40, vars)[0].message).toStartWith(
			'Valkyra and Lonestar won'
		);
		const blank = { ...end, winner: null, leaders: [] };
		expect(matchBroadcastMessages(cfg, blank, 40, vars).map((m) => m.stage)).toEqual(['start']);
		expect(
			matchBroadcastMessages({ ...cfg, startMessage: '' }, end, 40, vars).map((m) => m.stage)
		).toEqual(['end']);
	});
	test('nothing under the player floor', () => {
		expect(matchBroadcastMessages(cfg, end, 1, vars)).toEqual([]);
	});
	test("{mvp} and {top} come from the players' lines; a tie names both; nobody killing leaves them empty", () => {
		const c = { ...cfg, endMessage: 'MVP {mvp} · top {top}' };
		const lines = [
			{ name: 'Nomad', kills: 20 },
			{ name: 'Dutchie', kills: 17 },
			{ name: 'Willowisp', kills: 20 },
			{ name: 'Brick', kills: 0 }
		];
		expect(matchBroadcastMessages(c, end, 40, vars, lines)[0].message).toBe(
			'MVP Nomad and Willowisp · top Nomad 20 · Willowisp 20 · Dutchie 17'
		);
		expect(matchBroadcastMessages(c, end, 40, vars, [{ name: 'Brick', kills: 0 }])[0].message).toBe(
			'MVP  · top '
		);
	});
});

describe('matchReplay', () => {
	const row = (ts: number, map: string, scores: number[], ok = true, count = 30) => ({
		ts,
		ok,
		map,
		scores: ['A', 'B'].map((name, i) => ({ name, score: scores[i] ?? 0 })),
		count
	});
	test('finds the resets and map changes, and skips across failures and unwatched gaps', () => {
		const ends = matchReplay(
			[
				row(0, 'Bakurani', [10, 4]),
				row(20, 'Bakurani', [900, 700]),
				row(40, 'Bakurani', [0, 0]), // reset: A won
				row(60, 'Bakurani', [50, 60]),
				row(80, 'Bakurani', [0, 0], false), // failed sample
				row(100, 'Bakurani', [0, 0]), // not compared with 60
				row(120, 'Bakurani', [300, 100]),
				row(400, 'Bakurani', [5, 5]), // gap too long: unwatched
				row(420, 'Madrid', [7, 5]) // map change
			],
			41
		);
		expect(ends.map((e) => [e.ts, e.end.map, e.end.winner])).toEqual([
			[40, 'Bakurani', 'A'],
			[420, 'Bakurani', null]
		]);
		expect(ends[1].end.leaders).toEqual(['A', 'B']);
	});
});
