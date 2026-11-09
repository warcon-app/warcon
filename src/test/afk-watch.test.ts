// AFK watch end to end. On the worker's own looks (the player list and status scripted, the clock
// moved on between looks): the idle player is warned and then kicked, while a player at work, a
// reserved slot and a player on the rule's list are left alone. At delivery (a stand-in game): a
// warning or kick goes unless the player has played since (a kill, a death, cash earned; cash spent
// is no play), and is dropped once the rule is switched off; an alert-only rule's flag sends nothing
// to the game.
// The dry run says why it has nothing to replay.
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	setSystemTime,
	spyOn,
	test
} from 'bun:test';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import {
	auditLog,
	organizations,
	outbox,
	servers,
	triggers,
	type TriggerRow
} from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, memoryOf, observeServer } from '$lib/server/observe';
import { enqueueIntents, startDelivery, stopDelivery } from '$lib/server/outbox';
import { WardogsClient } from '$lib/server/rcon';
import { forgetRuleMemory, invalidateTriggers, type Intent } from '$lib/server/triggers';
import { AFK_WATCH_FLAG, afkWatchSettingsKey, validateAfkWatch } from '$lib/server/afk-watch';
import type { Player } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway, type CallInput, type Outcome } from './call';
import { seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
const MIN = 60_000;
const IDLE = '76561198000000921';
const BUSY = '76561198000000922';
const STAFF = '76561198000000923';
// on the mock game's reserved list from the start
const RESERVED = '76561198100000201';
const CONFIG = validateAfkWatch({
	minutes: 5,
	warnMinutes: 3,
	warnMessage: 'Idle {idle} min, {name}: play on or be kicked at {limit}.',
	minPlayers: 1,
	exempt: [STAFF],
	reason: 'AFK for {idle} minutes.'
});
const until = async (ok: () => Promise<boolean>, ms = 20_000) => {
	const end = Date.now() + ms;
	while (!(await ok())) {
		if (Date.now() > end) throw new Error('timed out waiting for the delivery loop');
		await Bun.sleep(25);
	}
};

describe.skipIf(!hasTestDb)('AFK watch on the worker’s looks', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	let clock = Date.now();
	/** what the scripted game says: each player's counters, and the scores */
	const game = { players: new Map<string, Player>(), scores: [12, 9] };
	const on = (steamId: string, kills = 0, deaths = 0, cash = 0) =>
		game.players.set(steamId, {
			name: `P${steamId.slice(-3)}`,
			steamId,
			faction: 'Valkyra',
			kills,
			deaths,
			cash,
			ping: 40
		});

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'afk-watch-live')).toBe(true);
		const json = (body: unknown) => ({
			status: 200,
			statusText: 'OK',
			headers: { 'content-type': 'application/json' },
			text: JSON.stringify(body)
		});
		// The mock game answers everything but the player list and the status, which the test scripts.
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`afk-watch-${server.id}`
			);
			const raw = client.raw.bind(client);
			client.raw = async (method, path, body, headers) => {
				const players = [...game.players.values()].map((p) => ({ ...p, pingMs: p.ping }));
				if (method === 'GET' && path === '/v1/players')
					return json({ players, count: players.length });
				if (method === 'GET' && path === '/v1/status')
					return json({
						serverName: 'AFK test',
						map: 'Kavkazi',
						experiences: [],
						players: { current: players.length, max: 98 },
						factionScores: [
							{ name: 'Valkyra', colorHex: '#D86060', score: game.scores[0] },
							{ name: 'Lonestar', colorHex: '#5B95D8', score: game.scores[1] }
						],
						rotation: { nowIndex: 0, nextIndex: 1 }
					});
				return raw(method, path, body, headers);
			};
			return client;
		});
	});

	afterAll(async () => {
		setSystemTime();
		spy.mockRestore();
		forgetMemory(w.server.id);
		forgetRuleMemory();
		await releaseOwnership(env);
	});

	/** The clock moved on, the worker still the owner. */
	const later = async (ms: number) => {
		clock += ms;
		setSystemTime(new Date(clock));
		expect(await acquireOrRenew(env, 'afk-watch-live')).toBe(true);
	};
	const look = async () => {
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		// a look a minute, so a minute between looks is no gap
		m.playersIntervalMs = MIN;
		await observeServer(env, m, { status: true, players: true });
	};
	const rowsOf = async (ruleId: string) =>
		(await env.db.select().from(outbox).where(eq(outbox.triggerId, ruleId)).orderBy(outbox.id)).map(
			(r) => [r.action, r.steamId, r.state]
		);
	const resultOf = async (ruleId: string) =>
		(await env.db.select().from(triggers).where(eq(triggers.id, ruleId)))[0].lastResult;

	test('warned at 3 minutes, kicked at 5: only the idle player, whoever else is on', async () => {
		setSystemTime(new Date(clock));
		const ruleId = newId();
		await env.db.insert(triggers).values({
			id: ruleId,
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'afk_watch',
			name: 'AFK watch',
			enabled: true,
			config: CONFIG
		});
		invalidateTriggers(w.server.id);
		on(IDLE);
		on(BUSY, 3, 1, 900);
		on(RESERVED);
		on(STAFF);
		for (let minute = 0; minute <= 6; minute++) {
			if (minute) await later(MIN);
			// the busy player earns something every minute
			on(BUSY, 3, 1, 900 + minute * 150);
			await look();
			const rows = await rowsOf(ruleId);
			if (minute < 3) expect([minute, rows]).toEqual([minute, []]);
			if (minute === 3) {
				expect(rows).toEqual([['whisper', IDLE, 'pending']]);
				expect(await resultOf(ruleId)).toBe(`Warning P${IDLE.slice(-3)}: idle 3 min`);
				const [warn] = await env.db.select().from(outbox).where(eq(outbox.triggerId, ruleId));
				expect(warn.params).toEqual({
					steamId: IDLE,
					message: `Idle 3 min, P${IDLE.slice(-3)}: play on or be kicked at 5.`,
					rule: afkWatchSettingsKey(CONFIG),
					seen: { kills: 0, deaths: 0, cash: 0 }
				});
			}
			if (minute >= 5)
				expect(rows).toEqual([
					['whisper', IDLE, 'pending'],
					['kick', IDLE, 'pending']
				]);
		}
		expect(await resultOf(ruleId)).toBe(`Kicking P${IDLE.slice(-3)}: idle 5 min`);
		// The reserved list was read from the game; the reserved player is on it.
		expect(memoryOf(w.server.id)?.reserved.has(RESERVED)).toBe(true);
		await env.db.delete(triggers).where(eq(triggers.id, ruleId));
		invalidateTriggers(w.server.id);
	});

	test('a side not yet scoring holds every clock at the start', async () => {
		const ruleId = newId();
		await env.db.insert(triggers).values({
			id: ruleId,
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'afk_watch',
			name: 'AFK watch',
			enabled: true,
			config: CONFIG
		});
		invalidateTriggers(w.server.id);
		game.scores = [0, 0];
		let cash = 2000;
		const minute = async () => {
			await later(MIN);
			on(BUSY, 3, 1, (cash += 150));
			await look();
		};
		for (let i = 0; i < 9; i++) await minute();
		expect(await rowsOf(ruleId)).toEqual([]);
		// a side scores: the time counts from here
		game.scores = [1, 0];
		for (let i = 0; i < 3; i++) await minute();
		expect(await rowsOf(ruleId)).toEqual([['whisper', IDLE, 'pending']]);
		game.scores = [12, 9];
		await env.db.delete(triggers).where(eq(triggers.id, ruleId));
		invalidateTriggers(w.server.id);
	});
});

