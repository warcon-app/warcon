import { describe, expect, test } from 'bun:test';
import {
	activeEntries,
	isAlreadyApplied,
	isGone,
	parseMaxReservedSlots,
	planSync,
	RESERVED_FULL,
	type PlanInput,
	type StateLike
} from './lists-plan';

const now = new Date('2026-09-09T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('parseMaxReservedSlots', () => {
	test('reads the key inside the WDGameSession section', () => {
		expect(
			parseMaxReservedSlots(
				'[/Script/WDGame.WDGameSession]\nServerName=x\nMaxReservedSlots=8\n\n[/Script/Engine.GameSession]\nMaxPlayers=64\n'
			)
		).toBe(8);
	});
	test('CRLF and spaces around =', () => {
		expect(
			parseMaxReservedSlots('[/Script/WDGame.WDGameSession]\r\nMaxReservedSlots = 12 \r\n')
		).toBe(12);
	});
	test('absent', () => {
		expect(parseMaxReservedSlots('[/Script/WDGame.WDGameSession]\nServerName=x\n')).toBeNull();
		expect(parseMaxReservedSlots('')).toBeNull();
	});
	test('the same key in another section does not count', () => {
		expect(parseMaxReservedSlots('[/Script/Engine.GameSession]\nMaxReservedSlots=8\n')).toBeNull();
	});
});

describe('game error interpretation', () => {
	test('already applied', () => {
		expect(isAlreadyApplied({ status: 409, message: 'x' })).toBe(true);
		expect(isAlreadyApplied({ status: 400, message: 'Player is already banned.' })).toBe(true);
		expect(
			isAlreadyApplied({ status: 400, message: 'steamId must be a 17-digit SteamID64.' })
		).toBe(false);
	});
	test('gone', () => {
		expect(isGone({ status: 404, message: 'x' })).toBe(true);
		expect(isGone({ status: 400, code: 'not_found', message: 'x' })).toBe(true);
		expect(isGone({ status: 400, message: 'nope' })).toBe(false);
	});
});

test('activeEntries drops removed and expired rows', () => {
	const rows = [
		{ id: 'a', removedAt: null, expiresAt: null },
		{ id: 'b', removedAt: now, expiresAt: null },
		{ id: 'c', removedAt: null, expiresAt: ago(1) },
		{ id: 'd', removedAt: null, expiresAt: new Date(now.getTime() + 1) }
	];
	expect(activeEntries(rows, now).map((r) => r.id)).toEqual(['a', 'd']);
});

const state = (p: Partial<StateLike> & Pick<StateLike, 'kind' | 'steamId'>): StateLike => ({
	sourceListId: 'L',
	state: 'applied',
	error: '',
	attemptedAt: null,
	...p
});

const input = (p: Partial<PlanInput> = {}): PlanInput => ({
	now,
	cap: null,
	retryAfterMs: 5 * 60_000,
	desired: { bans: [], reserved: [] },
	observed: { bans: [], reserved: [] },
	state: [],
	...p
});

const ban = (steamId: string, reason = '') => ({ steamId, reason, listId: 'L' });
const slot = (steamId: string, priority = 0, addedAt = now) => ({
	steamId,
	listId: 'L',
	priority,
	addedAt
});

