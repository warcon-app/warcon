import { describe, expect, test } from 'bun:test';
import {
	activeEntries,
	desiredOf,
	isAlreadyApplied,
	isGone,
	isListOn,
	isUnreachable,
	planSync,
	type DesiredEntry,
	type PlanInput,
	type StateLike
} from './lists-plan';

const now = new Date('2026-09-09T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('game error interpretation', () => {
	test('already applied', () => {
		expect(isAlreadyApplied({ status: 409, message: 'x' })).toBe(true);
		expect(isAlreadyApplied({ status: 400, message: 'Player is already banned.' })).toBe(true);
		expect(
			isAlreadyApplied({ status: 400, message: 'steamId must be a 17-digit SteamID64.' })
		).toBe(false);
	});
	test('a revision conflict is not "already applied"', () => {
		expect(isAlreadyApplied({ status: 412, code: 'revision_conflict', message: 'changed' })).toBe(
			false
		);
		expect(
			isAlreadyApplied({
				status: 409,
				code: 'already_reserved',
				message: 'SteamId 1 is already reserved.'
			})
		).toBe(true);
	});
	test('gone', () => {
		expect(isGone({ status: 404, message: 'x' })).toBe(true);
		expect(isGone({ status: 404, code: 'reserved_not_found', message: 'x' })).toBe(true);
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
	retryAfterMs: 5 * 60_000,
	desired: { bans: [], reserved: [] },
	observed: { reserved: [] },
	state: [],
	...p
});

const ban = (steamId: string, reason = '') => ({ steamId, reason, listId: 'L' });
const slot = (steamId: string, member = false) => ({ steamId, listId: 'L', member, priority: 1 });

describe('planSync', () => {
	const want = (...ids: string[]) => ({ bans: [], reserved: ids.map((id) => slot(id)) });

	test('wanted and absent → add', () => {
		const p = planSync(input({ desired: want('1') }));
		expect(p.adds).toEqual([
			{ kind: 'reserve', steamId: '1', listId: 'L', reason: '', priority: 1 }
		]);
		expect(p.removes).toEqual([]);
	});

	test("bans are never planned: the panel enforces them and leaves the game's list alone", () => {
		const p = planSync(
			input({
				desired: { bans: [ban('1', 'cheat')], reserved: [] },
				state: [state({ kind: 'ban', steamId: '2' })]
			})
		);
		expect(p).toEqual({ adds: [], removes: [], confirms: [], deletes: [], local: [] });
	});

	test('managed, present, no longer wanted → remove; managed and absent → drop the row', () => {
		const p = planSync(
			input({
				observed: { reserved: ['1'] },
				state: [state({ kind: 'reserve', steamId: '1' }), state({ kind: 'reserve', steamId: '2' })]
			})
		);
		expect(p.removes).toEqual([{ kind: 'reserve', steamId: '1' }]);
		expect(p.deletes).toEqual([{ kind: 'reserve', steamId: '2' }]);
	});

	test('a coincidental local entry stays local: no add, no state row', () => {
		const p = planSync(input({ desired: want('1'), observed: { reserved: ['1'] } }));
		expect(p.adds).toEqual([]);
		expect(p.confirms).toEqual([]);
		expect(p.local).toEqual([{ kind: 'reserve', steamId: '1' }]);
	});

	test('managed and present but recorded as failed → confirm applied', () => {
		const p = planSync(
			input({
				desired: want('1'),
				observed: { reserved: ['1'] },
				state: [state({ kind: 'reserve', steamId: '1', state: 'failed', error: 'x' })]
			})
		);
		expect(p.confirms.map((c) => c.steamId)).toEqual(['1']);
		expect(p.adds).toEqual([]);
	});

	test('managed but gone from the server → re-add (someone removed it by hand)', () => {
		const p = planSync(
			input({ desired: want('1'), state: [state({ kind: 'reserve', steamId: '1' })] })
		);
		expect(p.adds.map((a) => a.steamId)).toEqual(['1']);
	});

	test('a failed add waits out the backoff, then retries', () => {
		const failed = (attemptedAt: Date) =>
			state({ kind: 'reserve', steamId: '1', state: 'failed', error: 'Bad request', attemptedAt });
		expect(planSync(input({ desired: want('1'), state: [failed(ago(60_000))] })).adds).toEqual([]);
		expect(
			planSync(input({ desired: want('1'), state: [failed(ago(6 * 60_000))] })).adds.map(
				(a) => a.steamId
			)
		).toEqual(['1']);
	});

	test('every wanted reserved slot is added: the list has no cap, members included', () => {
		const p = planSync(
			input({
				desired: {
					bans: [],
					reserved: [slot('a'), slot('b'), slot('c'), slot('member', true)]
				},
				observed: { reserved: ['local', 'b'] }
			})
		);
		expect(p.adds.map((a) => a.steamId)).toEqual(['a', 'c', 'member']);
		expect(p.local).toEqual([{ kind: 'reserve', steamId: 'b' }]);
	});

	test('a managed reserved slot no longer wanted is removed; a local one is left alone', () => {
		const p = planSync(
			input({
				desired: { bans: [], reserved: [slot('new')] },
				observed: { reserved: ['local', 'stale'] },
				state: [state({ kind: 'reserve', steamId: 'stale' })]
			})
		);
		expect(p.removes).toEqual([{ kind: 'reserve', steamId: 'stale' }]);
		expect(p.adds.map((a) => a.steamId)).toEqual(['new']);
	});
});

test('isGone: a missing entry is gone, a missing route is not', () => {
	expect(isGone({ status: 404, code: 'ban_not_found', message: 'not banned' })).toBe(true);
	expect(isGone({ status: 404, code: 'not_found', message: 'gone' })).toBe(true);
	expect(isGone({ status: 404, code: 'no_route', message: 'not served' })).toBe(false);
});

test('isUnreachable: outages and rate limiting both stop the run; ordinary refusals do not', () => {
	expect(isUnreachable({ status: 502, code: 'unreachable', message: 'x' })).toBe(true);
	expect(isUnreachable({ status: 429, code: 'rate_limited', message: 'slow down' })).toBe(true);
	expect(isUnreachable({ status: 409, code: 'already_reserved', message: 'already' })).toBe(false);
	expect(isUnreachable({ status: 400, message: 'bad id' })).toBe(false);
});

describe('desiredOf', () => {
	test("a player on the org list and the server's own list is wanted once, from the org list", () => {
		const want = desiredOf([
			entry('1', 'srv', { serverId: 's1', reason: 'donor here' }),
			entry('1', 'org', { isDefault: true, reason: 'donor' }),
			entry('2', 'srv', { serverId: 's1' }),
			{ ...entry('3', 'bans', { isDefault: true, reason: 'cheating' }), kind: 'ban' }
		]);
		// attributed to the org list, and as pressing as the server's own entry
		expect(want.reserved).toEqual([
			{ steamId: '1', listId: 'org', member: false, priority: 0 },
			{ steamId: '2', listId: 'srv', member: false, priority: 0 }
		]);
		expect(want.bans).toEqual([{ steamId: '3', reason: 'cheating', listId: 'bans' }]);
	});

	test('a player in groups is attributed to the default list, else the first group by name', () => {
		const want = desiredOf([
			entry('1', 'g-zulu', { listName: 'Zulu' }),
			entry('1', 'g-alpha', { listName: 'Alpha' }),
			entry('2', 'g-zulu', { listName: 'Zulu' }),
			entry('2', 'org', { isDefault: true }),
			entry('3', 'srv', { serverId: 's1' }),
			entry('3', 'g-zulu', { listName: 'Zulu' })
		]);
		expect(want.reserved).toEqual([
			{ steamId: '2', listId: 'org', member: false, priority: 1 },
			{ steamId: '1', listId: 'g-alpha', member: false, priority: 2 },
			{ steamId: '3', listId: 'g-zulu', member: false, priority: 0 }
		]);
	});
});

const entry = (
	steamId: string,
	listId: string,
	p: Partial<Pick<DesiredEntry, 'serverId' | 'isDefault' | 'listName' | 'reason'>> = {}
): DesiredEntry => ({
	kind: 'reserve',
	steamId,
	reason: '',
	listId,
	serverId: null,
	isDefault: false,
	listName: p.isDefault ? 'Default' : p.serverId ? 'Server' : 'Group',
	...p
});

describe('isListOn', () => {
	const off = { archivedAt: null, onFrom: null, onUntil: null };
	test('a list with no window is on, an archived one never', () => {
		expect(isListOn(off, now)).toBe(true);
		expect(isListOn({ ...off, archivedAt: ago(1) }, now)).toBe(false);
	});
	test('a window holds from its start, up to and not at its end', () => {
		expect(isListOn({ ...off, onFrom: now }, now)).toBe(true);
		expect(isListOn({ ...off, onFrom: new Date(now.getTime() + 1) }, now)).toBe(false);
		expect(isListOn({ ...off, onUntil: now }, now)).toBe(false);
		expect(isListOn({ ...off, onUntil: new Date(now.getTime() + 1) }, now)).toBe(true);
		expect(isListOn({ ...off, onFrom: ago(10), onUntil: ago(5) }, now)).toBe(false);
	});
});
