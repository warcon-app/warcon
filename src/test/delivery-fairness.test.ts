// One server's deliveries never hold up another's: each server's rows go out in a chain of their
// own, a claim takes only a few of any one server's rows, and the loop never waits for a slow chain
// before claiming for the rest. A server that refuses the panel for sending too fast gets no more
// trigger actions until the time it gave. The game is a stand-in whose answers are set per server.
import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	spyOn,
	test
} from 'bun:test';
import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { auditLog, organizations, outbox, servers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, memoryOf } from '$lib/server/observe';
import { deliveryStats, startDelivery, stopDelivery } from '$lib/server/outbox';
import { GameError, WardogsClient } from '$lib/server/rcon';
import { resetSetting, saveSettings } from '$lib/server/settings';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

describe.skipIf(!hasTestDb)('delivery across servers', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	let renewing: ReturnType<typeof setInterval>;
	/** how long the stand-in game takes to answer, by server */
	const answerMs = new Map<string, number>();
	/** how many more requests the stand-in game refuses for sending too fast, by server */
	const refuse = new Map<string, number>();
	/** every request the stand-in game got, in the order they started */
	const sent: { serverId: string; request: string; message: string; at: number }[] = [];
	const open = new Map<string, number>();
	/** requests that started while another to the same server was still open */
	let overlaps = 0;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'delivery-fairness')).toBe(true);
		// the worker renews its lease as it runs; a slow run of these tests can outlast one lease
		renewing = setInterval(() => void acquireOrRenew(env, 'delivery-fairness'), 5000);
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		for (const id of [w.server.id, w.otherServer.id]) {
			const [server] = await env.db.select().from(servers).where(eq(servers.id, id));
			memoryFor(server, org);
		}
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(
			async (_env, server) =>
				({
					json: async (method: string, path: string, body?: { message?: string }) => {
						const n = (open.get(server.id) ?? 0) + 1;
						if (n > 1) overlaps++;
						open.set(server.id, n);
						sent.push({
							serverId: server.id,
							request: `${method} ${path}`,
							message: body?.message ?? '',
							at: Date.now()
						});
						const refusals = refuse.get(server.id) ?? 0;
						if (refusals) {
							refuse.set(server.id, refusals - 1);
							open.set(server.id, (open.get(server.id) ?? 1) - 1);
							const err = new GameError(
								429,
								'The game server is rate limiting this panel (Request rate exceeded); retry in 2 s.',
								'rate_limited'
							);
							err.retryAfterMs = 2000;
							throw err;
						}
						await Bun.sleep(answerMs.get(server.id) ?? 0);
						open.set(server.id, (open.get(server.id) ?? 1) - 1);
						return { ok: true };
					}
				}) as unknown as WardogsClient
		);
	});

	// The worker renews its ownership every few seconds; these tests outlast one lease together.
	beforeEach(async () => {
		expect(await acquireOrRenew(env, 'delivery-fairness')).toBe(true);
	});

	// A test that fails part-way must not leave its loop or its rows running into the next one.
	afterEach(async () => {
		stopDelivery();
		for (let i = 0; i < 400 && deliveryStats().chains > 0; i++) await Bun.sleep(25);
		await env.db
			.update(outbox)
			.set({ state: 'skipped', outcome: 'Left over by a test.', doneAt: new Date() })
			.where(
				and(
					inArray(outbox.serverId, [w.server.id, w.otherServer.id]),
					inArray(outbox.state, ['pending', 'sending'])
				)
			);
	});

	afterAll(async () => {
		clearInterval(renewing);
		stopDelivery();
		spy?.mockRestore();
		forgetMemory(w.server.id);
		forgetMemory(w.otherServer.id);
		await releaseOwnership(env);
	});

	let seq = 0;
	/** Queues one broadcast row per message on a server; returns their ids, oldest first. */
	const queue = async (serverId: string, messages: string[]) =>
		(
			await env.db
				.insert(outbox)
				.values(
					messages.map((message) => ({
						serverId,
						triggerName: 'Broadcast',
						triggerKind: 'broadcast',
						action: 'broadcast',
						params: { message },
						target: message,
						okMessage: 'Broadcast sent.',
						dedupeKey: `fairness-${seq++}`
					}))
				)
				.returning({ id: outbox.id })
		).map((r) => r.id);
	const rowsOf = async (ids: number[]) =>
		(await env.db.select().from(outbox).where(inArray(outbox.id, ids))).sort((a, b) => a.id - b.id);
	const until = async (ok: () => Promise<boolean>, ms = 15_000) => {
		const end = Date.now() + ms;
		while (!(await ok())) {
			if (Date.now() > end) throw new Error('timed out waiting for the delivery loop');
			await Bun.sleep(25);
		}
	};
	const settled = (ids: number[]) => async () =>
		(await rowsOf(ids)).every((r) => r.state !== 'pending' && r.state !== 'sending');

	test('a slow server holds up no other server', async () => {
		answerMs.set(w.server.id, 2500);
		answerMs.set(w.otherServer.id, 0);
		const slowRows = await queue(w.server.id, ['slow 1', 'slow 2']);
		startDelivery(env);
		await until(async () => sent.some((s) => s.message === 'slow 1'));
		// Queued while the slow server's chain has five seconds still to run.
		const queuedAt = Date.now();
		const [quick] = await queue(w.otherServer.id, ['quick']);
		await until(async () => (await rowsOf([quick]))[0].state === 'delivered');
		expect(Date.now() - queuedAt).toBeLessThan(4000);
		await until(settled(slowRows));
		expect((await rowsOf(slowRows)).map((r) => r.state)).toEqual(['delivered', 'delivered']);
	}, 30_000);

	test("a burst on one server does not fill a claim, and each server's rows go out in order", async () => {
		answerMs.set(w.server.id, 40);
		answerMs.set(w.otherServer.id, 0);
		const burst = Array.from({ length: 60 }, (_, i) => `burst ${i}`);
		const burstRows = await queue(w.server.id, burst);
		const [after] = await queue(w.otherServer.id, ['after the burst']);
		const from = sent.length;
		const overlapsBefore = overlaps;
		startDelivery(env);
		await until(settled([...burstRows, after]));
		const order = sent.slice(from).map((s) => s.message);
		// Claimed with the burst's first rows, not after the first fifty of them.
		expect(order.indexOf('after the burst')).toBeLessThan(3);
		expect(order.filter((m) => m.startsWith('burst'))).toEqual(burst);
		expect(overlaps - overlapsBefore).toBe(0);
		expect((await rowsOf([...burstRows, after])).every((r) => r.state === 'delivered')).toBe(true);
	}, 30_000);

	test('a send that outlasts its lease is not marked unknown by the passes that run meanwhile', async () => {
		await saveSettings(env, { outboxLeaseMs: 5000 }, null);
		try {
			answerMs.set(w.server.id, 6000);
			const [long] = await queue(w.server.id, ['longer than the lease']);
			startDelivery(env);
			await until(async () => (await rowsOf([long]))[0].doneAt !== null, 15_000);
			const [row] = await rowsOf([long]);
			expect([row.state, row.outcome]).toEqual(['delivered', 'Broadcast sent.']);
		} finally {
			stopDelivery();
			await resetSetting(env, 'outboxLeaseMs');
		}
	}, 30_000);

	test('no pass starts after stopDelivery, not even from a chain that ends later', async () => {
		answerMs.set(w.server.id, 1500);
		answerMs.set(w.otherServer.id, 0);
		const [first] = await queue(w.server.id, ['before the stop']);
		startDelivery(env);
		await until(async () => sent.some((s) => s.message === 'before the stop'));
		stopDelivery();
		const [late] = await queue(w.otherServer.id, ['after the stop']);
		// The running chain finishes its row; its end wakes no pass.
		await until(settled([first]));
		await Bun.sleep(1500);
		expect((await rowsOf([first, late])).map((r) => r.state)).toEqual(['delivered', 'pending']);
	}, 30_000);

	test('rows claimed by a pass that was stopped part-way go back unsent', async () => {
		answerMs.set(w.server.id, 0);
		// A send that lapsed long ago: the pass's lease sweep must lock it, and waits while a
		// transaction of the test's own holds it.
		const [lapsed] = await env.db
			.insert(outbox)
			.values({
				serverId: w.otherServer.id,
				triggerName: 'Broadcast',
				triggerKind: 'broadcast',
				action: 'broadcast',
				params: { message: 'lapsed' },
				target: 'lapsed',
				dedupeKey: `fairness-${seq++}`,
				state: 'sending',
				leaseUntil: new Date(Date.now() - 60_000)
			})
			.returning({ id: outbox.id });
		let taken!: () => void;
		let letGo!: () => void;
		const lockTaken = new Promise<void>((r) => (taken = r));
		const released = new Promise<void>((r) => (letGo = r));
		const holder = env.db.transaction(async (tx) => {
			await tx.execute(sql`SELECT id FROM outbox WHERE id = ${lapsed.id} FOR UPDATE`);
			taken();
			await released;
		});
		await lockTaken;
		try {
			const rows = await queue(w.server.id, [
				'claimed after the stop 1',
				'claimed after the stop 2'
			]);
			const from = sent.length;
			startDelivery(env);
			// The first pass starts at the first tick and waits on the lock inside its transaction.
			await Bun.sleep(1500);
			// As a worker shuts down: stop, wait for the pass caught claiming, then give the lease up.
			const stopping = stopDelivery();
			letGo();
			await holder;
			await stopping;
			await releaseOwnership(env);
			expect((await rowsOf([lapsed.id]))[0].state).toBe('unknown');
			expect((await rowsOf(rows)).map((r) => [r.state, r.attempts])).toEqual([
				['pending', 1],
				['pending', 1]
			]);
			expect(sent.slice(from)).toEqual([]);
		} finally {
			letGo();
			await holder.catch(() => {});
		}
	}, 30_000);

	test("a refusal for sending too fast fails its row, and that server's other rows wait out the time it gave", async () => {
		answerMs.set(w.server.id, 0);
		answerMs.set(w.otherServer.id, 0);
		refuse.set(w.server.id, 1);
		const since = new Date();
		const from = sent.length;
		const heldRows = await queue(
			w.server.id,
			Array.from({ length: 12 }, (_, i) => `held ${i}`)
		);
		const [free] = await queue(w.otherServer.id, ['not held']);
		startDelivery(env);
		await until(async () => sent.slice(from).some((s) => s.message === 'held 0'));
		const refusedAt = sent.slice(from).find((s) => s.message === 'held 0')!.at;
		// While the hold lasts, the rows claimed with the refused one wait as they are and the
		// server's later rows are not claimed at all.
		await Bun.sleep(1000);
		const during = await rowsOf(heldRows);
		expect(during.slice(1, 5).map((r) => [r.state, r.outcome])).toEqual(
			Array(4).fill(['pending', 'Waiting: the server asked the panel to slow down.'])
		);
		expect(during.slice(5).map((r) => [r.state, r.attempts])).toEqual(
			Array(7).fill(['pending', 0])
		);
		await until(settled([...heldRows, free]));
		const rows = await rowsOf(heldRows);
		expect([rows[0].state, rows[0].outcome]).toEqual([
			'failed',
			'The game server is rate limiting this panel (Request rate exceeded); retry in 2 s.'
		]);
		expect(rows.slice(1).every((r) => r.state === 'delivered')).toBe(true);
		expect((await rowsOf([free]))[0].state).toBe('delivered');
		const log = sent.slice(from);
		const later = log.filter((s) => s.serverId === w.server.id).slice(1);
		expect(later.map((s) => s.message)).toEqual(
			Array.from({ length: 11 }, (_, i) => `held ${i + 1}`)
		);
		expect(later[0].at - refusedAt).toBeGreaterThanOrEqual(1900);
		expect(log.find((s) => s.message === 'not held')!.at - refusedAt).toBeLessThan(1500);
		// The refusal is audited as a failure, as it always was; the rest as delivered.
		const trail = () =>
			env.db
				.select({ outcome: auditLog.outcome })
				.from(auditLog)
				.where(
					and(
						inArray(auditLog.serverId, [w.server.id, w.otherServer.id]),
						eq(auditLog.action, 'trigger.broadcast'),
						gte(auditLog.ts, since)
					)
				);
		await until(async () => (await trail()).length >= 13);
		const outcomes = (await trail()).map((a) => a.outcome);
		expect([outcomes.filter((o) => o === 'error').length, outcomes.length]).toEqual([1, 13]);
	}, 30_000);

	test('a server its observation holds is sent nothing until the hold ends', async () => {
		answerMs.set(w.server.id, 0);
		const from = sent.length;
		const heldAt = Date.now();
		memoryOf(w.server.id)!.holdUntil = heldAt + 2500;
		const rows = await queue(w.server.id, ['after the hold 1', 'after the hold 2']);
		startDelivery(env);
		await until(settled(rows));
		expect((await rowsOf(rows)).map((r) => r.state)).toEqual(['delivered', 'delivered']);
		const log = sent.slice(from);
		expect(log.map((s) => s.message)).toEqual(['after the hold 1', 'after the hold 2']);
		expect(log[0].at - heldAt).toBeGreaterThanOrEqual(2400);
	}, 30_000);

	test('a map reset whose rotation read is refused fails without sending anything more', async () => {
		answerMs.set(w.server.id, 0);
		refuse.set(w.server.id, 1);
		const from = sent.length;
		const [reset] = await env.db
			.insert(outbox)
			.values({
				serverId: w.server.id,
				triggerName: 'Empty reset',
				triggerKind: 'empty_reset',
				action: 'empty_reset',
				params: { map: 'Bakurani' },
				target: 'Bakurani',
				okMessage: 'Reset.',
				dedupeKey: `fairness-${seq++}`
			})
			.returning({ id: outbox.id });
		startDelivery(env);
		await until(settled([reset.id]));
		await Bun.sleep(300);
		const [row] = await rowsOf([reset.id]);
		expect([row.state, row.outcome]).toEqual([
			'failed',
			'The game server is rate limiting this panel (Request rate exceeded); retry in 2 s.'
		]);
		expect(sent.slice(from).map((s) => s.request)).toEqual(['GET /v1/rotation']);
		expect(deliveryStats().held).toBeGreaterThan(0);
	}, 30_000);

	test('a hold is noticed ahead of a player who is between maps, so the backlog is not churned', async () => {
		const AWAY = '76561198000000811';
		const m = memoryOf(w.server.id)!;
		const heldAt = Date.now();
		m.players = [];
		m.playersAt = heldAt;
		m.presence.loaded = true;
		m.presence.open.set(AWAY, {
			id: 1,
			steamId: AWAY,
			name: 'Away',
			hiddenName: null,
			anonymous: false,
			faction: null,
			kills: 0,
			deaths: 0,
			cash: 0,
			game: null,
			seedMs: 0,
			pendingSeedMs: 0,
			joinedAt: heldAt - 60_000,
			lastSeen: heldAt - 5000,
			writtenAt: heldAt - 5000,
			writtenTeam: null,
			writtenMode: '0:',
			firstVisit: false,
			lastFaction: null,
			team: null
		});
		m.holdUntil = heldAt + 3000;
		try {
			const ids = (
				await env.db
					.insert(outbox)
					.values(
						Array.from({ length: 12 }, (_, i) => ({
							serverId: w.server.id,
							triggerName: 'Welcome',
							triggerKind: 'welcome',
							action: 'whisper',
							params: { steamId: AWAY, message: `welcome ${i}` },
							target: AWAY,
							steamId: AWAY,
							okMessage: 'Whispered.',
							dedupeKey: `fairness-${seq++}`
						}))
					)
					.returning({ id: outbox.id })
			).map((r) => r.id);
			startDelivery(env);
			await until(async () => (await rowsOf(ids)).some((r) => r.attempts > 0));
			await Bun.sleep(700);
			const during = await rowsOf(ids);
			// The first claim notices the hold and goes back whole; nothing else is claimed.
			expect(during.slice(0, 5).map((r) => [r.state, r.outcome])).toEqual(
				Array(5).fill(['pending', 'Waiting: the server asked the panel to slow down.'])
			);
			expect(during.slice(5).map((r) => r.attempts)).toEqual(Array(7).fill(0));
		} finally {
			m.presence.open.delete(AWAY);
			m.playersAt = 0;
			m.holdUntil = 0;
		}
	}, 30_000);
});
