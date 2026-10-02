import { afterEach, describe, expect, test } from 'bun:test';
import {
	evaluateTriggers,
	forgetRuleMemory,
	noteStaffMove,
	twoTeamsMoveVerdict,
	type TickContext
} from './triggers';
import type { TriggerRow } from './db/schema';
import { validateTwoTeams } from './two-teams';
import type { Env } from './env';
import type { Player } from '$lib/types';

const player = (steamId: string, faction: string | null): Player => ({
	name: `P${steamId}`,
	steamId,
	faction,
	kills: 0,
	deaths: 0,
	cash: 0,
	ping: null
});
const row = (config: Record<string, unknown>) =>
	({
		id: 'two-teams-rule',
		kind: 'two_teams',
		name: 'Two teams',
		config: validateTwoTeams(config),
		state: null
	}) as unknown as TriggerRow;
const tick = (players: Player[], at: number, playersIntervalMs = 1000) =>
	({
		server: { id: 'srv', name: 'Server' },
		status: {
			serverName: 'Server',
			map: 'Map',
			playerCount: players.length,
			maxPlayers: 100,
			scores: ['Lonestar', 'Valkyra', 'Manticore'].map((name) => ({ name, colorHex: '', score: 0 }))
		},
		players,
		playersObserved: true,
		playersIntervalMs,
		ts: new Date(at)
	}) as unknown as TickContext;
const CLOSED = { closedFaction: 'Lonestar', message: '' };
const everyone = Array.from({ length: 10 }, (_, i) => player(String(i), 'Lonestar'));
const moved = (ev: Awaited<ReturnType<typeof evaluateTriggers>>) =>
	ev.intents.filter((i) => i.action === 'changeTeam').map((i) => i.target);
/** One look whose moves are written, as the worker's observation commits them. */
const look = async (rule: TriggerRow, ctx: TickContext) => {
	const ev = await evaluateTriggers({} as Env, ctx, [rule]);
	for (const f of ev.afterCommit ?? []) f();
	return ev;
};

afterEach(() => forgetRuleMemory());

