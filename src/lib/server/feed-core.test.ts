import { describe, expect, test } from 'bun:test';
import { isTeamKill, parseBatch, parseFeedBearer, parseKill, shortTags } from './feed-core';

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
	test('keeps every event, including unknown types and incomplete kills', () => {
		const started = { type: 'match_started', mapName: 'Kavkazi', extra: { round: 2 } };
		const incomplete = { ...killed, eventId: 'incomplete', victimSteamId: null };
		const b = parseBatch(
			batch([killed, started, incomplete, { ...killed, eventId: 'x' }, 'opaque'])
		);
		expect(b.instanceId).toBe('e9cf2544-b21e-4b80-9f12-8ec95ff58964');
		expect(b.serverName).toBe('[TLR][UK] The Last Rifles');
		expect(b.kills.map((k) => k.eventId)).toEqual([killed.eventId, 'x']);
		expect(b.events).toHaveLength(5);
		expect(b.events[1]).toMatchObject({ eventType: 'match_started', raw: started, kill: null });
		expect(b.events[2]).toMatchObject({ eventType: 'killed', raw: incomplete, kill: null });
		expect(b.events[4]).toMatchObject({ eventType: 'unknown', raw: 'opaque', kill: null });
		expect(b.skipped).toBe(0);
		expect(parseBatch(batch([killed, started])).events[1].eventId).toBe(b.events[1].eventId);
		expect(parseBatch(batch([started, started])).events[0].eventId).not.toBe(
			parseBatch(batch([started, started])).events[1].eventId
		);
	});

	test('refuses what is not a batch, and batches too big to be the game', () => {
		expect(() => parseBatch({ serverId: 'a' })).toThrow();
		expect(() => parseBatch([])).toThrow();
		expect(() => parseBatch(batch(Array.from({ length: 201 }, () => killed)))).toThrow(/Too many/);
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
