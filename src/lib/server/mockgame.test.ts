// The demo server's feed sends what the game's does: every event it queues is one the parser
// knows, shaped as a host saw them on Season 2 (feed-core.test.ts).
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drainMockFeed, mockHandle, MOCK_PASSWORD } from './mockgame';
import { parseBatch } from './feed-core';
import { isMod, takesLighting } from '../format';
import { rotationFromText, rotationIntoText } from '../rotation-doc';

const auth = { authorization: `Bearer ${MOCK_PASSWORD}` };
const call = (key: string, method: string, path: string, body?: unknown) =>
	mockHandle(key, method, path, auth, body === undefined ? undefined : JSON.stringify(body));

describe('the demo feed', () => {
	test('a kick is a player_left, a match end its result and states, and none is skipped', () => {
		const key = randomUUID();
		const [p] = JSON.parse(call(key, 'GET', '/v1/players').text).players;
		drainMockFeed(key);
		expect(call(key, 'POST', `/v1/players/${p.steamId}/kick`, { reason: 'test' }).status).toBe(200);
		expect(call(key, 'POST', '/v1/match/end').status).toBe(200);
		call(key, 'GET', '/v1/status');
		const batch = drainMockFeed(key);
		// Read before any matcher touches the events: toMatchObject with expect.any() writes the
		// matcher into the object it was given (bun 1.4.3).
		const parsed = parseBatch(batch);
		const events = (batch?.events ?? []) as Record<string, unknown>[];
		expect(parsed.skipped).toBe(0);
		expect(parsed.other + parsed.kills.length).toBe(events.length);
		const leave = events.find((e) => e.type === 'player_left');
		expect(leave?.playerSteamId).toBe(p.steamId);
		expect(leave?.playerName).toBe(p.name);
		expect(typeof leave?.players).toBe('number');
		const states = events.filter((e) => e.type === 'match_state');
		expect(states.map((e) => e.state)).toEqual([
			'MatchState.PostMatch',
			'MatchState.PreMatch',
			'MatchState.Playing.KOTH'
		]);
		// The result first, on the match that ended; pre-match has no match id; the next is another.
		const [end] = parsed.ends;
		expect(events.findIndex((e) => e.type === 'match_ended')).toBeLessThan(
			events.indexOf(states[0])
		);
		expect(end.scores.map((f) => f.name).sort()).toEqual(['Lonestar', 'Manticore', 'Valkyra']);
		expect(end.winner).toBe(end.scores[0].name);
		expect(end.matchId).toBe(String(states[0].matchId));
		expect(states[1].matchId).toBeUndefined();
		expect(states[2].matchId).not.toBe(end.matchId);
		for (const e of events) {
			expect(typeof e.eventId).toBe('string');
			expect(typeof e.eventTime).toBe('number');
			expect(typeof e.mapName).toBe('string');
		}
	});
});

