// The pure part of the feed's match events: which held result a closing look takes, how it
// replaces the look's, and what the relay hands the worker. The database side, and the result
// arriving after its look, are in src/test/match-feed-result.test.ts.
import { describe, expect, test } from 'bun:test';
import { FEED_END_FRESH_MS, matchFeedOf, takeFeedEnd, withFeedEnd } from './match-feed';
import { matchBoundary, resultOf } from './trigger-rules';
import type { ParsedEnd } from './feed-core';

const end: ParsedEnd = {
	eventId: 'e',
	seq: 2,
	eventTime: 1800.5,
	matchId: 'm',
	map: 'Kavkazi',
	players: 98,
	winningFaction: 'Lonestar',
	winner: 'Lonestar',
	scores: [
		{ name: 'Lonestar', score: 100 },
		{ name: 'Manticore', score: 59 },
		{ name: 'Valkyra', score: 0 }
	]
};
const board = [{ name: 'Valkyra' }, { name: 'Lonestar' }, { name: 'Manticore' }];

describe('takeFeedEnd', () => {
	test('a result held recently, for the same factions, is taken once', () => {
		const m = { feedEnd: { end, at: 1_000 } };
		expect(takeFeedEnd(m, board, 1_000 + FEED_END_FRESH_MS)).toBe(end);
		expect(m.feedEnd).toBeNull();
		expect(takeFeedEnd(m, board, 2_000)).toBeNull();
	});
	test('one held too long, or for other factions, is dropped all the same', () => {
		const old = { feedEnd: { end, at: 1_000 } };
		expect(takeFeedEnd(old, board, 1_001 + FEED_END_FRESH_MS)).toBeNull();
		expect(old.feedEnd).toBeNull();
		const other = { feedEnd: { end, at: 1_000 } };
		expect(
			takeFeedEnd(other, [{ name: 'Red' }, { name: 'Blue' }, { name: 'Manticore' }], 1_000)
		).toBeNull();
		expect(takeFeedEnd({ feedEnd: { end, at: 1_000 } }, board.slice(0, 2), 1_000)).toBeNull();
		expect(other.feedEnd).toBeNull();
	});
	test('a board with no factions to compare takes it', () => {
		expect(takeFeedEnd({ feedEnd: { end, at: 1_000 } }, [], 1_000)).toBe(end);
	});
});

describe('withFeedEnd', () => {
	const look = (scores: number[]) => ({
		map: 'Kavkazi',
		scores: board.map((f, i) => ({ name: f.name, score: scores[i] })),
		matchSeconds: null
	});
	// The last look before the end: Valkyra a point ahead.
	const boundary = matchBoundary(look([99, 98, 50]), look([0, 0, 0]))!;

	test("the game's scores and winner in place of the last look's, on the map the look saw", () => {
		expect(boundary.winner).toBe('Valkyra');
		expect(withFeedEnd(boundary, end)).toEqual({
			map: 'Kavkazi',
			scores: end.scores,
			winner: 'Lonestar',
			leaders: ['Lonestar'],
			byFeed: true
		});
		expect(withFeedEnd(boundary, null)).toBe(boundary);
	});

	test('with no winner named, the leader of its scores as for a look; a tie at the top has none', () => {
		expect(withFeedEnd(boundary, { ...end, winner: null }).winner).toBe('Lonestar');
		const tie = withFeedEnd(boundary, {
			...end,
			winner: null,
			scores: [
				{ name: 'Lonestar', score: 70 },
				{ name: 'Valkyra', score: 70 },
				{ name: 'Manticore', score: 3 }
			]
		});
		expect(tie).toMatchObject({ winner: null, leaders: ['Lonestar', 'Valkyra'] });
	});
});

describe('resultOf', () => {
	test("is the looks' rule: nobody scoring has no leaders", () => {
		expect(resultOf('Kavkazi', [{ name: 'A', score: 0 }])).toEqual({
			map: 'Kavkazi',
			scores: [{ name: 'A', score: 0 }],
			winner: null,
			leaders: []
		});
	});
});

describe('matchFeedOf', () => {
	test('keeps what the web relayed in the shapes the worker reads', () => {
		const state = { state: 'MatchState.PostMatch', map: 'Kavkazi', at: '2026-10-15T12:00:00Z' };
		expect(matchFeedOf({ state, end })).toEqual({ state, end });
		expect(matchFeedOf(null)).toEqual({ state: null, end: null });
		expect(matchFeedOf({ state: 'x', end: { ...end, scores: [] } })).toEqual({
			state: null,
			end: null
		});
		expect(matchFeedOf({ end: { ...end, scores: [{ name: 'A', score: 'NaN' }] } }).end).toBeNull();
		expect(matchFeedOf({ end: { ...end, winner: 'Nobody' } }).end?.winner).toBeNull();
	});
});
