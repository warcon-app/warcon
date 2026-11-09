// AFK watch: the step on its own (a player's time runs while they get no kill, no death and no
// cash in a live match, starts again whenever they do or the match is not live, and what falls due
// waits while nobody on the server is seen earning), the settings it takes, and the rule on the worker's looks: the warning, the kick or flag and what they
// carry, the players it spares, and the clocks moving on only once a look's actions are queued.
import { beforeEach, describe, expect, test } from 'bun:test';
import {
	AFK_WATCH_FLAG,
	afkWatchSettingsKey,
	afkWatchStep,
	validateAfkWatch,
	type AfkWatchConfig,
	type AfkWatchLook,
	type AfkWatchState
} from './afk-watch';
import {
	evaluateTriggers,
	forgetRuleMemory,
	ruleNeeds,
	validateConfig,
	type Evaluation,
	type Intent,
	type TickContext
} from './triggers';
import { ApiError } from './http';
import type { TriggerRow } from './db/schema';
import type { Env } from './env';
import type { Player } from '$lib/types';

const MIN = 60_000;
const NOW = Date.parse('2026-10-25T14:00:00Z');

function player(
	name: string,
	steamId: string,
	c: { kills: number; deaths: number; cash: number }
): Player {
	return { name, steamId, faction: 'Valkyra', ping: 40, ...c };
}

