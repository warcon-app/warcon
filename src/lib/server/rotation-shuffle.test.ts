// The Rotation shuffle rule: when it shuffles (shuffleStep), and the shuffle itself against the mock
// game's config document, whichever way the game moves its pointer when the rotation is rewritten.
import { afterEach, describe, expect, test } from 'bun:test';
import type { Env } from './env';
import { WardogsClient, GameError } from './rcon';
import { ApiError } from './http';
import { readConfig } from './actions';
import {
	shuffleOnServer,
	shuffleStep,
	rotationShuffleState,
	validateRotationShuffle,
	type RotationShuffleState
} from './rotation-shuffle';
import { rotationFromText, rotationIntoText } from '../rotation-doc';
import type { MapSelection } from '../types';
import { evaluateTriggers, type TickContext } from './triggers';
import type { TriggerRow } from './db/schema';

const H = 3600_000;
const START = Date.UTC(2026, 9, 9, 4, 0, 0);

describe('shuffleStep', () => {
	const look = (startedAt: number, restartDue = false) => ({ startedAt, restartDue });

	test('a new rule shuffles at once; nothing while the start is unknown', () => {
		expect(shuffleStep(null, look(0))).toBeNull();
		expect(shuffleStep(null, look(START))).toEqual({
			state: { boot: START, forNext: false, spentBy: 0 },
			when: 'now'
		});
		// Saved in the last round: that shuffle is the one the next run starts on.
		expect(shuffleStep(null, look(START, true))).toEqual({
			state: { boot: START, forNext: true, spentBy: 0 },
			when: 'before-restart'
		});
	});

	test('once a run: in the last round before the restart, and the run after starts on it', () => {
		let s: RotationShuffleState = { boot: START, forNext: false, spentBy: 0 };
		// Same run, a few seconds of drift in the start: nothing.
		expect(shuffleStep(s, look(START + 4_000))).toBeNull();
		// The restart is due: shuffle for the next run, once.
		const due = shuffleStep(s, look(START, true))!;
		expect(due.when).toBe('before-restart');
		s = due.state;
		expect(shuffleStep(s, look(START, true))).toBeNull();
		// The next run comes up on that order: only noted, no shuffle.
		const next = START + 24 * H + 20 * 60_000;
		const up = shuffleStep(s, look(next))!;
		expect(up).toEqual({ state: { ...s, spentBy: next }, when: null });
		s = up.state;
		expect(shuffleStep(s, look(next + 30_000))).toBeNull();
		// Its own last round shuffles again.
		expect(shuffleStep(s, look(next, true))?.when).toBe('before-restart');
	});

	test('after a restart no shuffle was made for: a crash, a set restart time, or a second one', () => {
		const made: RotationShuffleState = { boot: START, forNext: false, spentBy: 0 };
		expect(shuffleStep(made, look(START + 6 * H))).toEqual({
			state: { boot: START + 6 * H, forNext: false, spentBy: 0 },
			when: 'after-restart'
		});
		// Prepared for, and spent by one run; another restart before its own last round.
		const spent: RotationShuffleState = { boot: START, forNext: true, spentBy: START + 24 * H };
		expect(shuffleStep(spent, look(START + 30 * H))?.when).toBe('after-restart');
		// One the rule could not see coming falls in the restart window of the new run: before.
		expect(shuffleStep(made, look(START + 30 * H, true))?.when).toBe('before-restart');
	});

	test('reads back only a state it wrote', () => {
		expect(rotationShuffleState(null)).toBeNull();
		expect(rotationShuffleState({ enabledAt: 5 })).toBeNull();
		expect(rotationShuffleState({ boot: START, forNext: true, spentBy: 'x' })).toEqual({
			boot: START,
			forNext: true,
			spentBy: 0
		});
	});
});

