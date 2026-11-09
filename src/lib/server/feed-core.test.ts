import { describe, expect, test } from 'bun:test';
import {
	isTeamKill,
	parseBatch,
	parseEnd,
	parseFeedBearer,
	parseKill,
	parseState,
	shortTags
} from './feed-core';

// As captured from build CL-501228 on 2026-09-16 (names and ids changed).
const killed = {
	eventId: 'C7020B4D-8E3D-478A-8063-28AA54EED3B2',
	type: 'killed',
	eventTime: 3317.77734375,
	matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
	mapName: 'Kavkazi',
	killerName: 'Alpha',
	killerId: '-ab0d-3ff278214bfe',
	killerSteamId: '76561198000000001',
	victimName: 'Bravo',
	victimId: '-bd87-743445a0467b',
	victimSteamId: '76561198000000002',
	cause: 'Id.Item.AK74M',
	distance: 704.8741455078125,
	contextTags: [
		'Meta.Progression.Context.Player.KillContext.Headshot',
		'Meta.PlayerKillFlag.Player.Local.Kill',
		'Meta.PlayerKillFlag.Player.Local.Death'
	]
};
// What Season 2 (CL-516586) sends beside kills, as a host posted them on Discord on 2026-10-15
// (ids blanked by them).
const joined = {
	eventId: '<EVENT_UUID>',
	type: 'player_joined',
	eventTime: 3157.0576,
	matchId: '<MATCH_UUID>',
	mapName: 'Kavkazi',
	playerName: 'ExamplePlayer',
	playerId: '-0000-000000000000',
	playerSteamId: '76561190000000000',
	players: 42
};
const left = { ...joined, type: 'player_left', eventTime: 3164.3425, players: 50 };
const state = {
	eventId: '<EVENT_UUID>',
	type: 'match_state',
	eventTime: 3185.7238,
	matchId: '<MATCH_UUID>',
	mapName: 'Kavkazi',
	state: 'MatchState.Playing.KOTH'
};
const ended = {
	eventId: '<EVENT_UUID>',
	type: 'match_ended',
	eventTime: 7658.5545631460845,
	matchId: '<MATCH_UUID>',
	mapName: 'Kavkazi',
	players: 98,
	winningFaction: 'Lonestar',
	factionScores: [
		{ faction: 'Lonestar', score: 100 },
		{ faction: 'Valkyra', score: 0 },
		{ faction: 'Manticore', score: 59 }
	]
};

const batch = (events: unknown[]) => ({
	serverId: 'e9cf2544-b21e-4b80-9f12-8ec95ff58964',
	serverName: '[TLR][UK] The Last Rifles',
	events
});

describe('parseKill', () => {
	test('a player kill: metres, headshot, no noise tags', () => {
		expect(parseKill(killed)).toEqual({
			eventId: 'C7020B4D-8E3D-478A-8063-28AA54EED3B2',
			matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
			eventTime: 3317.77734375,
			map: 'Kavkazi',
			killerSteamId: '76561198000000001',
			killerName: 'Alpha',
			victimSteamId: '76561198000000002',
			victimName: 'Bravo',
			cause: 'Id.Item.AK74M',
			distanceM: 7.05,
			headshot: true,
			suicide: false,
			tags: []
		});
	});

	test('a map given by the name players know is kept under its catalog id', () => {
		const k = parseKill({
			eventId: 'DB88E2F2-D969-41B7-A765-FE83AE15D802',
			type: 'killed',
			eventTime: 1,
			matchId: 'm',
			mapName: 'Zestafona',
			victimName: 'Phantom',
			victimSteamId: '76561198000000003'
		});
		expect(k?.map).toBe('NorthAmerica');
	});

	test('an environment death has no killer, no cause and no distance', () => {
		const k = parseKill({
			eventId: 'DB88E2F2-D969-41B7-A765-FE83AE15D801',
			type: 'killed',
			eventTime: 4158.79,
			matchId: 'm',
			mapName: 'Kavkazi',
			victimName: 'Phantom',
			victimId: '-80e8',
			victimSteamId: '76561198000000003',
			contextTags: ['Meta.PlayerKillFlag.Player.Suicide', 'Meta.PlayerKillFlag.Player.Local.Death']
		});
		expect(k).toMatchObject({
			killerSteamId: null,
			killerName: null,
			cause: null,
			distanceM: null,
			suicide: true,
			tags: []
		});
	});

	test('killing yourself is a suicide even without the tag, and falls keep their context', () => {
		const k = parseKill({
			...killed,
			victimSteamId: killed.killerSteamId,
			contextTags: [
				'Meta.Progression.Context.Player.KillContext.Falling',
				'Meta.PlayerKillFlag.Player.Local.Kill'
			]
		});
		expect(k).toMatchObject({ suicide: true, headshot: false, tags: ['Falling'] });
	});

	test('anything that is not a kill, or lacks a victim, id or clock, is dropped', () => {
		expect(parseKill({ ...killed, type: 'joined' })).toBeNull();
		expect(parseKill({ ...killed, victimSteamId: '12345' })).toBeNull();
		expect(parseKill({ ...killed, eventId: '' })).toBeNull();
		expect(parseKill({ ...killed, eventTime: 'soon' })).toBeNull();
		expect(parseKill('killed')).toBeNull();
		expect(parseKill(null)).toBeNull();
	});

	test('a malformed killer id means an unknown killer, not a refused event', () => {
		expect(parseKill({ ...killed, killerSteamId: 'bot' })).toMatchObject({
			killerSteamId: null,
			killerName: null
		});
	});
});

