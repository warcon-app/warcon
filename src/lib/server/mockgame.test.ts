// The demo server's feed sends what the game's does: every event it queues is one the parser
// knows, shaped as a host saw them on Season 2 (feed-core.test.ts).
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drainMockFeed, mockHandle, MOCK_PASSWORD } from './mockgame';
import { parseBatch } from './feed-core';
import { isMod, takesLighting } from '../format';
import { rotationFromText, rotationIntoText } from '../rotation-doc';
import { S_STATE } from '../config-fields';
import { WELCOME_KEYS, welcomeLinesFromText, welcomeLinesIntoText } from '../welcome-doc';
import { WELCOME_LIMITS, welcomeLimitsOf } from '../welcome-text';

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

// Season 3: the game's own welcome popup, four keys of the config document read at a match's start.
describe("the demo game's welcome popup", () => {
	const json = (key: string, method: string, path: string, body?: string, revision?: string) => {
		const res = mockHandle(
			key,
			method,
			path,
			revision ? { ...auth, 'if-match': `"${revision}"` } : auth,
			body
		);
		return { status: res.status, ...JSON.parse(res.text) };
	};
	const schema = (key: string) =>
		(
			json(key, 'GET', '/v1/config').sections as {
				section: string;
				allowedKeys: string[];
				keyOverrides: { key: string; appliesWhen: string }[];
			}[]
		).find((s) => s.section === S_STATE)!;

	test('its status reports the limits, its schema the four keys, its file a popup', () => {
		const key = randomUUID();
		expect(welcomeLimitsOf(json(key, 'GET', '/v1/status').welcomeMessage)).toEqual(WELCOME_LIMITS);
		const state = schema(key);
		for (const k of WELCOME_KEYS) {
			expect(state.allowedKeys).toContain(k);
			expect(state.keyOverrides).toContainEqual(
				expect.objectContaining({ key: k, appliesWhen: 'next-match' })
			);
		}
		// the fourth line is quoted in the file, for the // in its address
		expect(welcomeLinesFromText(json(key, 'GET', '/v1/config').text)).toEqual([
			'<Header>Welcome to the demo server</>',
			'Be kind, play the objective and have fun.',
			'',
			'<text color="#7FD6FF">https://warcon.example</>'
		]);
	});

	test('a popup within the limits is written, and read back as it went in', () => {
		const key = randomUUID();
		const doc = json(key, 'GET', '/v1/config');
		const lines = [
			'<text size="20" fontface="Bold" color="#FF4D4D">SERVER RULES</>',
			'',
			'Keep chat in <text color="#7FD6FF">English</> | be respectful',
			'x'.repeat(128)
		];
		const put = json(key, 'PUT', '/v1/config', welcomeLinesIntoText(doc.text, lines), doc.revision);
		expect(put.status).toBe(200);
		expect(put.revision).not.toBe(doc.revision);
		expect(welcomeLinesFromText(json(key, 'GET', '/v1/config').text)).toEqual(lines);
	});

	test('a line over a limit, or a tag the popup would not keep, is refused with the line named', () => {
		const key = randomUUID();
		const doc = json(key, 'GET', '/v1/config');
		const bad = welcomeLinesIntoText(doc.text, [
			'fine',
			'x'.repeat(129),
			'<a href="https://x.example">a link</>'
		]);
		for (const [method, path] of [
			['POST', '/v1/config/validate'],
			['PUT', '/v1/config']
		]) {
			const answer = json(key, method, path, bad, doc.revision);
			expect(answer.status).toBe(400);
			expect(answer.ok).toBe(false);
			expect(answer.error.code).toBe('config_invalid');
			expect(answer.errors).toEqual([
				{
					section: S_STATE,
					key: 'ServerWelcomeMessageLines',
					message: 'Line 2 has 129 visible characters, and the popup takes 128.'
				},
				{
					section: S_STATE,
					key: 'ServerWelcomeMessageLines',
					message: 'Line 3: <a> is not a tag the popup takes; only <text> has attributes.'
				}
			]);
		}
		// nothing was written
		const after = json(key, 'GET', '/v1/config');
		expect(after.revision).toBe(doc.revision);
		expect(after.text).toBe(doc.text);
		// what the game takes and shows as typed is not refused
		const typed = welcomeLinesIntoText(doc.text, ['<Bold>No cheating</Bold>']);
		expect(json(key, 'POST', '/v1/config/validate', typed).status).toBe(200);
	});

	test('the build from before Season 3 has none of it', () => {
		const before = process.env.MOCK_LIVE_BUILD;
		process.env.MOCK_LIVE_BUILD = 'true';
		try {
			const key = randomUUID();
			expect(json(key, 'GET', '/v1/status').welcomeMessage).toBeUndefined();
			const state = schema(key);
			for (const k of WELCOME_KEYS) expect(state.allowedKeys).not.toContain(k);
			expect(state.keyOverrides).toEqual([]);
			expect(welcomeLinesFromText(json(key, 'GET', '/v1/config').text)).toBeNull();
		} finally {
			if (before === undefined) delete process.env.MOCK_LIVE_BUILD;
			else process.env.MOCK_LIVE_BUILD = before;
		}
	});
});
