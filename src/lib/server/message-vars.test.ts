// What a placeholder says: the server as a look sees it, the player and their all-time stats, here
// and across the organisation, in the leaderboards' own numbers, the rule's own values over the
// general names, and what a dry run cannot know.
import { describe, expect, test } from 'bun:test';
import { MAX_CHAT } from '$lib/chat';
import {
	MESSAGE_RULES,
	ORG_STATS_PLACEHOLDERS,
	PLAYER_PLACEHOLDERS,
	STATS_PLACEHOLDERS
} from '$lib/placeholders';
import {
	dryRunVars,
	keptVars,
	messageVars,
	NO_STATS,
	playerVars,
	serverVars,
	UNKNOWN
} from './message-vars';
import { MAX_REASON, renderTemplate, validateConfig } from './trigger-rules';
import type { TriggerKind } from '$lib/types';

const A = '76561198000000001';
const server = serverVars({
	name: 'Panel name',
	status: {
		serverName: 'Example Clan #1',
		map: 'NorthAmerica',
		playerCount: 41,
		maxPlayers: 100,
		scores: [
			{ name: 'Valkyra', score: 45 },
			{ name: 'Lonestar', score: 30 }
		],
		scoreCap: null
	},
	startedAt: Date.parse('2026-10-02T00:00:00Z'),
	now: Date.parse('2026-10-02T05:30:00Z')
});
const owl = { name: '[ABC] Night Owl', steamId: A, faction: 'Valkyra', ping: 48.6 };
/** this server's line, and the organisation's (this server's and another's) */
const here = {
	kills: 1234,
	deaths: 822,
	minutes: 9012,
	seedMinutes: 95,
	matches: 160,
	wins: 81,
	losses: 70,
	draws: 3
};
const org = {
	kills: 2000,
	deaths: 1000,
	minutes: 18000,
	seedMinutes: 300,
	matches: 300,
	wins: 160,
	losses: 130,
	draws: 10
};
const stats = { here, org };

describe('serverVars', () => {
	test('the map as players know it, the scores, the cap the game defaults to, the uptime', () => {
		expect(server).toEqual({
			server: 'Example Clan #1',
			map: 'Zestafona',
			players: 41,
			max: 100,
			scores: 'Valkyra 45 · Lonestar 30',
			cap: 100,
			uptime: '5h 30m'
		});
	});
	test('before the worker has a status or the game’s start: the panel’s name, no map, uptime unknown', () => {
		expect(serverVars({ name: 'Panel name', status: null, startedAt: 0, now: 1 })).toEqual({
			server: 'Panel name',
			map: '',
			players: 0,
			max: 0,
			scores: '',
			cap: 100,
			uptime: UNKNOWN
		});
	});
});

describe('playerVars', () => {
	test('the player, and their stats as the leaderboards show them, here and across the org', () => {
		expect(playerVars(owl, stats)).toEqual({
			name: '[ABC] Night Owl',
			faction: 'Valkyra',
			steamid: A,
			ping: 49,
			kills: 1234,
			deaths: 822,
			kd: '1.50',
			playtime: '150.2 h',
			matches: 160,
			wins: 81,
			winrate: '53%',
			seeded: '1.6 h',
			org_kills: 2000,
			org_deaths: 1000,
			org_kd: '2.00',
			org_playtime: '300.0 h',
			org_matches: 300,
			org_wins: 160,
			org_winrate: '53%',
			org_seeded: '5.0 h'
		});
	});
	test('a player the server has no record of has nothing yet; deaths alone make a K/D of 0', () => {
		expect(playerVars(owl, { here: NO_STATS })).toMatchObject({
			kills: 0,
			deaths: 0,
			kd: '0.00',
			playtime: '0 min',
			matches: 0,
			wins: 0,
			winrate: '0%',
			seeded: '0 min'
		});
		expect(playerVars(owl, { here: { ...NO_STATS, kills: 7 } }).kd).toBe('7.00');
		expect(playerVars(owl, { org: { ...NO_STATS, deaths: 7 } }).org_kd).toBe('0.00');
	});
	test('stats that were not read, on either side, and a ping the game did not report, are …', () => {
		const v = playerVars({ ...owl, faction: null, ping: null });
		expect(v).toMatchObject({ faction: '', ping: UNKNOWN });
		for (const name of [...STATS_PLACEHOLDERS, ...ORG_STATS_PLACEHOLDERS])
			expect(v[name]).toBe(UNKNOWN);
		const hereOnly = playerVars(owl, { here });
		expect([hereOnly.kills, hereOnly.org_kills]).toEqual([1234, UNKNOWN]);
	});
	test('a message with no player leaves every player and stats placeholder blank', () => {
		const v = playerVars(null);
		expect(Object.keys(v).sort()).toEqual(
			[...PLAYER_PLACEHOLDERS, ...STATS_PLACEHOLDERS, ...ORG_STATS_PLACEHOLDERS].sort()
		);
		expect(Object.values(v).every((x) => x === '')).toBe(true);
	});
});

