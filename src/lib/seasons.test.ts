import { describe, expect, test } from 'bun:test';
import {
	chainSeasons,
	currentSeason,
	isFinished,
	isStarted,
	nextSeason,
	OFFICIAL_SEASONS,
	seasonSpan
} from './seasons';
import { boardQueryParams, DEFAULT_BOARD_QUERY, parseBoardQuery } from './leaderboard';
import { pickable, resolveWindow, type OrgSeasons } from './server/seasons';

const SEP = '2026-09-01T00:00:00.000Z';
const OCT = '2026-10-01T00:00:00.000Z';
const NOV = '2026-11-01T00:00:00.000Z';
const at = (iso: string) => Date.parse(iso);

describe('seasons', () => {
	test('the official list starts with the release and Season 2 at its launch', () => {
		expect(OFFICIAL_SEASONS.slice(0, 2)).toEqual([
			{ key: 'wardogs-1', name: 'Season 1', startsAt: '2026-09-10T00:00:00.000Z' },
			{ key: 'wardogs-2', name: 'Season 2', startsAt: '2026-10-15T16:00:00.000Z' }
		]);
		const chain = chainSeasons('official', OFFICIAL_SEASONS);
		expect(chain[0].endsAt).toBe('2026-10-15T16:00:00.000Z');
	});

	test('each season of a kind runs until the next one starts, in start order', () => {
		const chain = chainSeasons('custom', [
			{ key: 'c', name: 'November', startsAt: NOV },
			{ key: 'a', name: 'September', startsAt: SEP },
			{ key: 'b', name: 'October', startsAt: OCT }
		]);
		expect(chain.map((s) => [s.key, s.startsAt, s.endsAt])).toEqual([
			['a', SEP, OCT],
			['b', OCT, NOV],
			['c', NOV, null]
		]);
		expect(chain.every((s) => s.kind === 'custom')).toBe(true);
		expect(nextSeason(chain, chain[0])?.key).toBe('b');
		expect(nextSeason(chain, chain[2])).toBeNull();
	});

	test('a season starts at its start and is over at the next one’s, to the millisecond', () => {
		const [sep, oct] = chainSeasons('custom', [
			{ key: 'a', name: 'September', startsAt: SEP },
			{ key: 'b', name: 'October', startsAt: OCT }
		]);
		expect(isStarted(sep, at(SEP) - 1)).toBe(false);
		expect(isStarted(sep, at(SEP))).toBe(true);
		expect(isFinished(sep, at(OCT) - 1)).toBe(false);
		expect(isFinished(sep, at(OCT))).toBe(true);
		expect(isFinished(oct, at(NOV) * 2)).toBe(false);
		expect(currentSeason([sep, oct], 'custom', at(SEP) - 1)).toBeNull();
		expect(currentSeason([sep, oct], 'custom', at(OCT) - 1)?.key).toBe('a');
		expect(currentSeason([sep, oct], 'custom', at(OCT))?.key).toBe('b');
		expect(currentSeason([sep, oct], 'official', at(OCT))).toBeNull();
	});

	test('says when a season runs in UTC days', () => {
		const [sep, oct] = chainSeasons('custom', [
			{ key: 'a', name: 'September', startsAt: SEP },
			{ key: 'b', name: 'October', startsAt: OCT }
		]);
		expect(seasonSpan(sep, at(SEP) - 1)).toBe('from 1 Sep 2026');
		expect(seasonSpan(sep, at(SEP) + 1)).toBe('since 1 Sep 2026');
		expect(seasonSpan(sep, at(OCT))).toBe('1 Sep – 1 Oct 2026');
		expect(seasonSpan(sep, at(OCT), true)).toBe('1 Sep – 1 Oct');
		expect(seasonSpan(oct, at(OCT), true)).toBe('since 1 Oct');
		const [dec] = chainSeasons('custom', [
			{ key: 'd', name: 'Winter', startsAt: '2026-12-20T00:00:00.000Z' },
			{ key: 'e', name: 'New year', startsAt: '2027-01-10T00:00:00.000Z' }
		]);
		expect(seasonSpan(dec, at('2027-02-01T00:00:00.000Z'))).toBe('20 Dec 2026 – 10 Jan 2027');
		// the official Season 2 starts mid-day: its UTC day is the 15th
		const s2 = chainSeasons('official', OFFICIAL_SEASONS)[1];
		expect(seasonSpan(s2, at('2026-10-20T00:00:00.000Z'))).toBe('since 15 Oct 2026');
	});
});

