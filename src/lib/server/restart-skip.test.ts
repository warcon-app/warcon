// The Skip map after restart rule: when it acts (restartSkipStep), what the worker queues at a look
// (evaluateTriggers), and the skip itself against the mock game, which comes up on its start-up map
// under MOCK_STARTUP_MAP as live servers do.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Env } from './env';
import { WardogsClient } from './rcon';
import { readConfig } from './actions';
import { restartMock } from './mockgame';
import {
	isEntry,
	onNow,
	RESTART_SKIP,
	RESTART_SKIP_KEY,
	RESTART_SKIP_LATE_MS,
	restartSkipState,
	restartSkipStep,
	selectionName,
	skipStartupMap,
	underWay
} from './restart-skip';
import { rotationIntoText } from '../rotation-doc';
import { evaluateTriggers, type TickContext } from './triggers';
import type { TriggerRow } from './db/schema';
import type { MapSelection, Status } from '../types';

const MIN = 60_000;
const H = 60 * MIN;
const SAVED = Date.UTC(2026, 9, 16, 12, 0, 0);

describe('restartSkipStep', () => {
	const look = (startedAt: number) => ({ startedAt, armedAt: SAVED });

	test('nothing while the start is unknown', () => {
		expect(restartSkipStep(null, look(0))).toBeNull();
	});

	test('a run that was going when the rule was switched on is only noted', () => {
		const step = restartSkipStep(null, look(SAVED - 3 * H));
		expect(step).toEqual({ state: { armedAt: SAVED, boot: SAVED - 3 * H }, act: false });
		// the rest of that run, with the start drifting by the looks' latency: nothing
		expect(restartSkipStep(step!.state, look(SAVED - 3 * H + 4_000))).toBeNull();
	});

	test('the first look of every later run acts, once', () => {
		let s = restartSkipStep(null, look(SAVED - 3 * H))!.state;
		const next = SAVED + 21 * H;
		const up = restartSkipStep(s, look(next))!;
		expect(up).toEqual({ state: { armedAt: SAVED, boot: next }, act: true });
		s = up.state;
		expect(restartSkipStep(s, look(next + 30_000))).toBeNull();
		// a second restart soon after (a crash): its own first look acts too
		expect(restartSkipStep(s, look(next + 5 * MIN))?.act).toBe(true);
	});

	test('a run that started while the rule was being saved counts as after it', () => {
		expect(restartSkipStep(null, look(SAVED - 30_000))?.act).toBe(true);
		expect(restartSkipStep(null, look(SAVED + 2 * MIN))?.act).toBe(true);
		expect(restartSkipStep(null, look(SAVED - 2 * MIN))?.act).toBe(false);
	});

	test('the start it was switched on at is kept, not the save after it', () => {
		const s = { armedAt: SAVED, boot: SAVED + H };
		// a rename later on: the row's last save moves, the state does not
		expect(restartSkipStep(s, { startedAt: SAVED + 25 * H, armedAt: SAVED + 24 * H })).toEqual({
			state: { armedAt: SAVED, boot: SAVED + 25 * H },
			act: true
		});
	});

	test('reads back only a state it wrote', () => {
		expect(restartSkipState(null)).toBeNull();
		expect(restartSkipState({ boot: SAVED })).toBeNull();
		expect(restartSkipState({ armedAt: SAVED, boot: 'x' })).toBeNull();
		expect(restartSkipState({ armedAt: SAVED, boot: SAVED + H, more: 1 })).toEqual({
			armedAt: SAVED,
			boot: SAVED + H
		});
	});
});

test('underWay: a side has scored and the run is past its first ten minutes', () => {
	const start = SAVED;
	expect(underWay([{ score: 0 }, { score: 0 }], start, start + H)).toBe(false);
	expect(underWay([{ score: 3 }, { score: 0 }], start, start + RESTART_SKIP_LATE_MS)).toBe(false);
	expect(underWay([{ score: 3 }, { score: 0 }], start, start + RESTART_SKIP_LATE_MS + 1)).toBe(
		true
	);
});