describe('shortTags', () => {
	test('strips the two prefixes, drops the constant flags, keeps order without repeats', () => {
		expect(
			shortTags([
				'Meta.Progression.Context.Player.KillContext.VehicleExplosion',
				'Meta.PlayerKillFlag.Player.Suicide',
				'Meta.PlayerKillFlag.Player.Local.Kill',
				'Meta.PlayerKillFlag.Player.Local.Death',
				'Meta.Progression.Context.Player.KillContext.VehicleExplosion',
				'Something.Else',
				42
			])
		).toEqual(['VehicleExplosion', 'Suicide', 'Something.Else']);
		expect(shortTags(undefined)).toEqual([]);
	});
});

describe('parseBatch', () => {
	test('keeps the instance id and name, counts what it skipped', () => {
		const b = parseBatch(batch([killed, { type: 'match_started' }, { ...killed, eventId: 'x' }]));
		expect(b.instanceId).toBe('e9cf2544-b21e-4b80-9f12-8ec95ff58964');
		expect(b.serverName).toBe('[TLR][UK] The Last Rifles');
		expect(b.kills.map((k) => k.eventId)).toEqual([killed.eventId, 'x']);
		expect(b.skipped).toBe(1);
	});

	test("Season 2's joins, leaves, match states and ends are known, and none is a kill", () => {
		const b = parseBatch(batch([joined, killed, left, state, ended]));
		expect(b.kills.map((k) => k.eventId)).toEqual([killed.eventId]);
		// each keeps its place in the batch
		expect(b.states).toEqual([parseState(state, 3)!]);
		expect(b.ends).toEqual([parseEnd(ended, 4)!]);
		expect(b.other).toBe(4);
		expect(b.skipped).toBe(0);
		for (const e of [joined, left, state, ended]) expect(parseKill(e)).toBeNull();
	});

	test('a state or result missing what Warcon reads from it is skipped, not counted', () => {
		const b = parseBatch(
			batch([{ ...state, state: 'Playing' }, { ...ended, factionScores: [] }, joined])
		);
		expect(b).toMatchObject({ states: [], ends: [], other: 1, skipped: 2 });
	});

	test('a kill missing what a row needs, or an event of a type not known, is skipped', () => {
		const b = parseBatch(
			batch([{ ...killed, victimSteamId: '' }, { ...state, type: 'match_paused' }, 'joined', null])
		);
		expect(b).toMatchObject({ kills: [], other: 0, skipped: 4 });
	});

	test('refuses what is not a batch, and batches too big to be the game', () => {
		expect(() => parseBatch({ serverId: 'a' })).toThrow();
		expect(() => parseBatch([])).toThrow();
		expect(() => parseBatch(batch(Array.from({ length: 201 }, () => killed)))).toThrow(/Too many/);
	});

	test('only kills count towards the limit: a burst of joins does not cost a batch its kills', () => {
		const joins = Array.from({ length: 300 }, (_, i) => ({ ...joined, eventTime: i }));
		const b = parseBatch(batch([...joins, killed]));
		expect(b.kills).toHaveLength(1);
		expect(b.other).toBe(300);
	});
});