describe('the step', () => {
	const cfg = { minutes: 15, warnMinutes: 10 };
	const still = { steamId: '76561198000000901', kills: 3, deaths: 2, cash: 1200, spared: false };
	/** someone at work, earning at every look, so cash is seen moving on the server */
	const busy = (i: number, spared = false) => ({
		steamId: '76561198000000909',
		kills: 0,
		deaths: 0,
		cash: 100 * i,
		spared
	});
	/** One look a minute (each minute is enough to see the clock), live with `still` and the busy
	 *  player on unless said. */
	const run = (looks: Partial<AfkWatchLook>[]) => {
		let state: AfkWatchState | null = null;
		const fired: { at: number; warn: string[]; act: string[] }[] = [];
		const held: { at: number; why: string }[] = [];
		looks.forEach((l, i) => {
			const step = afkWatchStep(cfg, state, {
				now: NOW + i * MIN,
				live: true,
				players: [still, busy(i)],
				...l
			});
			state = step.state;
			if (step.warn.length || step.act.length)
				fired.push({
					at: i,
					warn: step.warn.map((w) => w.steamId),
					act: step.act.map((a) => a.steamId)
				});
			if (step.held) held.push({ at: i, why: step.held });
		});
		return { fired, held, state: state! as AfkWatchState };
	};
	const minutes = (n: number, at: (i: number) => Partial<AfkWatchLook> = () => ({})) =>
		Array.from({ length: n + 1 }, (_, i) => at(i));
	/** `still` changed from minute `from` on, the busy player still busy */
	const changed = (from: number, ...steps: [number, Partial<typeof still>][]) =>
		minutes(40, (i) => {
			const now = steps.filter(([at]) => i >= at).reduce((p, [, c]) => ({ ...p, ...c }), still);
			return i >= from ? { players: [now, busy(i)] } : {};
		});
	const WARN = (at: number) => ({ at, warn: [still.steamId], act: [] });
	const ACT = (at: number) => ({ at, warn: [], act: [still.steamId] });

	test('still for the warning time, warned once; still for the rule time, acted on once', () => {
		expect(run(minutes(40)).fired).toEqual([WARN(10), ACT(15)]);
	});

	test('a kill, a death or cash earned starts the time again', () => {
		for (const moved of [
			{ kills: 4 },
			{ deaths: 3 },
			{ cash: 1350 },
			// the next match starting the counters again
			{ kills: 0, deaths: 0, cash: 0 }
		]) {
			// moved at minute 8 (and stays so): warned at 18, acted on at 23
			expect([moved, run(changed(8, [8, moved])).fired]).toEqual([moved, [WARN(18), ACT(23)]]);
		}
	});

	test('cash spent does not: a macro can buy things; what is earned after it counts from there', () => {
		expect(run(changed(8, [8, { cash: 900 }])).fired).toEqual([WARN(10), ACT(15)]);
		// spent at 8, then 100 earned at 12, still below where it was: the time starts again at 12
		expect(run(changed(8, [8, { cash: 900 }], [12, { cash: 1000 }])).fired).toEqual([
			WARN(10),
			WARN(22),
			ACT(27)
		]);
	});

	test('a look that is not live starts the time again and counts for nothing', () => {
		expect(run(minutes(30, (i) => ({ live: i !== 9 }))).fired).toEqual([WARN(19), ACT(24)]);
		// never live: nothing, however long
		expect(run(minutes(60, () => ({ live: false }))).fired).toEqual([]);
	});

	test('a player off the list is forgotten, and back on it starts from nothing', () => {
		const looks = minutes(30, (i) => (i === 12 ? { players: [busy(i)] } : {}));
		expect(run(looks).fired).toEqual([WARN(10), WARN(23), ACT(28)]);
	});

	test('nobody seen earning cash in the rule’s minutes: what falls due waits, until someone earns', () => {
		// alone until minute 20 (a host that reports no cash looks the same); someone earning from 21
		const { fired, held } = run(
			minutes(30, (i) => (i <= 20 ? { players: [still] } : { players: [still, busy(i)] }))
		);
		// warned at 10, inside the minutes since the first look; the kick waits from 15 to 21, and
		// goes at 22, the first look with cash seen earned
		expect(fired).toEqual([WARN(10), ACT(22)]);
		expect(held).toEqual(Array.from({ length: 7 }, (_, n) => ({ at: 15 + n, why: 'cash' })));
	});

	test('cash earned by a player it spares is cash seen moving all the same', () => {
		const looks = minutes(20, (i) => ({ players: [still, busy(i, true)] }));
		expect(run(looks).fired).toEqual([WARN(10), ACT(15)]);
	});

	test('while the reserved slots are unread what falls due waits, marked as not done', () => {
		const { fired, held } = run(minutes(20, (i) => ({ waiting: i >= 9 && i <= 12 })));
		expect(fired).toEqual([WARN(13), ACT(15)]);
		expect(held).toEqual([10, 11, 12].map((at) => ({ at, why: 'reserved' })));
	});

	test('a spared player is never acted on, and their time starts again at every look they are', () => {
		const looks = minutes(40, (i) => ({ players: [{ ...still, spared: i < 20 }, busy(i)] }));
		// spared to minute 19: their time runs from there
		expect(run(looks).fired).toEqual([WARN(29), ACT(34)]);
	});

	test('past both times at one look (a slow cadence), it acts and does not warn as well', () => {
		const first = afkWatchStep(cfg, null, { now: NOW, live: true, players: [still, busy(0)] });
		const late = afkWatchStep(cfg, first.state, {
			now: NOW + 16 * MIN,
			live: true,
			players: [still, busy(16)]
		});
		expect([late.warn, late.act.map((a) => a.steamId)]).toEqual([[], [still.steamId]]);
		// and never warns that stretch afterwards
		const after = afkWatchStep(cfg, late.state, {
			now: NOW + 17 * MIN,
			live: true,
			players: [still, busy(17)]
		});
		expect([after.warn, after.act]).toEqual([[], []]);
	});

	test('no warning time: acted on, never warned', () => {
		let state: AfkWatchState | null = null;
		const seen: string[] = [];
		for (let i = 0; i <= 20; i++) {
			const step = afkWatchStep({ minutes: 15, warnMinutes: 0 }, state, {
				now: NOW + i * MIN,
				live: true,
				players: [still, busy(i)]
			});
			state = step.state;
			for (const _ of step.warn) seen.push(`warn ${i}`);
			for (const _ of step.act) seen.push(`act ${i}`);
		}
		expect(seen).toEqual(['act 15']);
	});

	test('each player has a clock of their own', () => {
		const other = { ...still, steamId: '76561198000000902' };
		const { fired, state } = run(
			minutes(20, (i) => ({
				players: [still, i < 5 ? other : { ...other, kills: i }, busy(i)]
			}))
		);
		expect(fired).toEqual([WARN(10), ACT(15)]);
		expect(state.players.get(other.steamId)?.since).toBe(NOW + 20 * MIN);
	});
});