describe('which map is which', () => {
	const sel = (map: string, experiences: string[], lighting = '', zoneAlternator = '') => ({
		map,
		experiences,
		lighting,
		zoneAlternator
	});

	test('an entry is the same map and modes, and time of day where the entry names one', () => {
		const on = sel('Kavkazi', ['Bakurani_KOTH_02'], 'DayClear', 'ZoneAlternator.Bakurani.A');
		expect(isEntry(sel('Kavkazi', ['Bakurani_KOTH_02'], 'DayClear'), on)).toBe(true);
		expect(isEntry(sel('kavkazi', ['bakurani_koth_02'], ''), on)).toBe(true);
		// the zone alone never takes a map off the rotation
		expect(isEntry(sel('Kavkazi', ['Bakurani_KOTH_02'], 'DayClear', 'Other'), on)).toBe(true);
		expect(isEntry(sel('Kavkazi', ['Bakurani_KOTH_02', 'KOTH_InfantryOnly'], 'DayClear'), on)).toBe(
			false
		);
		expect(isEntry(sel('Kavkazi', ['Bakurani_KOTH_01'], 'DayClear'), on)).toBe(false);
		expect(isEntry(sel('Kavkazi', ['Bakurani_KOTH_02'], 'DayLateRain'), on)).toBe(false);
		expect(isEntry(sel('Europe', ['Bakurani_KOTH_02'], 'DayClear'), on)).toBe(false);
		// modes in any order
		expect(
			isEntry(
				sel('Europe', ['KOTH_InfantryOnly', 'Madrid_KOTH_01']),
				sel('Europe', ['Madrid_KOTH_01', 'KOTH_InfantryOnly'], 'DayClear')
			)
		).toBe(true);
	});

	test('names say the map, its modifiers and the time of day', () => {
		expect(selectionName(sel('Kavkazi', ['Bakurani_KOTH_02'], 'DayClear'))).toBe(
			'Bakurani (Day Clear)'
		);
		expect(
			selectionName(sel('Europe', ['Madrid_KOTH_01', 'KOTH_InfantryOnly'], 'DayEarlyFog'))
		).toBe('Ozeti (Infantry Only, Day Early Fog)');
		expect(selectionName(sel('NorthAmerica', []))).toBe('Zestafona');
	});
});

test('the rule queues one skip a run, and leaves a match under way to play', async () => {
	const row = {
		id: 'rule-1',
		serverId: 'server-1',
		orgId: 'org-1',
		kind: 'restart_skip',
		name: 'Skip map after restart',
		enabled: true,
		config: {},
		state: null,
		lastFiredAt: null,
		lastResult: '',
		updatedAt: new Date(SAVED)
	} as unknown as TriggerRow;
	let scores = [0, 0, 0];
	const look = (startedAt: number, at: number) =>
		evaluateTriggers(
			{} as Env,
			{
				server: { id: 'server-1', name: 'Test' },
				status: {
					map: 'Kavkazi',
					experiences: ['Bakurani_KOTH_02'],
					lighting: 'DayClear',
					alternator: 'ZoneAlternator.Bakurani.Default.Circle',
					rotationNow: -1,
					playerCount: 0,
					scores: scores.map((score, i) => ({ name: `F${i}`, colorHex: '', score }))
				},
				players: [],
				startedAt,
				ts: new Date(at)
			} as unknown as TickContext,
			[row]
		);
	// The run going when the rule was saved: noted, nothing queued.
	let out = await look(SAVED - 5 * H, SAVED + MIN);
	expect(out).toEqual({
		intents: [],
		updates: [{ id: 'rule-1', state: { armedAt: SAVED, boot: SAVED - 5 * H } }]
	});
	expect(await look(SAVED - 5 * H, SAVED + 2 * H)).toEqual({ intents: [], updates: [] });
	// The next run, at its first look: one skip, carrying what the look saw.
	const boot = SAVED + 19 * H;
	out = await look(boot, boot + 90_000);
	expect(out.intents).toHaveLength(1);
	const on = {
		map: 'Kavkazi',
		experiences: ['Bakurani_KOTH_02'],
		lighting: 'DayClear',
		zoneAlternator: 'ZoneAlternator.Bakurani.Default.Circle'
	};
	expect(out.intents[0]).toMatchObject({
		action: RESTART_SKIP,
		params: { rule: RESTART_SKIP_KEY, startedAt: boot, ...on },
		target: 'Bakurani (Day Clear)',
		steamId: null,
		dedupeKey: `rule-1:boot:${boot}`
	});
	expect(out.intents[0].watchOnly).toBeUndefined();
	expect(out.updates).toEqual([
		{
			id: 'rule-1',
			lastFiredAt: new Date(boot + 90_000),
			lastResult: 'Checking Bakurani (Day Clear), the map the server came up on.',
			state: { armedAt: SAVED, boot }
		}
	]);
	// the rest of the run: nothing, whatever the server shows
	expect(await look(boot + 3_000, boot + 5 * MIN)).toEqual({ intents: [], updates: [] });
	// A run the worker first sees late, with a side scoring: kept as skipped, never sent.
	scores = [12, 4, 7];
	const late = SAVED + 43 * H;
	out = await look(late, late + 25 * MIN);
	expect(out.intents.map((i) => i.watchOnly)).toEqual([
		'Came up on Bakurani (Day Clear) with the match under way when first seen, so it plays on.'
	]);
	expect(out.updates).toEqual([
		{
			id: 'rule-1',
			lastResult: 'Left Bakurani (Day Clear) to play.',
			state: { armedAt: SAVED, boot: late }
		}
	]);
	// Late but nobody has scored (an empty server waiting for players): skipped all the same.
	scores = [0, 0, 0];
	const quiet = SAVED + 67 * H;
	out = await look(quiet, quiet + 3 * H);
	expect(out.intents.map((i) => [i.action, i.watchOnly])).toEqual([[RESTART_SKIP, undefined]]);
	// Unknown uptime: nothing at all.
	expect(await look(0, SAVED + 90 * H)).toEqual({ intents: [], updates: [] });
});

