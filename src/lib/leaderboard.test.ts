import { describe, expect, test } from 'bun:test';
import {
	boardQueryParams,
	DEFAULT_BOARD_QUERY,
	DEFAULT_FLOOR_MINUTES,
	groupCareer,
	kdRatio,
	matchResult,
	meetsFloor,
	metricValue,
	parseBoardQuery,
	perHour,
	rangeStart,
	streak,
	winRate,
	type BoardRow
} from './leaderboard';

describe('matchResult', () => {
	const scores = [
		{ name: 'Valkyra', score: 100 },
		{ name: 'Lonestar', score: 64 }
	];
	test('win or loss against the winner', () => {
		expect(matchResult('Valkyra', scores, 'Valkyra')).toBe('win');
		expect(matchResult('Valkyra', scores, 'Lonestar')).toBe('loss');
		expect(matchResult('Valkyra', scores, 'Manticore')).toBe('loss');
	});
	test('no winner but a score is a draw', () => {
		expect(
			matchResult(
				null,
				[
					{ name: 'A', score: 50 },
					{ name: 'B', score: 50 }
				],
				'A'
			)
		).toBe('draw');
	});
	test('no winner and no score is no result; so is a player with no faction', () => {
		expect(matchResult(null, null, 'Valkyra')).toBeNull();
		expect(matchResult(null, [], 'Valkyra')).toBeNull();
		expect(matchResult(null, [{ name: 'A', score: 0 }], 'A')).toBeNull();
		expect(matchResult('Valkyra', scores, null)).toBeNull();
		expect(matchResult(null, 'garbage', 'A')).toBeNull();
	});
	test('a player still on the holding team ("White") has no result, win or draw', () => {
		expect(matchResult('Valkyra', scores, 'White')).toBeNull();
		expect(matchResult(null, [{ name: 'A', score: 50 }], 'White')).toBeNull();
	});
});

describe('streak', () => {
	test('counts the newest run of one kind', () => {
		expect(streak(['win', 'win', 'win', 'loss'])).toEqual({ kind: 'win', n: 3 });
		expect(streak(['loss', 'loss', 'win'])).toEqual({ kind: 'loss', n: 2 });
		expect(streak(['win'])).toEqual({ kind: 'win', n: 1 });
	});
	test('skips matches without a result; a draw ends the run', () => {
		expect(streak([null, 'win', null, 'win', 'loss'])).toEqual({ kind: 'win', n: 2 });
		expect(streak(['draw', 'win', 'win'])).toBeNull();
		expect(streak(['win', 'draw', 'win'])).toEqual({ kind: 'win', n: 1 });
		expect(streak([])).toBeNull();
		expect(streak([null, null])).toBeNull();
	});
});

describe('ratios with zero denominators', () => {
	test('K/D is kills alone with no deaths, nothing with neither', () => {
		expect(kdRatio(10, 4)).toBe(2.5);
		expect(kdRatio(7, 0)).toBe(7);
		expect(kdRatio(0, 0)).toBeNull();
		expect(kdRatio(0, 3)).toBe(0);
	});
	test('kills per hour needs playtime', () => {
		expect(perHour(30, 90)).toBe(20);
		expect(perHour(30, 0)).toBeNull();
		expect(perHour(0, 60)).toBe(0);
	});
	test('win rate needs a match with a result', () => {
		expect(winRate(3, 1, 0)).toBe(0.75);
		expect(winRate(1, 1, 2)).toBe(0.25);
		expect(winRate(0, 0, 0)).toBeNull();
	});
});

describe('the playtime floor', () => {
	test('a short visit is under it, an hour is on it', () => {
		expect(meetsFloor(10, DEFAULT_FLOOR_MINUTES)).toBe(false);
		expect(meetsFloor(60, DEFAULT_FLOOR_MINUTES)).toBe(true);
		expect(meetsFloor(0, 0)).toBe(true);
	});
});

describe('board query', () => {
	test('parses what it knows and falls back on the rest', () => {
		expect(parseBoardQuery(new URLSearchParams(''))).toEqual(DEFAULT_BOARD_QUERY);
		expect(
			parseBoardQuery(
				new URLSearchParams('scope=org&range=all&sort=winRate&dir=asc&page=3&minMinutes=120')
			)
		).toEqual({
			scope: 'org',
			range: 'all',
			sort: 'winRate',
			dir: 'asc',
			page: 3,
			minMinutes: 120
		});
		expect(
			parseBoardQuery(new URLSearchParams('scope=x&range=1y&sort=luck&dir=up&page=0&minMinutes=-5'))
		).toEqual({ ...DEFAULT_BOARD_QUERY, page: 1, minMinutes: 0 });
	});
	test('round-trips through its parameters, defaults left out', () => {
		expect(boardQueryParams(DEFAULT_BOARD_QUERY)).toEqual({});
		const q = { ...DEFAULT_BOARD_QUERY, range: 'all' as const, minMinutes: 0, page: 2 };
		expect(boardQueryParams(q)).toEqual({ range: 'all', minMinutes: '0', page: '2' });
		expect(parseBoardQuery(new URLSearchParams(boardQueryParams(q)))).toEqual(q);
	});
	test('ranges start where they say; all time has no start', () => {
		const now = Date.parse('2026-09-17T12:00:00Z');
		expect(rangeStart('7d', now)?.toISOString()).toBe('2026-09-10T12:00:00.000Z');
		expect(rangeStart('all', now)).toBeNull();
	});
});

describe('metricValue', () => {
	const row: BoardRow = {
		rank: 1,
		steamId: '76561198000000001',
		name: 'Nomad',
		minutes: 120,
		seedMinutes: 45,
		kills: 40,
		deaths: 0,
		headshots: 5,
		teamKills: 0,
		suicides: 1,
		matches: 4,
		wins: 2,
		losses: 1,
		draws: 1,
		cash: 900,
		lastSeen: null
	};
	test('reads each column through the same maths', () => {
		expect(metricValue(row, 'kd')).toBe(40);
		expect(metricValue(row, 'perHour')).toBe(20);
		expect(metricValue(row, 'winRate')).toBe(0.5);
		expect(metricValue(row, 'cash')).toBe(900);
		expect(metricValue(row, 'seeded')).toBe(45);
		expect(metricValue({ ...row, minutes: 0 }, 'perHour')).toBeNull();
	});
});

describe('groupCareer', () => {
	test('counts matches by result and adds the combat seen under the same key', () => {
		const groups = groupCareer(
			[
				{ key: 'Kavkazi', result: 'win' },
				{ key: 'Kavkazi', result: 'loss' },
				{ key: 'Europe', result: 'draw' },
				{ key: null, result: 'win' }
			],
			[
				{ key: 'Kavkazi', kills: 12, deaths: 3 },
				{ key: 'Europe', kills: 1, deaths: 9 },
				{ key: null, kills: 5, deaths: 5 }
			]
		);
		expect(groups).toEqual([
			{ key: 'Kavkazi', matches: 2, wins: 1, losses: 1, draws: 0, kills: 12, deaths: 3 },
			{ key: 'Europe', matches: 1, wins: 0, losses: 0, draws: 1, kills: 1, deaths: 9 }
		]);
	});
});