test('the rule queues one shuffle a run, saying what it is for, and keeps its state on the row', async () => {
	const row = {
		id: 'rule-1',
		serverId: 'server-1',
		orgId: 'org-1',
		kind: 'rotation_shuffle',
		name: 'Rotation shuffle',
		enabled: true,
		config: { maps: ['Europe', 'Kavkazi'] },
		state: null,
		lastFiredAt: null,
		lastResult: ''
	} as unknown as TriggerRow;
	const look = (startedAt: number, at: number) =>
		evaluateTriggers(
			{} as Env,
			{
				server: { id: 'server-1', name: 'Test' },
				status: { map: 'Kavkazi', rotationNow: 4, playerCount: 40, scores: [] },
				players: [],
				startedAt,
				ts: new Date(at)
			} as unknown as TickContext,
			[row]
		);
	let out = await look(START, START + H);
	expect(out.intents).toHaveLength(1);
	expect(out.intents[0]).toMatchObject({
		action: 'rotation_shuffle',
		params: { maps: ['Europe', 'Kavkazi'], when: 'now', playing: 'Kavkazi', now: 4 },
		steamId: null
	});
	expect(out.updates).toEqual([
		{
			id: 'rule-1',
			lastFiredAt: new Date(START + H),
			lastResult: 'Shuffling now.',
			state: { boot: START, forNext: false, spentBy: 0 }
		}
	]);
	// The rest of the run, a few seconds of drift in the start: nothing.
	out = await look(START + 3_000, START + 5 * H);
	expect(out).toEqual({ intents: [], updates: [] });
	// The 24-hour restart is due: once, for the run after it.
	out = await look(START, START + 24 * H + 60_000);
	expect(out.intents.map((i) => i.params.when)).toEqual(['before-restart']);
	expect(out.updates[0].lastResult).toBe('Shuffling for after the restart.');
	expect((await look(START, START + 24 * H + 120_000)).intents).toEqual([]);
	// The run that comes up on it is only noted.
	out = await look(START + 24 * H + 600_000, START + 25 * H);
	expect(out.intents).toEqual([]);
	expect(out.updates[0].state).toMatchObject({ spentBy: START + 24 * H + 600_000 });
	// Unknown uptime: nothing at all.
	expect(await look(0, START + 26 * H)).toEqual({ intents: [], updates: [] });
	// Saved again (the state starts over): another shuffle, which the outbox must not take for the
	// first one.
	const first = (await look(START, START + H)).intents;
	row.state = null;
	const again = (await look(START, START + H + 60_000)).intents;
	expect(again.map((i) => i.params.when)).toEqual(['now']);
	expect(again[0].dedupeKey).not.toBe(first[0]?.dedupeKey ?? '');
	row.state = null;
	const one = await look(START, START + H);
	row.state = null;
	const two = await look(START, START + 2 * H);
	expect(one.intents[0].dedupeKey).not.toBe(two.intents[0].dedupeKey);
	// Saved in the last round, after that round's own shuffle: it counts as one for after the
	// restart, and is still not taken for the first.
	row.state = null;
	await look(START, START + H);
	const due = await look(START, START + 24 * H + 60_000);
	row.state = null;
	const saved = await look(START, START + 24 * H + 120_000);
	expect(saved.intents.map((i) => i.params.when)).toEqual(['before-restart']);
	expect(saved.intents[0].dedupeKey).not.toBe(due.intents[0].dedupeKey);
});

test('validateRotationShuffle keeps map ids once each, in order', () => {
	expect(
		validateRotationShuffle({
			maps: ['Europe', 'kavkazi', 'EUROPE', '', '<b>', 'NorthAmerica', 7]
		})
	).toEqual({ maps: ['Europe', 'kavkazi', 'NorthAmerica', '7'] });
	expect(validateRotationShuffle(null)).toEqual({ maps: [] });
	expect(validateRotationShuffle({ maps: 'Europe' })).toEqual({ maps: [] });
});

// ---- the shuffle against the mock game ----

const EXP: Record<string, string> = {
	Europe: 'Madrid_KOTH_01',
	Kavkazi: 'Bakurani_KOTH_01',
	NorthAmerica: 'Detroit_KOTH_01'
};
const LIGHTS = ['DayStartClear', 'DayEarlyClear', 'DayClear', 'DayEndClear'];
/** a whole rotation grouped by map, as an admin writes one: every map, zone and time of day */
const grouped = (zones: Record<string, string[]>): MapSelection[] =>
	Object.entries(zones).flatMap(([map, own]) =>
		own.flatMap((z) =>
			LIGHTS.map((lighting) => ({
				map,
				experiences: [EXP[map]],
				lighting,
				zoneAlternator: `ZoneAlternator.${map}.${z}`
			}))
		)
	);