describe('planSync', () => {
	test('wanted and absent → add', () => {
		const p = planSync(input({ desired: { bans: [ban('1', 'cheat')], reserved: [] } }));
		expect(p.adds).toEqual([{ kind: 'ban', steamId: '1', listId: 'L', reason: 'cheat' }]);
		expect(p.removes).toEqual([]);
	});

	test('managed, present, no longer wanted → remove; managed and absent → drop the row', () => {
		const p = planSync(
			input({
				observed: { bans: ['1'], reserved: [] },
				state: [state({ kind: 'ban', steamId: '1' }), state({ kind: 'ban', steamId: '2' })]
			})
		);
		expect(p.removes).toEqual([{ kind: 'ban', steamId: '1' }]);
		expect(p.deletes).toEqual([{ kind: 'ban', steamId: '2' }]);
	});

	test('a coincidental local entry stays local: no add, no state row', () => {
		const p = planSync(
			input({
				desired: { bans: [ban('1')], reserved: [] },
				observed: { bans: ['1'], reserved: [] }
			})
		);
		expect(p.adds).toEqual([]);
		expect(p.confirms).toEqual([]);
		expect(p.local).toEqual([{ kind: 'ban', steamId: '1' }]);
	});

	test('managed and present but recorded as failed → confirm applied', () => {
		const p = planSync(
			input({
				desired: { bans: [ban('1')], reserved: [] },
				observed: { bans: ['1'], reserved: [] },
				state: [state({ kind: 'ban', steamId: '1', state: 'failed', error: 'x' })]
			})
		);
		expect(p.confirms.map((c) => c.steamId)).toEqual(['1']);
		expect(p.adds).toEqual([]);
	});

	test('managed but gone from the server → re-add (someone removed it by hand)', () => {
		const p = planSync(
			input({
				desired: { bans: [ban('1')], reserved: [] },
				state: [state({ kind: 'ban', steamId: '1' })]
			})
		);
		expect(p.adds.map((a) => a.steamId)).toEqual(['1']);
	});

	test('a failed add waits out the backoff, then retries', () => {
		const failed = state({
			kind: 'ban',
			steamId: '1',
			state: 'failed',
			error: 'Bad request',
			attemptedAt: ago(60_000)
		});
		expect(
			planSync(input({ desired: { bans: [ban('1')], reserved: [] }, state: [failed] })).adds
		).toEqual([]);
		expect(
			planSync(
				input({
					desired: { bans: [ban('1')], reserved: [] },
					state: [{ ...failed, attemptedAt: ago(10 * 60_000) }]
				})
			).adds.map((a) => a.steamId)
		).toEqual(['1']);
	});

	test('reserved slots fill by priority then age; the rest overflow', () => {
		const p = planSync(
			input({
				cap: 3,
				desired: {
					bans: [],
					reserved: [
						slot('low', 0, ago(3000)),
						slot('old-high', 5, ago(2000)),
						slot('new-high', 5, ago(1000)),
						slot('mid', 2)
					]
				},
				observed: { bans: [], reserved: ['local'] }
			})
		);
		expect(p.adds.map((a) => a.steamId)).toEqual(['old-high', 'new-high']);
		expect(p.overflow.map((o) => o.steamId)).toEqual(['mid', 'low']);
		expect(p.overflow[0].error.startsWith(RESERVED_FULL)).toBe(true);
		expect(p.reservedUsed).toBe(3);
	});

	test('a slot the panel is removing frees room in the same run', () => {
		const p = planSync(
			input({
				cap: 2,
				desired: { bans: [], reserved: [slot('new')] },
				observed: { bans: [], reserved: ['local', 'stale'] },
				state: [state({ kind: 'reserve', steamId: 'stale' })]
			})
		);
		expect(p.removes).toEqual([{ kind: 'reserve', steamId: 'stale' }]);
		expect(p.adds.map((a) => a.steamId)).toEqual(['new']);
		expect(p.overflow).toEqual([]);
	});

	test('overflow rows are reconsidered every run, not backed off', () => {
		const p = planSync(
			input({
				cap: 5,
				desired: { bans: [], reserved: [slot('1')] },
				state: [
					state({
						kind: 'reserve',
						steamId: '1',
						state: 'failed',
						error: `${RESERVED_FULL} (3/3).`,
						attemptedAt: ago(1000)
					})
				]
			})
		);
		expect(p.adds.map((a) => a.steamId)).toEqual(['1']);
	});

	test('no cap known → everything is added', () => {
		const p = planSync(input({ desired: { bans: [], reserved: [slot('1'), slot('2')] } }));
		expect(p.adds.length).toBe(2);
		expect(p.overflow).toEqual([]);
	});
});