// Season 3: the map Sabatulo (the game's Russia), its game mode, and the Limited Gear modifier.
describe('the demo game on Season 3', () => {
	const json = (key: string, method: string, path: string, body?: unknown) => {
		const res = call(key, method, path, body);
		return { status: res.status, ...JSON.parse(res.text) };
	};

	test('lists Sabatulo with its game mode, and Limited Gear on every map', () => {
		const key = randomUUID();
		const maps = json(key, 'GET', '/v1/catalog/maps').maps as { id: string; displayName: string }[];
		expect(maps).toContainEqual({ id: 'Russia', displayName: 'Sabatulo' });
		const all = (json(key, 'GET', '/v1/catalog/experiences').experiences as { id: string }[]).map(
			(e) => e.id
		);
		expect(all).toContain('Moscow_KOTH_01');
		expect(all).toContain('KOTH_LimitedGear');
		for (const map of maps) {
			const own = json(key, 'GET', `/v1/catalog/maps/${map.id}/experiences`)
				.experiences as string[];
			// one game mode, named for its place, and the three modifiers
			expect(own.filter((id) => !isMod(id))).toHaveLength(1);
			expect(own.filter(isMod).sort()).toEqual([
				'KOTH_Hardcore',
				'KOTH_InfantryOnly',
				'KOTH_LimitedGear'
			]);
			// each is in the list of them all
			for (const id of own) expect(all).toContain(id);
		}
		expect(json(key, 'GET', '/v1/catalog/maps/Russia/experiences').experiences).toContain(
			'Moscow_KOTH_01'
		);
	});

	test('travels to Sabatulo on a lighting it takes, and refuses one it does not', () => {
		const key = randomUUID();
		const fog = json(key, 'POST', '/v1/match/map', {
			map: 'Russia',
			experiences: ['Moscow_KOTH_01'],
			lighting: 'DayEarlyFog'
		});
		expect(fog.status).toBe(400);
		expect(json(key, 'GET', '/v1/status').map).not.toBe('Russia');
		const rain = json(key, 'POST', '/v1/match/map', {
			map: 'Russia',
			experiences: ['Moscow_KOTH_01', 'KOTH_LimitedGear'],
			lighting: 'DayLateRain'
		});
		expect(rain.status).toBe(200);
		expect(json(key, 'GET', '/v1/status')).toMatchObject({
			map: 'Russia',
			experiences: ['Moscow_KOTH_01', 'KOTH_LimitedGear'],
			lighting: 'DayLateRain'
		});
		// with no lighting asked for, one Sabatulo does not take is not carried over to it
		const other = randomUUID();
		expect(json(other, 'PUT', '/v1/world/lighting', { lighting: 'DayEarlyFog' }).status).toBe(200);
		expect(json(other, 'POST', '/v1/match/map', { map: 'Russia' }).status).toBe(200);
		expect(takesLighting('Russia', json(other, 'GET', '/v1/status').lighting)).toBe(true);
	});

	test('denies a rotation entry it would skip: what it does not list, and a lighting off its map', () => {
		const key = randomUUID();
		const doc = json(key, 'GET', '/v1/config');
		const entry = (map: string, experiences: string[], lighting: string) => ({
			map,
			experiences,
			lighting,
			zoneAlternator: ''
		});
		const entries = [
			entry('Russia', ['Moscow_KOTH_01'], 'DayClear'),
			entry('Russia', ['Moscow_KOTH_01', 'KOTH_LimitedGear'], 'DayLateRain'),
			entry('Europe', ['Madrid_KOTH_01', 'KOTH_InfantryOnly', 'KOTH_LimitedGear'], 'DayEarlyFog'),
			// fog on Sabatulo, the notes' spelling of grey, a map and a modifier nobody lists
			entry('Russia', ['Moscow_KOTH_01'], 'DayEarlyFog'),
			entry('Russia', ['Moscow_KOTH_01'], 'DayLateGrey'),
			entry('Mars', ['Bakurani_KOTH_01'], 'DayClear'),
			entry('Kavkazi', ['Bakurani_KOTH_01', 'KOTH_NightOps'], 'DayClear')
		];
		const text = rotationIntoText(doc.text, { ...rotationFromText(doc.text), entries });
		const put = mockHandle(
			key,
			'PUT',
			'/v1/config',
			{ ...auth, 'if-match': `"${doc.revision}"` },
			text
		);
		expect(put.status).toBe(200);
		const live = json(key, 'GET', '/v1/rotation').entries as { map: string; denied: boolean }[];
		expect(live.map((e) => e.denied)).toEqual([false, false, false, true, true, true, true]);
	});

	test('an entry added through the live route is denied the same way, and never travelled to', () => {
		const key = randomUUID();
		const add = (lighting: string) =>
			json(key, 'POST', '/v1/rotation/entries', {
				map: 'Russia',
				experiences: ['Moscow_KOTH_01'],
				lighting
			});
		expect(add('DayEarlyFog').status).toBe(200);
		expect(add('DayLateRain').status).toBe(200);
		const live = json(key, 'GET', '/v1/rotation').entries as {
			map: string;
			lighting: string;
			denied: boolean;
		}[];
		expect(live.filter((e) => e.map === 'Russia').map((e) => [e.lighting, e.denied])).toEqual([
			['DayEarlyFog', true],
			['DayLateRain', false]
		]);
		// round the whole rotation twice: Sabatulo comes up in rain, never in fog
		const seen: string[] = [];
		for (let i = 0; i < live.length * 2; i++) {
			expect(json(key, 'POST', '/v1/match/end').status).toBe(200);
			const now = json(key, 'GET', '/v1/status');
			if (now.map === 'Russia') seen.push(now.lighting);
		}
		expect(seen.length).toBeGreaterThan(0);
		expect([...new Set(seen)]).toEqual(['DayLateRain']);
	});
});