/** as many entries on each map: the turn holds all the way round */
const EVEN = grouped({
	Europe: ['A', 'B', 'C', 'D'],
	Kavkazi: ['A', 'B', 'C', 'D'],
	NorthAmerica: ['A', 'B', 'C', 'D']
});
/** one map with fewer: whole rounds until it runs out, then the other two in turn */
const UNEVEN = grouped({
	Europe: ['A', 'B', 'C', 'D'],
	Kavkazi: ['A', 'B', 'C', 'D'],
	NorthAmerica: ['A', 'B', 'C']
});
const ORDER = ['Europe', 'Kavkazi', 'NorthAmerica'];
const after = (map: string) => ORDER[(ORDER.indexOf(map) + 1) % ORDER.length];

let n = 0;
const clientFor = () =>
	new WardogsClient(
		{} as Env,
		{ id: `shuffle-${++n}`, host: 'demo', port: 1, scheme: 'http' },
		'demo',
		`shuffle-test-${Date.now()}-${n}`
	);
async function setRotation(client: WardogsClient, entries: MapSelection[], mode = 'random') {
	const doc = await readConfig(client);
	const text = rotationIntoText(doc.text, {
		enabled: true,
		mode: mode as 'random' | 'ordered',
		entries
	});
	const { status } = await client.configCall('PUT', '/v1/config', text, doc.revision);
	expect(status).toBe(200);
}
const live = (client: WardogsClient) =>
	client.json('GET', '/v1/rotation') as Promise<{
		mode: string;
		entries: (MapSelection & { status: string })[];
	}>;
const docRotation = async (client: WardogsClient) =>
	rotationFromText((await readConfig(client)).text);
const repeats = (list: MapSelection[]) =>
	list.filter((e, i) => i > 0 && e.map === list[i - 1].map).length;

