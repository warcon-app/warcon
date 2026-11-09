// The High ping kick on one look: a rule that spares reserved slots leaves their holders out, and
// until the worker has read the reserved list it holds every kick that falls due, so the first
// look after a start cannot kick a reserved regular. Rules that do not spare them, and rules saved
// before the setting, kick everyone over the limit as before.
import { describe, expect, test } from 'bun:test';
import { evaluateTriggers, validateConfig, type Evaluation, type TickContext } from './triggers';
import type { PingKickState } from './trigger-rules';
import type { TriggerRow } from './db/schema';
import type { Env } from './env';
import type { Player } from '$lib/types';

const NOW = Date.parse('2026-10-16T18:00:00Z');
const player = (name: string, steamId: string, ping: number): Player => ({
	name,
	steamId,
	faction: 'Valkyra',
	kills: 0,
	deaths: 0,
	cash: 0,
	ping
});
const REGULAR = player('Regular', '76561198000000801', 310);
const VISITOR = player('Visitor', '76561198000000802', 290);

/** Both over the limit for two minutes, as of the look before this one. */
const streaks = (): PingKickState => ({
	lastAt: NOW - 2000,
	players: {
		[REGULAR.steamId]: { since: NOW - 120_000, fired: false },
		[VISITOR.steamId]: { since: NOW - 120_000, fired: false }
	}
});

const rule = (config: unknown) =>
	({
		id: 'rule-ping',
		name: 'High ping kick',
		kind: 'ping_kick',
		config,
		state: streaks(),
		lastFiredAt: null
	}) as unknown as TriggerRow;

/** A look with both players on and REGULAR on the reserved list the worker has read. */
const look = (over: Partial<TickContext> = {}, at = NOW) =>
	({
		server: { id: 'srv', name: 'Panel name' },
		status: {
			serverName: 'Example Clan #1',
			map: 'NorthAmerica',
			playerCount: 2,
			maxPlayers: 100,
			scores: [],
			scoreCap: null
		},
		players: [REGULAR, VISITOR],
		playersObserved: true,
		playersIntervalMs: 2000,
		joined: [],
		renamed: [],
		returned: [],
		riskCheck: [],
		factioned: [],
		firstVisit: new Set(),
		reserved: new Set([REGULAR.steamId]),
		reservedLoaded: true,
		seedMs: new Map(),
		signals: new Map(),
		profiles: new Map(),
		performance: new Map(),
		startedAt: NOW - 3_600_000,
		matchEnd: null,
		matchLines: [],
		ts: new Date(at),
		...over
	}) as unknown as TickContext;
const unread = { reserved: new Set<string>(), reservedLoaded: false };

const evaluate = (row: TriggerRow, ctx: TickContext) => evaluateTriggers({} as Env, ctx, [row]);
const kicked = (ev: Evaluation) => ev.intents.map((i) => i.params.steamId as string).sort();
const streakOf = (row: TriggerRow, p: Player) => (row.state as PingKickState).players[p.steamId];
const BOTH = [REGULAR.steamId, VISITOR.steamId].sort();

describe('the High ping kick and reserved slots', () => {
	test('a rule that spares them kicks the others and ends the reserved player’s streak', async () => {
		const row = rule(validateConfig('ping_kick', { spareReserved: true }));
		const ev = await evaluate(row, look());
		expect(kicked(ev)).toEqual([VISITOR.steamId]);
		expect(ev.intents[0].params.reason).toBe('Ping too high for too long.');
		expect(streakOf(row, REGULAR)).toBeUndefined();
		expect(streakOf(row, VISITOR)).toEqual({ since: NOW - 120_000, fired: true });
		expect(ev.updates.at(-1)?.lastResult).toBe('Kicking Visitor: high ping');
	});

	test('a rule that does not spare them kicks a reserved player too, as does one saved before the setting', async () => {
		const before = { maxPingMs: 200, durationSeconds: 60, reason: 'Ping too high for too long.' };
		for (const config of [validateConfig('ping_kick', {}), before]) {
			expect(kicked(await evaluate(rule(config), look()))).toEqual(BOTH);
			// and it never waits for the reserved list
			expect(kicked(await evaluate(rule(config), look(unread)))).toEqual(BOTH);
		}
	});

	test('before the reserved list is read it kicks nobody and says so; the read lets the kick go', async () => {
		const row = rule(validateConfig('ping_kick', { spareReserved: true }));
		const waiting = await evaluate(row, look(unread));
		expect(waiting.intents).toEqual([]);
		expect(waiting.updates).toEqual([
			{ id: row.id, state: row.state, lastResult: 'Waiting for the reserved slots to be read' }
		]);
		// both streaks go on, neither spent
		expect(streakOf(row, REGULAR)).toEqual({ since: NOW - 120_000, fired: false });
		expect(streakOf(row, VISITOR)).toEqual({ since: NOW - 120_000, fired: false });

		// read at the next look: the reserved player is spared, the other kicked on the same streak
		const read = await evaluate(row, look({}, NOW + 2000));
		expect(kicked(read)).toEqual([VISITOR.steamId]);
		const direct = await evaluate(
			rule(validateConfig('ping_kick', { spareReserved: true })),
			look()
		);
		expect(read.intents[0].dedupeKey).toBe(direct.intents[0].dedupeKey);
		expect(streakOf(row, REGULAR)).toBeUndefined();
		// spent: not again while the ping stays high
		expect(kicked(await evaluate(row, look({}, NOW + 4000)))).toEqual([]);
	});

	test('a streak that has not run its time yet says nothing while the list is unread', async () => {
		const row = rule(validateConfig('ping_kick', { spareReserved: true, durationSeconds: 600 }));
		const ev = await evaluate(row, look(unread));
		expect(ev.intents).toEqual([]);
		expect(ev.updates.map((u) => u.lastResult)).toEqual([undefined]);
	});
});