describe('the Team balance rule', () => {
	test('keeps its state in the worker, never on the row, and paces its moves by the cadence', async () => {
		const rule = row(CLOSED);
		const a = await look(rule, tick(everyone, 0));
		expect(moved(a)).toEqual(['0', '1', '2']);
		expect(a.updates).toEqual([
			{ id: rule.id, lastFiredAt: new Date(0), lastResult: 'Moving 3 players' }
		]);
		expect(rule.state).toBeNull();
		// the three asked are in flight, so the next look asks for the next three
		const b = await look(rule, tick(everyone, 1000));
		expect(moved(b)).toEqual(['3', '4', '5']);
		// a slower cadence asks for more at once
		forgetRuleMemory();
		const slow = await look(rule, tick(everyone, 0, 2000));
		expect(moved(slow)).toHaveLength(6);
		// the first look with players back after a map load comes at the idle cadence
		forgetRuleMemory();
		const idle = await look(rule, tick(everyone, 0, 30_000));
		expect(moved(idle)).toHaveLength(6);
	});

	test('a look whose write fails is decided again at the next one', async () => {
		const rule = row(CLOSED);
		const failed = await evaluateTriggers({} as Env, tick(everyone, 0), [rule]);
		expect(moved(failed)).toEqual(['0', '1', '2']);
		// the observation's transaction rolled back: its afterCommit never ran
		const again = await look(rule, tick(everyone, 1000));
		expect(moved(again)).toEqual(['0', '1', '2']);
		expect(moved(await look(rule, tick(everyone, 2000)))).toEqual(['3', '4', '5']);
	});

	test('a change to its settings starts it over; a new name does not', async () => {
		const a = await look(row(CLOSED), tick(everyone, 0));
		expect(moved(a)).toEqual(['0', '1', '2']);
		const renamed = { ...row(CLOSED), name: 'Renamed' } as TriggerRow;
		expect(moved(await look(renamed, tick(everyone, 1000)))).toEqual(['3', '4', '5']);
		const edited = row({ ...CLOSED, message: 'You are on {team}.' });
		expect(moved(await look(edited, tick(everyone, 2000)))).toEqual(['0', '1', '2']);
	});

	test('never leaves a player on the closed faction: after three asks it moves them once a minute', async () => {
		const rule = row(CLOSED);
		const results: string[] = [];
		const asked: number[] = [];
		for (let n = 0; n < 40; n++) {
			const faction = n % 2 === 0 ? 'Lonestar' : 'Valkyra';
			const ev = await look(rule, tick([player('7', faction)], n * 2000));
			if (moved(ev).length) asked.push(n * 2000);
			results.push(...ev.updates.map((u) => u.lastResult ?? ''));
		}
		expect(asked).toEqual([0, 4000, 8000, 68_000]);
		expect(results.filter((r) => /left/i.test(r))).toEqual([]);
	});

	/** eight on Valkyra and five on Manticore, with one of Manticore's on `faction` */
	const switcher = (faction: string) => [
		...Array.from({ length: 8 }, (_, i) => player(`v${i}`, 'Valkyra')),
		...Array.from({ length: 5 }, (_, i) => player(`m${i}`, i === 0 ? faction : 'Manticore'))
	];
	const BALANCED = { closedFaction: 'Lonestar', message: '', balance: true, gap: 3 };

	test('says once that it has left a player who keeps switching onto the bigger side', async () => {
		const rule = row(BALANCED);
		await look(rule, tick(switcher('Manticore'), 0));
		const results: string[] = [];
		for (let n = 1; n <= 12; n++) {
			const faction = n % 2 === 1 ? 'Valkyra' : 'Manticore';
			const ev = await look(rule, tick(switcher(faction), n * 2000));
			results.push(...ev.updates.map((u) => u.lastResult ?? ''));
		}
		expect(results.filter((r) => r.startsWith('Moving'))).toHaveLength(3);
		expect(results.filter((r) => r.startsWith('Left'))).toEqual([
			'Left Pm0 on Valkyra: asked to move 3 times in 10 min'
		]);
	});

	test('says so even on a look that also moves other players', async () => {
		const rule = row(BALANCED);
		await look(rule, tick(switcher('Manticore'), 0));
		const results: string[] = [];
		// Pm0 keeps switching while newcomers keep arriving on the closed faction
		for (let n = 1; n <= 8; n++) {
			const players = [
				...switcher(n % 2 === 1 ? 'Valkyra' : 'Manticore'),
				player(String(100 + n), 'Lonestar')
			];
			const ev = await look(rule, tick(players, n * 2000));
			results.push(...ev.updates.map((u) => u.lastResult ?? ''));
		}
		expect(results.filter((r) => r.includes('left Pm0'))).toEqual([
			'Moving P107; left Pm0 on Valkyra: asked to move 3 times in 10 min'
		]);
	});
	describe('balancing', () => {
		const V = 'Valkyra';
		const M = 'Manticore';
		const BAL = { closedFaction: 'Lonestar', message: '', balance: true, gap: 3 };
		const sides = (v: number, m: number) => [
			...Array.from({ length: v }, (_, i) => player(`v${i}`, V)),
			...Array.from({ length: m }, (_, i) => player(`m${i}`, M))
		];
		const at = (players: Player[], ms: number, extra: Partial<TickContext> = {}) =>
			({ ...tick(players, ms), ...extra }) as TickContext;
		const changes = (ev: Awaited<ReturnType<typeof evaluateTriggers>>) =>
			ev.intents
				.filter((i) => i.action === 'changeTeam')
				.map((i) => [i.target, i.params.faction, i.okMessage]);

		test('a match end seen on a look without a player list is acted on at the next one with one', async () => {
			const rule = row(BAL);
			const lopsided = sides(12, 4);
			expect(moved(await look(rule, at(lopsided, 0)))).toEqual([]);
			// the status look that saw the new map had no fresh list
			await look(
				rule,
				at(lopsided, 1000, { playersObserved: false, matchEnd: {} as TickContext['matchEnd'] })
			);
			const first = moved(await look(rule, at(lopsided, 2000)));
			expect(first).toHaveLength(3);
			expect(first.every((id) => id.startsWith('v'))).toBe(true);
			// 9 v 7 once they land: within the gap, so nobody else moves
			const landed = lopsided.map((p) => (first.includes(p.steamId) ? { ...p, faction: M } : p));
			expect(moved(await look(rule, at(landed, 3000)))).toEqual([]);
			// and the match end is used once: two leaving later moves nobody already placed (9 v 5)
			const fewer = landed.filter((p) => !['m0', 'm1'].includes(p.steamId));
			expect(moved(await look(rule, at(fewer, 4000)))).toEqual([]);
		});

		test('a match end waits for a look with two open sides to act on', async () => {
			const rule = row(BAL);
			const lopsided = sides(12, 4);
			await look(rule, at(lopsided, 0));
			const noScores = {
				...tick(lopsided, 1000).status,
				scores: []
			} as unknown as TickContext['status'];
			const end = await look(
				rule,
				at(lopsided, 1000, { matchEnd: {} as TickContext['matchEnd'], status: noScores })
			);
			expect(moved(end)).toEqual([]);
			expect(moved(await look(rule, at(lopsided, 2000)))).toHaveLength(3);
		});

		test('after two minutes without a player list it starts over: switched off and on, or out of reach', async () => {
			const rule = row(BAL);
			await look(rule, at(sides(7, 5), 0));
			const stacked = sides(7, 5).map((p) => (p.steamId === 'm0' ? { ...p, faction: V } : p));
			// within the window a switch is still put back
			expect(moved(await look(rule, at(stacked, 60_000)))).toEqual(['m0']);
			forgetRuleMemory();
			await look(rule, at(sides(7, 5), 0));
			// no look for over two minutes (the rule was off, or the server unreachable): whoever is on
			// now is taken as placed, as when the rule is first switched on
			expect(moved(await look(rule, at(stacked, 2 * 60_000 + 1001)))).toEqual([]);
			// a look without a list does not count as seeing it
			forgetRuleMemory();
			await look(rule, at(sides(7, 5), 0));
			await look(rule, at(sides(7, 5), 90_000, { playersObserved: false }));
			expect(moved(await look(rule, at(stacked, 2 * 60_000 + 1001)))).toEqual([]);
		});

		test('a move goes out only while the rule still holds the decision it was queued under', async () => {
			const rule = row(BAL);
			await look(rule, at(sides(8, 5), 0));
			const arrived = [...sides(8, 5), player('new', V)];
			/** the row a look queued for `new`, as delivery sees it */
			const rowOf = (ev: Awaited<ReturnType<typeof evaluateTriggers>>) => ({
				triggerId: rule.id,
				serverId: 'srv',
				steamId: 'new',
				params: ev.intents.find((i) => i.action === 'changeTeam')!.params
			});
			// decided, its look not yet written: the row waits, even if the clock stepped back
			const pending = await evaluateTriggers({} as Env, at(arrived, -5000), [rule]);
			const queued = rowOf(pending);
			expect(twoTeamsMoveVerdict(queued)).toBe('wait');
			for (const f of pending.afterCommit ?? []) f();
			expect(twoTeamsMoveVerdict(queued)).toBe('send');
			// a person moves them meanwhile
			noteStaffMove('srv', 'new', M, Date.now() + 1);
			expect(twoTeamsMoveVerdict({ ...queued, params: { ...queued.params, at: Date.now() } })).toBe(
				'Moved by hand since.'
			);
			forgetRuleMemory();
			// decided again 30 s on (not seen landed): the first row is no longer wanted
			await look(rule, at(sides(8, 5), 0));
			const first = rowOf(await look(rule, at(arrived, 1000)));
			const retry = rowOf(await look(rule, at(arrived, 31_000)));
			expect([twoTeamsMoveVerdict(first), twoTeamsMoveVerdict(retry)]).toEqual([
				'No longer wanted by the rule.',
				'send'
			]);
			// a match end seen on a status look, before any player list: dropped at once
			await look(
				rule,
				at(arrived, 32_000, { playersObserved: false, matchEnd: {} as TickContext['matchEnd'] })
			);
			expect(twoTeamsMoveVerdict(retry)).toBe('A new match began.');
			// after a restart nothing is known until the rule has looked: wait, then drop
			const before = rowOf(await look(rule, at(arrived, 62_000)));
			forgetRuleMemory();
			expect(twoTeamsMoveVerdict(before)).toBe('wait');
			await look(rule, at(arrived, 63_000));
			expect(twoTeamsMoveVerdict(before)).toBe('No longer wanted by the rule.');
			// rows queued before moves carried their look go as before
			expect(twoTeamsMoveVerdict({ ...before, params: { ...before.params, mem: undefined } })).toBe(
				'send'
			);
		});

		test('a move is queued under its look, so a clock that repeats a time never hides one', async () => {
			const rule = row(CLOSED);
			const a = await look(rule, at([player('b', 'Lonestar')], 1000));
			await look(
				rule,
				at([player('b', 'Lonestar')], 2000, {
					playersObserved: false,
					matchEnd: {} as TickContext['matchEnd']
				})
			);
			// the clock is back at 1000 for the next look, which decides the move again
			const c = await look(rule, at([player('b', 'Lonestar')], 1000));
			expect(c.intents).toHaveLength(1);
			expect(c.intents[0].dedupeKey).not.toBe(a.intents[0].dedupeKey);
		});

		test('a closing-only rule drops its queued moves at a match end too', async () => {
			const old = {
				...row(CLOSED),
				config: { closedFaction: 'Lonestar', names: {}, message: '' }
			} as unknown as TriggerRow;
			const ev = await look(old, at([player('b', 'Lonestar')], 0));
			const queued = {
				triggerId: old.id,
				serverId: 'srv',
				steamId: 'b',
				params: ev.intents[0].params
			};
			expect(twoTeamsMoveVerdict(queued)).toBe('send');
			await look(
				old,
				at([player('b', 'Lonestar')], 1000, {
					playersObserved: false,
					matchEnd: {} as TickContext['matchEnd']
				})
			);
			expect(twoTeamsMoveVerdict(queued)).toBe('A new match began.');
			// and decides afresh at the next list
			expect(moved(await look(old, at([player('b', 'Lonestar')], 2000)))).toEqual(['b']);
		});

		test('switched on again, or back after the server was out of reach, it starts over', async () => {
			const stacked = sides(7, 5).map((p) => (p.steamId === 'm0' ? { ...p, faction: V } : p));
			const rule = row(BAL);
			await look(rule, at(sides(7, 5), 0));
			// switched off and on within a minute: the route writes a new marker
			const again = { ...rule, state: { enabledAt: 1 } } as TriggerRow;
			expect(moved(await look(again, at(stacked, 60_000)))).toEqual([]);
			forgetRuleMemory();
			await look(rule, at(sides(7, 5), 0));
			// the first look after the server was out of reach
			expect(moved(await look(rule, at(stacked, 30_000, { recovered: true })))).toEqual([]);
			// neither: the switch is put back
			forgetRuleMemory();
			await look(rule, at(sides(7, 5), 0));
			expect(moved(await look(rule, at(stacked, 30_000)))).toEqual(['m0']);
		});

		test('the window without a list scales with a slow player list cadence', async () => {
			const stacked = sides(7, 5).map((p) => (p.steamId === 'm0' ? { ...p, faction: V } : p));
			const rule = row(BAL);
			await look(rule, at(sides(7, 5), 0, { playersIntervalMs: 120_000 }));
			// one look every two minutes is the cadence, not an outage
			expect(moved(await look(rule, at(stacked, 130_000, { playersIntervalMs: 120_000 })))).toEqual(
				['m0']
			);
		});

		test('a player put back is told so in the trail', async () => {
			const rule = row(BAL);
			await look(rule, at(sides(7, 5), 0));
			const stacked = sides(7, 5).map((p) => (p.steamId === 'm0' ? { ...p, faction: V } : p));
			const ev = await look(rule, at(stacked, 1000));
			expect(changes(ev)).toEqual([['m0', M, 'Moved Pm0 back to Manticore.']]);
			expect(ev.intents[0].detail).toEqual({ name: 'Pm0', from: V, to: M, why: 'back' });
		});

		test('a move a person made from the panel is not undone', async () => {
			const rule = row(BAL);
			await look(rule, at(sides(7, 5), 0));
			noteStaffMove('srv', 'm0', V, 500);
			const stacked = sides(7, 5).map((p) => (p.steamId === 'm0' ? { ...p, faction: V } : p));
			expect(moved(await look(rule, at(stacked, 1000)))).toEqual([]);
			// another server's note covers nobody here
			forgetRuleMemory();
			await look(rule, at(sides(7, 5), 0));
			noteStaffMove('other-server', 'm0', V, 500);
			expect(moved(await look(rule, at(stacked, 1000)))).toEqual(['m0']);
		});

		test('watch only queues each move as a row that is never sent, and no whispers', async () => {
			const rule = row({ ...BAL, watchOnly: true, message: 'You are on {team}.' });
			await look(rule, at(sides(8, 4), 0));
			const ev = await look(rule, at([...sides(8, 4), player('new', V)], 1000));
			expect(ev.intents.map((i) => [i.action, i.target, i.watchOnly])).toEqual([
				['changeTeam', 'new', 'Watch only: would move Pnew to Manticore.']
			]);
			expect(ev.updates[0].lastResult).toBe('Would move Pnew');
			// decided once
			const again = await look(rule, at([...sides(8, 4), player('new', V)], 2000));
			expect(again.intents).toEqual([]);
		});

		test('a rule saved before balancing only ever closes its faction', async () => {
			const old = {
				...row(CLOSED),
				config: { closedFaction: 'Lonestar', names: {}, message: '' }
			} as unknown as TriggerRow;
			await look(old, at(sides(12, 2), 0));
			const ev = await look(
				old,
				at([...sides(12, 2), player('new', V)], 1000, {
					matchEnd: {} as TickContext['matchEnd']
				})
			);
			expect(moved(ev)).toEqual([]);
		});
	});
});