describe('parseState', () => {
	test('every state posted so far, the map as its catalog id', () => {
		for (const name of [
			'MatchState.PreMatch',
			'MatchState.PreMatch.WaitingForWorldLoad',
			'MatchState.PreMatch.WaitingForPlayers',
			'MatchState.PreMatch.WaitingForPlayers.PlayerCount',
			'MatchState.Playing',
			'MatchState.Playing.KOTH',
			'MatchState.PostMatch'
		])
			expect(parseState({ ...state, state: name })).toEqual({
				eventId: '<EVENT_UUID>',
				seq: 0,
				eventTime: 3185.7238,
				matchId: '<MATCH_UUID>',
				map: 'Kavkazi',
				state: name
			});
		expect(parseState({ ...state, mapName: 'Zestafona' })?.map).toBe('NorthAmerica');
	});

	test('pre-match has no match id yet', () => {
		const { matchId: _, ...pre } = { ...state, state: 'MatchState.PreMatch' };
		void _;
		expect(parseState(pre)).toMatchObject({ matchId: '', state: 'MatchState.PreMatch' });
	});

	test("a state that is not one of the game's names is refused", () => {
		for (const bad of ['', 'Playing', 'MatchState.', 'MatchState.Pla ying', 'X'.repeat(300), 42])
			expect(parseState({ ...state, state: bad })).toBeNull();
		expect(parseState({ ...state, eventId: '' })).toBeNull();
		expect(parseState(killed)).toBeNull();
	});
});

describe('parseEnd', () => {
	test('the result as posted: scores highest first, the winner named', () => {
		expect(parseEnd(ended)).toEqual({
			eventId: '<EVENT_UUID>',
			seq: 0,
			eventTime: 7658.5545631460845,
			matchId: '<MATCH_UUID>',
			map: 'Kavkazi',
			players: 98,
			winningFaction: 'Lonestar',
			winner: 'Lonestar',
			scores: [
				{ name: 'Lonestar', score: 100 },
				{ name: 'Manticore', score: 59 },
				{ name: 'Valkyra', score: 0 }
			]
		});
	});

	test('a winner who is not on the scoreboard is no winner, and what was sent is kept', () => {
		expect(parseEnd({ ...ended, winningFaction: '' })?.winner).toBeNull();
		expect(parseEnd({ ...ended, winningFaction: 'None' })).toMatchObject({
			winner: null,
			winningFaction: 'None'
		});
		expect(parseEnd({ ...ended, winningFaction: undefined })?.winner).toBeNull();
	});

	test('without a player count it is still a result', () => {
		expect(parseEnd({ ...ended, players: undefined })?.players).toBeNull();
	});

	test('scores that are not a scoreboard are refused whole', () => {
		const bad = (factionScores: unknown) => parseEnd({ ...ended, factionScores });
		expect(bad(undefined)).toBeNull();
		expect(bad([])).toBeNull();
		expect(bad([{ faction: 'Lonestar', score: 'lots' }])).toBeNull();
		expect(bad([{ faction: '', score: 1 }])).toBeNull();
		expect(
			bad([
				{ faction: 'Lonestar', score: 1 },
				{ faction: 'Lonestar', score: 2 }
			])
		).toBeNull();
		expect(bad([{ faction: 'Lonestar', score: 1 }, null])).toBeNull();
		expect(bad(Array.from({ length: 9 }, (_, i) => ({ faction: `F${i}`, score: i })))).toBeNull();
	});
});

describe('isTeamKill', () => {
	const k = { killerSteamId: '76561198000000001', victimSteamId: '76561198000000002' };
	test('same known faction on both sides', () => {
		expect(isTeamKill(k, 'Valkyra', 'Valkyra')).toBe(true);
		expect(isTeamKill(k, 'Valkyra', 'Ronin')).toBe(false);
		expect(isTeamKill(k, null, null)).toBe(false);
		expect(isTeamKill(k, '', '')).toBe(false);
	});
	test('never a suicide or an environment death', () => {
		expect(isTeamKill({ ...k, victimSteamId: k.killerSteamId }, 'Valkyra', 'Valkyra')).toBe(false);
		expect(isTeamKill({ ...k, killerSteamId: null }, 'Valkyra', 'Valkyra')).toBe(false);
	});
});

describe('parseFeedBearer', () => {
	const token = 'wkf_' + 'a'.repeat(43);
	test('accepts our shape only', () => {
		expect(parseFeedBearer(`Bearer ${token}`)).toBe(token);
		expect(parseFeedBearer(`bearer ${token}`)).toBe(token);
		expect(parseFeedBearer('Bearer wck_' + 'a'.repeat(43))).toBeNull();
		expect(parseFeedBearer('Bearer MYSUPERDUPERSECRETKEY')).toBeNull();
		expect(parseFeedBearer(null)).toBeNull();
	});
});