describe.skipIf(!hasTestDb)('AFK watch at delivery', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	let renewing: ReturnType<typeof setInterval>;
	const requests: string[] = [];
	let ruleId: string;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		stubGateway();
		expect(await acquireOrRenew(env, 'afk-watch-delivery')).toBe(true);
		renewing = setInterval(() => void acquireOrRenew(env, 'afk-watch-delivery'), 5000);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		memoryFor(server, org);
		ruleId = `afk-watch-${w.server.id}`;
		await env.db.insert(triggers).values({
			id: ruleId,
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'afk_watch',
			name: 'AFK watch',
			enabled: true,
			config: CONFIG
		});
		invalidateTriggers(w.server.id);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(
			async () =>
				({
					json: async (method: string, path: string) => {
						requests.push(`${method} ${path}`);
						return { ok: true };
					}
				}) as unknown as WardogsClient
		);
	});

	afterAll(async () => {
		clearInterval(renewing);
		await stopDelivery();
		spy?.mockRestore();
		forgetMemory(w.server.id);
		await releaseOwnership(env);
	});
	afterEach(async () => {
		await stopDelivery();
		requests.length = 0;
		await env.db
			.update(triggers)
			.set({ enabled: true, config: CONFIG })
			.where(eq(triggers.id, ruleId));
	});

	async function api(
		who: PrincipalName,
		route: string,
		input: Omit<CallInput, 'method'> = {}
	): Promise<Outcome> {
		const [method, path] = route.split(' ');
		const mod = await import(join(ROUTES, path, '+server.ts'));
		return callApi(mod[method], w.users[who], { ...input, method });
	}
	/** What the worker last saw: the idle player with these counters, a live match. */
	const saw = (kills: number, deaths: number, cash: number) => {
		const m = memoryOf(w.server.id)!;
		m.players = [
			{ name: 'Sleepwalker', steamId: IDLE, faction: 'Valkyra', kills, deaths, cash, ping: 40 }
		];
		m.playersAt = Date.now();
		m.status = {
			serverName: 'AFK test',
			map: 'Kavkazi',
			experiences: [],
			lighting: '',
			alternator: '',
			scoreTick: null,
			scoreTickMin: null,
			scoreTickMax: null,
			scoreCap: null,
			matchSeconds: null,
			playerCount: 1,
			maxPlayers: 98,
			scores: [{ name: 'Valkyra', colorHex: '#ffffff', score: 12 }],
			rotationNow: 0,
			rotationNext: 1
		};
		m.statusAt = Date.now();
	};
	let seq = 0;
	/** Queues what the rule queues for the idle player, seen with no kill, death or cash. */
	const queue = async (action: 'whisper' | 'kick' | typeof AFK_WATCH_FLAG) => {
		const dedupeKey = `afk-watch-delivery-${seq++}`;
		const seen = { kills: 0, deaths: 0, cash: 0 };
		const rule = afkWatchSettingsKey(CONFIG);
		const intent: Intent = {
			trigger: { id: ruleId, name: 'AFK watch', kind: 'afk_watch' } as TriggerRow,
			action,
			params:
				action === 'whisper'
					? { steamId: IDLE, message: 'Idle 3 min.', rule, seen }
					: action === 'kick'
						? { steamId: IDLE, reason: 'AFK for 5 minutes.', rule, seen }
						: { rule, seen },
			target: IDLE,
			okMessage: 'Kicked Sleepwalker: no kill, death or cash earned for 5 min of a live match.',
			detail: { name: 'Sleepwalker', idleMinutes: 5 },
			steamId: IDLE,
			dedupeKey
		};
		await enqueueIntents(env.db, w.server.id, [intent]);
		const [row] = await env.db.select().from(outbox).where(eq(outbox.dedupeKey, dedupeKey));
		return row.id;
	};
	const done = async (id: number) => {
		startDelivery(env);
		await until(async () => {
			const [r] = await env.db.select().from(outbox).where(eq(outbox.id, id));
			return r.doneAt !== null;
		});
		const [r] = await env.db.select().from(outbox).where(eq(outbox.id, id));
		return r;
	};

	test('the warning and the kick go while the player is as the rule saw them', async () => {
		saw(0, 0, 0);
		const warned = await done(await queue('whisper'));
		const kicked = await done(await queue('kick'));
		expect([warned.state, kicked.state]).toEqual(['delivered', 'delivered']);
		expect(requests).toEqual([`POST /v1/players/${IDLE}/message`, `POST /v1/players/${IDLE}/kick`]);
	}, 30_000);

	test('a kill, a death or a dollar earned since, and neither goes', async () => {
		for (const [kills, deaths, cash] of [
			[1, 0, 0],
			[0, 1, 0],
			[0, 0, 150]
		]) {
			saw(kills, deaths, cash);
			for (const action of ['whisper', 'kick'] as const) {
				const r = await done(await queue(action));
				expect([kills, deaths, cash, action, r.state, r.outcome]).toEqual([
					kills,
					deaths,
					cash,
					action,
					'skipped',
					'Played again before this was sent.'
				]);
			}
		}
		expect(requests).toEqual([]);
	}, 60_000);

	test('cash spent since is no play: the kick goes', async () => {
		saw(0, 0, -400);
		const r = await done(await queue('kick'));
		expect(r.state).toBe('delivered');
		expect(requests).toEqual([`POST /v1/players/${IDLE}/kick`]);
	}, 30_000);

	test('switched off, a queued kick is dropped', async () => {
		saw(0, 0, 0);
		const id = await queue('kick');
		const off = await api('owner', 'PATCH api/servers/[id]/triggers/[triggerId]', {
			params: { id: w.server.id, triggerId: ruleId },
			body: { enabled: false }
		});
		expect(off.status).toBe(200);
		const [r] = await env.db.select().from(outbox).where(eq(outbox.id, id));
		expect([r.state, r.outcome]).toEqual(['skipped', 'The rule was changed before this was sent.']);
		expect(requests).toEqual([]);
	}, 30_000);

	test('an alert-only flag sends nothing to the game: the audit row is the delivery', async () => {
		saw(0, 0, 0);
		const r = await done(await queue(AFK_WATCH_FLAG));
		expect(r.state).toBe('delivered');
		expect(requests).toEqual([]);
		const audited = () =>
			env.db
				.select()
				.from(auditLog)
				.where(and(eq(auditLog.action, 'trigger.afk_watch'), eq(auditLog.serverId, w.server.id)));
		await until(async () => (await audited()).length > 0);
		expect((await audited()).at(-1)).toMatchObject({
			outcome: 'ok',
			actorName: 'trigger: AFK watch',
			target: IDLE
		});
	}, 30_000);

	test('the dry run says why there is nothing to replay', async () => {
		const got = await api('owner', 'POST api/servers/[id]/triggers/dry-run', {
			params: { id: w.server.id },
			body: { kind: 'afk_watch', config: CONFIG }
		});
		expect(got.status).toBe(200);
		const result = (got.body as { result: { fires: number; items: unknown[]; notes: string[] } })
			.result;
		expect([result.fires, result.items]).toEqual([0, []]);
		expect(result.notes[0]).toContain('cannot be replayed');
	});
});