describe('a board’s range', () => {
	test('the current season by default; a season by key; nothing else', () => {
		expect(DEFAULT_BOARD_QUERY.range).toBe('current');
		const range = (v: string) => parseBoardQuery(new URLSearchParams({ range: v })).range;
		expect(range('s:wardogs-1')).toBe('s:wardogs-1');
		expect(range('s:Ab3-x')).toBe('s:Ab3-x');
		expect(range('7d')).toBe('7d');
		for (const bad of ['s:', 's:a b', 's:a/b', 's:../x', 'season', `s:${'x'.repeat(65)}`, 'S:x'])
			expect(range(bad)).toBe('current');
		const q = { ...DEFAULT_BOARD_QUERY, range: 's:wardogs-1' as const };
		expect(boardQueryParams(q)).toEqual({ range: 's:wardogs-1' });
		expect(parseBoardQuery(new URLSearchParams(boardQueryParams(q)))).toEqual(q);
		expect(boardQueryParams(DEFAULT_BOARD_QUERY)).toEqual({});
	});
});

describe('Season 3 boards', () => {
	const start = at('2026-11-12T15:00:00.000Z');
	const os: OrgSeasons = {
		seasons: chainSeasons('official', OFFICIAL_SEASONS),
		opens: 'official',
		hidden: []
	};

	test('the default board and picker switch at the scheduled start, never before', () => {
		for (const range of ['current', 's:wardogs-3'] as const) {
			expect(resolveWindow(range, os, start - 1)).toMatchObject({
				range: 's:wardogs-2',
				to: null,
				finished: false
			});
			expect(resolveWindow(range, os, start)).toMatchObject({
				range: 's:wardogs-3',
				from: new Date(start),
				to: null,
				finished: false
			});
		}
		expect(pickable(os, start - 1).map((s) => s.key)).not.toContain('wardogs-3');
		expect(pickable(os, start)[0]?.key).toBe('wardogs-3');
	});

	test('a later update still closes Season 2 and reads Season 3 from the scheduled boundary', () => {
		const later = start + 7 * 86_400_000;
		expect(resolveWindow('s:wardogs-2', os, later)).toMatchObject({
			range: 's:wardogs-2',
			from: new Date('2026-10-15T16:00:00.000Z'),
			to: new Date(start),
			finished: true
		});
		expect(resolveWindow('current', os, later)).toMatchObject({
			range: 's:wardogs-3',
			from: new Date(start),
			to: null,
			finished: false
		});
	});
});

describe('resolveWindow', () => {
	const official = chainSeasons('official', [
		{ key: 'o1', name: 'Season 1', startsAt: '2026-09-10T00:00:00.000Z' },
		{ key: 'o2', name: 'Season 2', startsAt: '2026-10-15T16:00:00.000Z' }
	]);
	const custom = chainSeasons('custom', [
		{ key: 'sep', name: 'September league', startsAt: SEP },
		{ key: 'oct', name: 'October league', startsAt: OCT },
		{ key: 'nov', name: 'November league', startsAt: NOV }
	]);
	const os = (opens: OrgSeasons['opens']): OrgSeasons => ({
		seasons: [...official, ...custom],
		opens,
		hidden: []
	});
	const now = at('2026-10-20T12:00:00.000Z');

	test('a fixed range is itself, to now', () => {
		const w = resolveWindow('30d', os('official'), now);
		expect(w).toMatchObject({ range: '30d', to: null, season: null, finished: false });
		expect(w.from?.getTime()).toBe(now - 30 * 86_400_000);
		expect(resolveWindow('all', os('custom'), now)).toMatchObject({ range: 'all', from: null });
	});

	test('a finished season reads to its end; a live one to now', () => {
		expect(resolveWindow('s:o1', os('official'), now)).toEqual({
			range: 's:o1',
			from: new Date('2026-09-10T00:00:00.000Z'),
			to: new Date('2026-10-15T16:00:00.000Z'),
			season: official[0],
			finished: true
		});
		expect(resolveWindow('s:oct', os('official'), now)).toMatchObject({
			range: 's:oct',
			from: new Date(OCT),
			to: null,
			finished: false
		});
	});

	test('a season unknown or not begun is what the boards open on', () => {
		for (const range of ['s:nov', 's:missing', 'current'] as const)
			expect(resolveWindow(range, os('official'), now).range).toBe('s:o2');
		expect(resolveWindow('current', os('custom'), now).range).toBe('s:oct');
		expect(resolveWindow('current', os('30d'), now).range).toBe('30d');
		expect(resolveWindow('current', os('all'), now)).toMatchObject({ range: 'all', from: null });
	});

	test('their own season when one runs, else the official one, else all time', () => {
		const before = at('2026-08-01T00:00:00.000Z');
		// before any season of theirs: the official one; before that too: all time
		expect(resolveWindow('current', os('custom'), at('2026-09-12T00:00:00.000Z')).range).toBe(
			's:sep'
		);
		expect(resolveWindow('current', os('custom'), before)).toMatchObject({ range: 'all' });
		const theirsLater: OrgSeasons = {
			seasons: [...official, ...chainSeasons('custom', [{ key: 'x', name: 'X', startsAt: NOV }])],
			opens: 'custom',
			hidden: []
		};
		expect(resolveWindow('current', theirsLater, now).range).toBe('s:o2');
		expect(resolveWindow('current', { ...theirsLater, opens: 'official' }, before).range).toBe(
			'all'
		);
	});
});
