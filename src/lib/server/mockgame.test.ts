// The demo server's feed sends what the game's does: every event it queues is one the parser
// knows, shaped as a host saw them on Season 2 (feed-core.test.ts).
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { drainMockFeed, mockHandle, MOCK_PASSWORD } from './mockgame';
import { parseBatch } from './feed-core';

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