describe('shuffleOnServer on the mock game', () => {
	const was = process.env.MOCK_ROTATION_POINTER;
	afterEach(() => {
		if (was === undefined) delete process.env.MOCK_ROTATION_POINTER;
		else process.env.MOCK_ROTATION_POINTER = was;
	});

	/** a server some way into its old order: `matches` map changes after the rotation was set */
	async function playing(entries: MapSelection[], matches: number) {
		const client = clientFor();
		await setRotation(client, entries);
		for (let i = 0; i < matches; i++) await client.json('POST', '/v1/match/end');
		return { client, on: (await live(client)).entries.find((e) => e.status === 'now')! };
	}
	const nextOn = async (client: WardogsClient) =>
		(await live(client)).entries.find((e) => e.status === 'next')!;

	for (const pointer of ['entry', 'index', 'top']) {
		test(`the maps in turn, and the next map follows the one on (pointer: ${pointer})`, async () => {
			process.env.MOCK_ROTATION_POINTER = pointer;
			for (let matches = 0; matches < 48; matches += 5) {
				const { client, on } = await playing(EVEN, matches);
				const { message } = await shuffleOnServer(client, { maps: ORDER, when: 'now' });
				const r = await docRotation(client);
				expect(r.mode).toBe('ordered');
				expect(new Set(r.entries.map((e) => JSON.stringify(e)))).toEqual(
					new Set(EVEN.map((e) => JSON.stringify(e)))
				);
				expect(repeats(r.entries)).toBe(0);
				// whole rounds in the rule's order, turned by under a round to follow the map on
				const maps = r.entries.map((e) => e.map);
				expect(maps.every((m, i) => i === 0 || m === after(maps[i - 1]))).toBe(true);
				const next = await nextOn(client);
				expect(next.map).toBe(after(on.map));
				expect(message).toContain(
					`Shuffled ${EVEN.length} entries: Ozeti, Bakurani, Zestafona in turn`
				);
				expect(message).toContain(
					`${['Ozeti', 'Bakurani', 'Zestafona'][ORDER.indexOf(next.map)]} next`
				);
			}
		});
		test(`a map with fewer entries: never the one on next (pointer: ${pointer})`, async () => {
			process.env.MOCK_ROTATION_POINTER = pointer;
			for (let matches = 0; matches < 44; matches += 3) {
				const { client, on } = await playing(UNEVEN, matches);
				await shuffleOnServer(client, { maps: ORDER, when: 'now' });
				expect(repeats((await docRotation(client)).entries)).toBe(0);
				expect((await nextOn(client)).map).not.toBe(on.map);
			}
		});
	}

	test('turns the order once more when the server does not have the map after the one on next', async () => {
		// The rotation set while the server keeps its entry: it is on the top one (Ozeti). Then it keeps
		// its place in the list instead, where the new order (Ozeti last, Bakurani first) has Zestafona.
		const { client, on } = await playing(EVEN, 0);
		expect(on.map).toBe('Europe');
		process.env.MOCK_ROTATION_POINTER = 'index';
		const raw = client.raw.bind(client);
		let puts = 0;
		client.raw = async (method, path, body, headers) => {
			if (method === 'PUT' && path === '/v1/config') puts++;
			return raw(method, path, body, headers);
		};
		const { message } = await shuffleOnServer(client, { maps: ORDER, when: 'now' });
		expect(puts).toBe(2);
		expect((await nextOn(client)).map).toBe('Kavkazi');
		expect(message).toEndWith('; Bakurani next.');
		expect(repeats((await docRotation(client)).entries)).toBe(0);
	});

	test('before the restart, the top of the order is the map after the one on', async () => {
		for (let round = 0; round < 6; round++) {
			const { client, on } = await playing(UNEVEN, round * 7);
			const { message } = await shuffleOnServer(client, {
				maps: ORDER,
				when: 'before-restart'
			});
			const r = await docRotation(client);
			expect(r.entries[0].map).toBe(after(on.map));
			expect(repeats(r.entries)).toBe(0);
			expect(message).toMatch(/starting on (Ozeti|Bakurani|Zestafona) after the restart\.$/);
		}
	});

	test('leaves a rotation that is off, or too short, as it is', async () => {
		const client = clientFor();
		const doc = await readConfig(client);
		const off = rotationIntoText(doc.text, { enabled: false, mode: 'random', entries: UNEVEN });
		await client.configCall('PUT', '/v1/config', off, doc.revision);
		expect((await shuffleOnServer(client, { maps: ORDER, when: 'now' })).message).toBe(
			'Nothing shuffled: the rotation is switched off on this server.'
		);
		expect((await docRotation(client)).entries).toEqual(UNEVEN);
		await setRotation(client, UNEVEN.slice(0, 1));
		expect((await shuffleOnServer(client, { maps: ORDER, when: 'now' })).message).toBe(
			'Nothing to shuffle: the rotation has fewer than two entries.'
		);
	});

	test("names the turn in the rule's order, the rotation's other maps after", async () => {
		const { client } = await playing(EVEN, 4);
		const { message } = await shuffleOnServer(client, { maps: ['NorthAmerica'], when: 'now' });
		expect(message).toStartWith(
			`Shuffled ${EVEN.length} entries: Zestafona, Ozeti, Bakurani in turn`
		);
	});

	test('a map with half the entries on: the server does not come back up on it', async () => {
		const half = grouped({
			Europe: ['A', 'B', 'C', 'D'],
			Kavkazi: ['A', 'B'],
			NorthAmerica: ['A', 'B']
		});
		for (let matches = 0; matches < 32; matches += 3) {
			const { client, on } = await playing(half, matches);
			await shuffleOnServer(client, { maps: ORDER, when: 'before-restart' });
			const r = await docRotation(client);
			expect([on.map, r.entries[0].map === on.map]).toEqual([on.map, false]);
			expect(repeats(r.entries)).toBe(0);
		}
	});

	test('the map on comes round next on another control zone', async () => {
		for (let matches = 0; matches < 48; matches += 5) {
			const { client, on } = await playing(EVEN, matches);
			await shuffleOnServer(client, { maps: ORDER, when: 'now' });
			const r = await docRotation(client);
			const own = r.entries.find((e) => e.map === on.map)!;
			expect(own.zoneAlternator).not.toBe(on.zoneAlternator);
		}
	});

	test('a refused second turn is told, the shuffle stands; too fast holds the server', async () => {
		process.env.MOCK_ROTATION_POINTER = 'entry';
		for (const answer of [429, 500]) {
			const { client } = await playing(EVEN, 0);
			process.env.MOCK_ROTATION_POINTER = 'index';
			const raw = client.raw.bind(client);
			let puts = 0;
			client.raw = async (method, path, body, headers) => {
				if (method === 'PUT' && path === '/v1/config' && ++puts === 2)
					return {
						status: answer,
						statusText: '',
						headers: answer === 429 ? { 'retry-after': '3' } : {},
						text: JSON.stringify({
							ok: false,
							error: { code: answer === 429 ? 'rate_limited' : 'oops', message: 'x' }
						})
					};
				return raw(method, path, body, headers);
			};
			const out = await shuffleOnServer(client, { maps: ORDER, when: 'now' });
			expect(puts).toBe(2);
			expect((await docRotation(client)).mode).toBe('ordered');
			if (answer === 429) {
				expect(out.message).toEndWith('turning it once more was refused for sending too fast.');
				expect(out.retryAfterMs).toBeGreaterThan(0);
			} else expect(out.message).toEndWith('It could not be turned once more.');
			process.env.MOCK_ROTATION_POINTER = 'entry';
		}
	});

	test('a document the server refuses is told by its status and code, never its words', async () => {
		const { client } = await playing(EVEN, 0);
		const raw = client.raw.bind(client);
		client.raw = async (method, path, body, headers) =>
			method === 'PUT' && path === '/v1/config'
				? {
						status: 400,
						statusText: 'Bad Request',
						headers: {},
						text: JSON.stringify({
							ok: false,
							error: { code: 'invalid', message: 'Password=hunter2 is not allowed here' },
							errors: [{ line: 3, message: 'Password=hunter2' }]
						})
					}
				: raw(method, path, body, headers);
		const err = await shuffleOnServer(client, { maps: ORDER, when: 'now' }).catch((e) => e);
		expect(err).toBeInstanceOf(GameError);
		expect([err.status, err.code, err.message, err.body]).toEqual([
			400,
			'invalid',
			'The server did not take the new rotation.',
			null
		]);
	});

	test('a read-only document is refused in the panel’s words; a conflict is tried once more', async () => {
		const client = clientFor();
		await setRotation(client, UNEVEN);
		const raw = client.raw.bind(client);
		let puts = 0;
		let conflicts = 1;
		let writable = false;
		client.raw = async (method, path, body, headers) => {
			const res = await raw(method, path, body, headers);
			if (method === 'GET' && path === '/v1/config' && !writable)
				return { ...res, text: JSON.stringify({ ...JSON.parse(res.text), writable: false }) };
			if (method === 'PUT' && path === '/v1/config' && puts++ < conflicts)
				return {
					...res,
					status: 412,
					text: JSON.stringify({ ok: false, error: { code: 'revision_mismatch', message: 'x' } })
				};
			return res;
		};
		const refused = await shuffleOnServer(client, { maps: ORDER, when: 'now' }).catch((e) => e);
		expect(refused).toBeInstanceOf(ApiError);
		expect(refused.message).toContain('read-only');
		writable = true;
		puts = 0;
		expect((await shuffleOnServer(client, { maps: ORDER, when: 'now' })).message).toContain(
			`Shuffled ${UNEVEN.length} entries`
		);
		expect(puts).toBe(2);
		puts = 0;
		conflicts = 2;
		const twice = await shuffleOnServer(client, { maps: ORDER, when: 'now' }).catch((e) => e);
		expect(twice).toBeInstanceOf(GameError);
		expect(twice.code).toBe('revision_conflict');
	});
});