// ---- the skip against the mock game ----

let n = 0;
/** a demo server of its own, and the key the mock keeps its state under */
const fresh = () => {
	const key = `restart-skip-test-${Date.now()}-${++n}`;
	const server = { id: `restart-skip-${n}`, host: 'demo', port: 1, scheme: 'http' as const };
	return { key, client: new WardogsClient({} as Env, server, 'demo', key) };
};
const statusOf = (client: WardogsClient) =>
	client.json('GET', '/v1/status') as Promise<Status & { rotation: { nowIndex: number } }>;
const looked = async (client: WardogsClient) => {
	const s = (await client.json('GET', '/v1/status')) as {
		map: string;
		experiences: string[];
		lighting: string;
		alternator: string;
	};
	return { startedAt: Date.now(), ...onNow(s) };
};
async function setRotation(client: WardogsClient, entries: MapSelection[], enabled = true) {
	const doc = await readConfig(client);
	const text = rotationIntoText(doc.text, { enabled, mode: 'ordered', entries });
	const { status } = await client.configCall('PUT', '/v1/config', text, doc.revision);
	expect(status).toBe(200);
}
const INFANTRY: MapSelection[] = [
	{
		map: 'Europe',
		experiences: ['Madrid_KOTH_01', 'KOTH_InfantryOnly'],
		lighting: 'DayEarlyFog',
		zoneAlternator: ''
	},
	{
		map: 'Kavkazi',
		experiences: ['Bakurani_KOTH_01', 'KOTH_InfantryOnly'],
		lighting: 'DayClear',
		zoneAlternator: ''
	}
];

describe('skipStartupMap on the mock game', () => {
	const was = process.env.MOCK_STARTUP_MAP;
	beforeAll(() => {
		process.env.MOCK_STARTUP_MAP = 'true';
	});
	afterAll(() => {
		if (was === undefined) delete process.env.MOCK_STARTUP_MAP;
		else process.env.MOCK_STARTUP_MAP = was;
	});
	/** a server with this rotation, just restarted: on the start-up map */
	async function restarted(entries: MapSelection[], enabled = true) {
		const { key, client } = fresh();
		await setRotation(client, entries, enabled);
		restartMock(key);
		return client;
	}

	test('an infantry-only rotation: the standard start-up match is ended and the top comes up', async () => {
		const client = await restarted(INFANTRY);
		const before = await statusOf(client);
		expect([before.map, before.experiences, before.lighting]).toEqual([
			'Kavkazi',
			['Bakurani_KOTH_01'],
			'DayClear'
		]);
		expect(before.rotation.nowIndex).toBe(-1);
		const r = await skipStartupMap(client, await looked(client));
		expect(r).toEqual({
			message:
				'Skipped Bakurani (Day Clear), which the rotation does not have; Ozeti (Infantry Only, Day Early Fog) is next.'
		});
		const after = await statusOf(client);
		expect([after.map, after.experiences, after.rotation.nowIndex]).toEqual([
			'Europe',
			['Madrid_KOTH_01', 'KOTH_InfantryOnly'],
			0
		]);
	});

	test('a server that comes up on an entry of its rotation is left', async () => {
		const client = await restarted([
			...INFANTRY,
			{
				map: 'Kavkazi',
				experiences: ['Bakurani_KOTH_01'],
				lighting: 'DayClear',
				zoneAlternator: ''
			}
		]);
		expect(await skipStartupMap(client, await looked(client))).toEqual({
			skipped: true,
			message: 'Bakurani (Day Clear) is in the rotation: nothing to skip.'
		});
		expect((await statusOf(client)).rotation.nowIndex).toBe(-1);
	});

	test('a rotation that is off is left: ending the match would reload the same map', async () => {
		const client = await restarted(INFANTRY, false);
		expect(await skipStartupMap(client, await looked(client))).toEqual({
			skipped: true,
			message:
				'The rotation is off on this server, so ending the match would only load Bakurani (Day Clear) again.'
		});
		expect((await statusOf(client)).map).toBe('Kavkazi');
	});

	test('a server that moved on since the look is left', async () => {
		const client = await restarted(INFANTRY);
		const seen = await looked(client);
		await client.json('POST', '/v1/match/end');
		expect(await skipStartupMap(client, seen)).toEqual({
			skipped: true,
			message: 'The server had moved on to Ozeti (Infantry Only, Day Early Fog).'
		});
		expect((await statusOf(client)).rotation.nowIndex).toBe(0);
	});

	test('a match under way by the time it is sent is left to play', async () => {
		const client = await restarted(INFANTRY);
		const seen = await looked(client);
		// the mock scores a point every couple of seconds; the run is past its first minutes
		await Bun.sleep(2_500);
		expect(
			await skipStartupMap(client, { ...seen, startedAt: Date.now() - RESTART_SKIP_LATE_MS - 1 })
		).toEqual({
			skipped: true,
			message: 'The match on Bakurani (Day Clear) was under way, so it plays on.'
		});
		expect((await statusOf(client)).map).toBe('Kavkazi');
	});
});