describe('messageVars', () => {
	test('a welcome as the request wrote it', () => {
		expect(
			renderTemplate(
				'Welcome {player} you have {kills} kills during {playtime} your KDR is {KDR}',
				messageVars(server, owl, stats),
				MAX_CHAT
			)
		).toBe('Welcome [ABC] Night Owl you have 1234 kills during 150.2 h your KDR is 1.50');
	});
	test('the rule’s own values win over the general names, and are filled only by their rule', () => {
		const end = messageVars(server, null, {}, { scores: 'Valkyra 100 · Lonestar 81' });
		expect(end).toMatchObject({ scores: 'Valkyra 100 · Lonestar 81', name: '' });
		expect(messageVars(server, owl, stats, { previous: 'Lonestar' }).previous).toBe('Lonestar');
		// a faction change's {previous} in a welcome is sent as typed, as {victim} always was
		expect(renderTemplate('{previous} {victim}', messageVars(server, owl, stats), MAX_CHAT)).toBe(
			'{previous} {victim}'
		);
	});
	test('the other names follow what they stand for, the rule’s own value included', () => {
		expect(messageVars(server, owl, stats)).toMatchObject({
			player: owl.name,
			kdr: '1.50',
			org_kdr: '2.00'
		});
		expect(messageVars(server, null)).toMatchObject({ player: '', kdr: '', org_kdr: '' });
	});
	test('this server’s stats and the organisation’s side by side', () => {
		expect(
			renderTemplate(
				'{player}: {kills} kills here, {org_kills} on all our servers (K/D {kd}, {ORG_KDR})',
				messageVars(server, owl, stats),
				MAX_CHAT
			)
		).toBe('[ABC] Night Owl: 1234 kills here, 2000 on all our servers (K/D 1.50, 2.00)');
	});
	test('a text kept where staff read it has no org-wide stats: they go as typed', () => {
		const kept = keptVars(messageVars(server, owl, stats));
		expect(
			renderTemplate('{kills} {kd} {org_kills} {org_kd} {org_kdr} {name}', kept, MAX_REASON)
		).toBe('1234 1.50 {org_kills} {org_kd} {org_kdr} [ABC] Night Owl');
	});
	test('a value is filled once: a name that reads like a placeholder stays as it is', () => {
		const v = messageVars(server, { ...owl, name: '{steamid}' }, stats);
		expect(renderTemplate('{name} ({steamid})', v, MAX_CHAT)).toBe(`{steamid} (${A})`);
	});
	test('what every object has is no placeholder', () => {
		const text = '{constructor} {__proto__} {CONSTRUCTOR} {toString} {name}';
		expect(renderTemplate(text, messageVars(server, owl, stats), MAX_CHAT)).toBe(
			'{constructor} {__proto__} {CONSTRUCTOR} {toString} [ABC] Night Owl'
		);
	});
	test('the cut never leaves half a character', () => {
		const long = { name: `${'a'.repeat(199)}😀` };
		expect(renderTemplate('{name}', long, MAX_REASON)).toBe('a'.repeat(199));
		expect(renderTemplate('{name}!', { name: `${'a'.repeat(198)}😀` }, MAX_REASON)).toBe(
			`${'a'.repeat(198)}😀`
		);
	});
});

describe('dryRunVars', () => {
	test('the server and the player by name are known; what the look would have shown is …', () => {
		const v = dryRunVars('Example Clan #1', { name: 'Night Owl', steamId: A });
		expect(v).toMatchObject({
			server: 'Example Clan #1',
			name: 'Night Owl',
			player: 'Night Owl',
			steamid: A,
			faction: UNKNOWN,
			ping: UNKNOWN,
			kills: UNKNOWN,
			kdr: UNKNOWN,
			org_kills: UNKNOWN,
			org_kdr: UNKNOWN,
			map: UNKNOWN,
			uptime: UNKNOWN
		});
	});
	test('what the replay has is filled; without a player, the player’s placeholders are blank', () => {
		expect(dryRunVars('Example Clan #1', null, { map: 'Ozeti', players: 12 })).toMatchObject({
			name: '',
			kills: '',
			org_kills: '',
			map: 'Ozeti',
			players: 12,
			max: UNKNOWN
		});
	});
});

describe('the catalogue and the rules’ settings', () => {
	// One valid setting of each rule that sends a message, with every message field it has.
	const samples: Partial<Record<TriggerKind, Record<string, unknown>>> = {
		welcome: { message: 'a' },
		faction_change: { message: 'a' },
		death_whisper: { messages: ['a'] },
		broadcast: { messages: ['a'], everyMinutes: 5 },
		restart_notice: { message: 'a', leadMinutes: 10, leadMessage: 'b' },
		match_broadcast: { endMessage: 'a', startMessage: 'b' },
		risk_kick: { vacBans: true, reason: 'a' },
		name_filter: { builtinWords: true, reason: 'a' },
		ping_kick: { reason: 'a' },
		team_kill: { warnAt: 1, warnMessage: 'a', kickAt: 2, kickReason: 'b' },
		two_teams: { closedFaction: 'Lonestar', message: 'a' },
		kill_distance: { causes: ['Id.Item.Defibrillator.Standard'], action: 'kick', reason: 'a' },
		seed_reward: { minutes: 30, message: 'a' },
		afk_protection: { message: 'a', doneMessage: 'b' },
		name_change: { action: 'kick', reason: 'a' }
	};
	test('every message field the catalogue names is a text the rule keeps', () => {
		for (const [kind, rule] of Object.entries(MESSAGE_RULES)) {
			const saved = validateConfig(
				kind as TriggerKind,
				samples[kind as TriggerKind]
			) as unknown as Record<string, unknown>;
			for (const field of rule.fields) {
				const v = saved[field];
				expect([kind, field, Array.isArray(v) ? typeof v[0] : typeof v]).toEqual([
					kind,
					field,
					'string'
				]);
			}
		}
	});
});