describe('the settings', () => {
	test('a rule with nothing set: 15 minutes, no warning, a kick, from 20 on, reserved slots spared', () => {
		expect(validateAfkWatch({})).toEqual({
			minutes: 15,
			warnMinutes: 0,
			warnMessage: '',
			action: 'kick',
			minPlayers: 20,
			spareReserved: true,
			exempt: [],
			reason: 'AFK: no kill, death or cash earned for {idle} minutes.'
		});
	});

	test('the idle time is 5 to 120 minutes; the count at least 1', () => {
		expect(validateAfkWatch({ minutes: 1 }).minutes).toBe(5);
		expect(validateAfkWatch({ minutes: 500 }).minutes).toBe(120);
		expect(validateAfkWatch({ minPlayers: 0 }).minPlayers).toBe(1);
	});

	const refused = (c: Record<string, unknown>): string => {
		try {
			validateAfkWatch(c);
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			return (err as ApiError).message;
		}
		return 'accepted';
	};

	test('the warning comes before the rule acts, and has words', () => {
		for (const warnMinutes of [15, 20])
			expect(refused({ minutes: 15, warnMinutes, warnMessage: 'Move' })).toContain(
				'below the idle time'
			);
		expect(refused({ minutes: 15, warnMinutes: 10, warnMessage: '  ' })).toBe(
			'Add the warning, or set it to 0 minutes.'
		);
		expect(validateAfkWatch({ minutes: 15, warnMinutes: 10, warnMessage: 'Move' })).toMatchObject({
			warnMinutes: 10,
			warnMessage: 'Move'
		});
	});

	test('the players it leaves alone are SteamID64s, as strings, at most 100', () => {
		expect(validateAfkWatch({ exempt: ['76561198000000801', '76561198000000801'] }).exempt).toEqual(
			['76561198000000801']
		);
		expect(refused({ exempt: [76561198000000801] })).toContain('as strings');
		expect(refused({ exempt: ['Ramon'] })).toContain('is not a SteamID64');
		expect(refused({ exempt: '76561198000000801' })).toContain('a list of SteamID64s');
		const many = Array.from({ length: 101 }, (_, i) => String(76561198000001000n + BigInt(i)));
		expect(refused({ exempt: many })).toContain('At most 100');
	});

	test('anything but alert kicks; the rule needs Kick either way', () => {
		expect(validateAfkWatch({ action: 'ban' }).action).toBe('kick');
		expect(validateAfkWatch({ action: 'alert' }).action).toBe('alert');
		expect(ruleNeeds('afk_watch', validateAfkWatch({}))).toEqual(['players.kick', 'kicks players']);
		expect(ruleNeeds('afk_watch', validateAfkWatch({ action: 'alert' }))).toEqual([
			'players.kick',
			'flags players'
		]);
		expect(validateConfig('afk_watch', { minutes: 20 })).toMatchObject({ minutes: 20 });
	});
});

describe('the rule on the worker’s looks', () => {
	const IDLE = player('Sleepwalker', '76561198000000911', { kills: 0, deaths: 0, cash: 0 });
	const BUSY = player('Grinder', '76561198000000912', { kills: 9, deaths: 4, cash: 5200 });
	const RESERVED = player('Donor', '76561198000000913', { kills: 0, deaths: 0, cash: 0 });
	const STAFF = player('Ramon', '76561198000000914', { kills: 0, deaths: 0, cash: 0 });
	const CONFIG = validateAfkWatch({
		minutes: 15,
		warnMinutes: 10,
		warnMessage: '{name}: idle {idle} min. Play on or be kicked at {limit} min.',
		minPlayers: 2,
		exempt: [STAFF.steamId],
		reason: 'AFK for {idle} minutes on {server}.'
	});
	const STATUS = {
		serverName: 'Example Clan #1',
		map: 'Kavkazi',
		playerCount: 4,
		maxPlayers: 100,
		scores: [
			{ name: 'Valkyra', score: 12 },
			{ name: 'Lonestar', score: 9 }
		],
		scoreCap: null
	};
	let n = 0;
	const rule = (config: AfkWatchConfig = CONFIG) =>
		({
			id: `rule-afk-watch-${++n}`,
			name: 'AFK watch',
			kind: 'afk_watch',
			config,
			state: null,
			lastFiredAt: null
		}) as unknown as TriggerRow;

	/** A look `half` half-minutes in: live, everyone on, the busy player's cash a little higher. */
	const look = (half: number, over: Partial<TickContext> = {}) =>
		({
			server: { id: 'srv', name: 'Panel name' },
			status: STATUS,
			players: [IDLE, { ...BUSY, cash: BUSY.cash + half * 100 }, RESERVED, STAFF],
			playersObserved: true,
			// half a minute is the idle cadence; nothing between two looks is a gap
			playersIntervalMs: 30_000,
			joined: [],
			renamed: [],
			returned: [],
			riskCheck: [],
			factioned: [],
			firstVisit: new Set(),
			reserved: new Set([RESERVED.steamId]),
			reservedLoaded: true,
			seedMs: new Map(),
			signals: new Map(),
			profiles: new Map(),
			performance: new Map(),
			startedAt: NOW - 3_600_000,
			matchEnd: null,
			matchLines: [],
			ts: new Date(NOW + half * 30_000),
			...over
		}) as unknown as TickContext;

	/** One look, its actions committed unless `commit` is false (the write failed). */
	const once = async (row: TriggerRow, ctx: TickContext, commit = true) => {
		const ev = await evaluateTriggers({} as Env, ctx, [row]);
		if (commit) for (const f of ev.afterCommit ?? []) f();
		return ev;
	};
	/** A look every half minute from minute `from` to minute `to`, `over` changing some of them. */
	const looks = async (
		row: TriggerRow,
		from: number,
		to: number,
		over: (minute: number) => Partial<TickContext> = () => ({})
	): Promise<Evaluation[]> => {
		const evs: Evaluation[] = [];
		for (let half = from * 2; half <= to * 2; half++)
			evs.push(await once(row, look(half, over(half / 2))));
		return evs;
	};
	const intents = (evs: Evaluation[]): Intent[] => evs.flatMap((e) => e.intents);
	/** each intent's action, player and the minute its stretch began */
	const what = (list: Intent[]) =>
		list.map((i) => [i.action, i.steamId, (Number(i.dedupeKey.split(':').pop()) - NOW) / MIN]);

	beforeEach(() => forgetRuleMemory());

	test('the idle player is warned at 10 minutes and kicked at 15; nobody else is touched', async () => {
		const row = rule();
		const evs = await looks(row, 0, 25);
		const [warn, kick, ...more] = intents(evs);
		expect(more).toEqual([]);
		const key = afkWatchSettingsKey(CONFIG);
		expect([warn.action, warn.trigger.id, warn.params]).toEqual([
			'whisper',
			row.id,
			{
				steamId: IDLE.steamId,
				message: 'Sleepwalker: idle 10 min. Play on or be kicked at 15 min.',
				rule: key,
				seen: { kills: 0, deaths: 0, cash: 0 }
			}
		]);
		expect([kick.action, kick.params]).toEqual([
			'kick',
			{
				steamId: IDLE.steamId,
				reason: 'AFK for 15 minutes on Example Clan #1.',
				rule: key,
				seen: { kills: 0, deaths: 0, cash: 0 }
			}
		]);
		expect(kick.okMessage).toBe(
			'Kicked Sleepwalker: no kill, death or cash earned for 15 min of a live match.'
		);
		// one stretch, one warning and one kick, keyed on when it began
		expect([warn.dedupeKey, kick.dedupeKey]).toEqual([
			`${row.id}:${IDLE.steamId}:warn:${NOW}`,
			`${row.id}:${IDLE.steamId}:${NOW}`
		]);
		// and the rule's row says so, at those looks only
		expect(evs.flatMap((e) => e.updates)).toEqual([
			{
				id: row.id,
				lastFiredAt: new Date(NOW + 10 * MIN),
				lastResult: 'Warning Sleepwalker: idle 10 min'
			},
			{
				id: row.id,
				lastFiredAt: new Date(NOW + 15 * MIN),
				lastResult: 'Kicking Sleepwalker: idle 15 min'
			}
		]);
	});

	test('alert only: a flag at 15 minutes, nothing sent to the player but the warning', async () => {
		const config = { ...CONFIG, action: 'alert' as const };
		const list = intents(await looks(rule(config), 0, 25));
		expect(what(list)).toEqual([
			['whisper', IDLE.steamId, 0],
			[AFK_WATCH_FLAG, IDLE.steamId, 0]
		]);
		expect(list[1].params).toEqual({
			rule: afkWatchSettingsKey(config),
			seen: { kills: 0, deaths: 0, cash: 0 }
		});
		expect(list[1].okMessage).toBe(
			'Flagged Sleepwalker: no kill, death or cash earned for 15 min of a live match.'
		);
	});

	test('a reserved slot spares only when the rule says so; the listed players always', async () => {
		const spares = intents(await looks(rule(), 0, 25));
		expect(what(spares.filter((i) => i.action === 'kick'))).toEqual([['kick', IDLE.steamId, 0]]);
		const sparesNot = intents(await looks(rule({ ...CONFIG, spareReserved: false }), 0, 25));
		expect(
			sparesNot
				.filter((i) => i.action === 'kick')
				.map((i) => i.steamId)
				.sort()
		).toEqual([IDLE.steamId, RESERVED.steamId].sort());
	});

	test('until the reserved slots are read it acts on nobody, says so once, then catches up', async () => {
		const row = rule();
		const unread = () => ({ reserved: new Set<string>(), reservedLoaded: false });
		const waiting = await looks(row, 0, 12, unread);
		expect(intents(waiting)).toEqual([]);
		// the warning fell due at 10 and waited; the rule said why, once
		expect(waiting.flatMap((e) => e.updates)).toEqual([
			{ id: row.id, lastResult: 'Waiting for the reserved slots to be read' }
		]);
		// read: the warning it held goes at once, to the idle player only
		const read = await looks(row, 12.5, 12.5);
		expect(what(intents(read))).toEqual([['whisper', IDLE.steamId, 0]]);
	});

	test('nobody earning cash: it holds, says why once, and acts once someone earns', async () => {
		const row = rule();
		// the busy player is not on, so nobody earns (as on a host that reports no cash)
		const quiet = () =>
			({
				status: { ...STATUS, playerCount: 3 },
				players: [IDLE, RESERVED, STAFF]
			}) as Partial<TickContext>;
		const evs = await looks(row, 0, 20, quiet);
		// warned at 10, inside the minutes since the first look; the kick waits from 15
		expect(what(intents(evs))).toEqual([['whisper', IDLE.steamId, 0]]);
		expect(evs.flatMap((e) => e.updates).map((u) => u.lastResult)).toEqual([
			'Warning Sleepwalker: idle 10 min',
			'Holding: nobody here has earned cash in 15 min, so the server may not report it'
		]);
		// the busy player back, earning: the kick goes at the second look, the first with cash earned
		const back = await looks(row, 20.5, 21);
		expect(what(intents(back))).toEqual([['kick', IDLE.steamId, 0]]);
	});

	test('a look whose write fails is decided again at the next one, then never again', async () => {
		const row = rule({ ...CONFIG, warnMinutes: 0 });
		await looks(row, 0, 14.5);
		const lost = await once(row, look(30), false);
		expect(what(lost.intents)).toEqual([['kick', IDLE.steamId, 0]]);
		const again = await once(row, look(30, { ts: new Date(NOW + 15 * MIN + 2000) }));
		expect(again.intents.map((i) => i.dedupeKey)).toEqual([lost.intents[0].dedupeKey]);
		expect(intents(await looks(row, 15.5, 20))).toEqual([]);
	});

	test('no score, a match ending, too few on: the clocks start again', async () => {
		const notLive: [string, Partial<TickContext>][] = [
			[
				'pre-match',
				{
					status: {
						...STATUS,
						scores: [
							{ name: 'Valkyra', score: 0 },
							{ name: 'Lonestar', score: 0 }
						]
					}
				} as Partial<TickContext>
			],
			[
				'too few on',
				{ status: { ...STATUS, playerCount: 1 }, players: [IDLE] } as Partial<TickContext>
			],
			['a match end', { matchEnd: { map: 'Kavkazi', scores: [], winner: null, leaders: [] } }]
		];
		for (const [why, over] of notLive) {
			// minute 9 is not live, so 10 is no warning and 15 no kick: 19 and 24 are
			const list = intents(await looks(rule(), 0, 25, (m) => (m === 9 ? over : {})));
			expect([why, what(list)]).toEqual([
				why,
				[
					['whisper', IDLE.steamId, 9],
					['kick', IDLE.steamId, 9]
				]
			]);
		}
	});

	test('back from an outage, after a gap in the looks, or with new settings, it starts over', async () => {
		const cases: [string, (row: TriggerRow) => Promise<unknown>][] = [
			['an outage', (row) => once(row, look(18, { recovered: true }))],
			// nothing between minute 8½ and minute 11: longer than the gap allows
			['a gap', (row) => once(row, look(22))],
			[
				'new settings',
				(row) => {
					row.config = { ...CONFIG, reason: 'Gone for {idle} minutes.' };
					return once(row, look(18));
				}
			]
		];
		for (const [why, restart] of cases) {
			const row = rule();
			await looks(row, 0, 8.5);
			await restart(row);
			const from = why === 'a gap' ? 11 : 9;
			const list = intents(await looks(row, from + 0.5, 25));
			expect([why, what(list)]).toEqual([
				why,
				[
					['whisper', IDLE.steamId, from],
					...(from + 15 <= 25 ? [['kick', IDLE.steamId, from]] : [])
				]
			]);
		}
	});

	test('a look without the player list moves nothing', async () => {
		const row = rule();
		await looks(row, 0, 14.5);
		const ev = await once(row, look(30, { playersObserved: false }));
		expect([ev.intents, ev.afterCommit ?? []]).toEqual([[], []]);
		// the clocks are where they were: the next look with the list kicks
		expect(what((await once(row, look(31))).intents)).toEqual([['kick', IDLE.steamId, 0]]);
	});
});
