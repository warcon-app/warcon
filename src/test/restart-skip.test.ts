// Skip map after restart end to end, on the worker's own look at the mock game, which comes up on
// its start-up map after a restart (MOCK_STARTUP_MAP), off an infantry-only rotation. The run going
// when the rule is saved is left; the next restart queues one skip, which delivery sends: the
// start-up match ends, the top of the rotation comes up, and the trail has it as the rule's; the
// preview names the map it came up on. A restart onto a map the rotation has is kept as skipped,
// with no audit row. Switched off before it is sent, nothing is sent; switched on again, the rule
// waits for the next restart. Saving it needs Match control as well as Automation (access.test.ts).
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { auditLog, organizations, outbox, servers, triggers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer } from '$lib/server/observe';
import { startDelivery, stopDelivery } from '$lib/server/outbox';
import { GameError, WardogsClient } from '$lib/server/rcon';
import { readConfig } from '$lib/server/actions';
import { restartMock } from '$lib/server/mockgame';
import { invalidateTriggers } from '$lib/server/triggers';
import { rotationIntoText } from '$lib/rotation-doc';
import type { MapSelection } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway, type CallInput, type Outcome } from './call';
import { seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
const H = 3600_000;
const INFANTRY: MapSelection[] = [
	{
		map: 'Europe',
		experiences: ['Madrid_KOTH_01', 'KOTH_InfantryOnly'],
		lighting: 'DayEarlyFog',
		zoneAlternator: ''
	},
	{
		map: 'NorthAmerica',
		experiences: ['Detroit_KOTH_01', 'KOTH_InfantryOnly'],
		lighting: 'DayEndClear',
		zoneAlternator: ''
	}
];
/** the map the mock comes up on, as a rotation entry */
const STARTUP: MapSelection = {
	map: 'Kavkazi',
	experiences: ['Bakurani_KOTH_01'],
	lighting: 'DayClear',
	zoneAlternator: ''
};
const until = async (ok: () => Promise<boolean>, ms = 20_000) => {
	const end = Date.now() + ms;
	while (!(await ok())) {
		if (Date.now() > end) throw new Error('timed out waiting for the delivery loop');
		await Bun.sleep(25);
	}
};

describe.skipIf(!hasTestDb)('Skip map after restart', () => {
	let env: Env;
	let spy: ReturnType<typeof spyOn>;
	let renewing: ReturnType<typeof setInterval>;
	/** servers whose game is restarting: the listener does not answer */
	const down = new Set<string>();
	const seen: string[] = [];
	const was = process.env.MOCK_STARTUP_MAP;
	const gameOf = (serverId: string) =>
		new WardogsClient(
			env,
			{ id: serverId, host: 'demo', port: 1, scheme: 'http' },
			'demo',
			`restart-skip-${serverId}`
		);

	beforeAll(async () => {
		process.env.MOCK_STARTUP_MAP = 'true';
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		stubGateway();
		expect(await acquireOrRenew(env, 'restart-skip')).toBe(true);
		renewing = setInterval(() => void acquireOrRenew(env, 'restart-skip'), 5000);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			if (down.has(server.id)) throw new GameError(0, 'Connection refused.', 'unreachable');
			return gameOf(server.id);
		});
	});

	afterAll(async () => {
		clearInterval(renewing);
		await stopDelivery();
		spy?.mockRestore();
		for (const id of seen) forgetMemory(id);
		await releaseOwnership(env);
		if (was === undefined) delete process.env.MOCK_STARTUP_MAP;
		else process.env.MOCK_STARTUP_MAP = was;
	});
	afterEach(() => stopDelivery());

	/**
	 * A server of its own with an infantry-only rotation, up five hours on its start-up map, and a
	 * Skip map after restart rule its owner saves now.
	 */
	async function setup() {
		const w: World = await seedWorld(env);
		const id = w.server.id;
		seen.push(id);
		const game = () => gameOf(id);
		async function setRotation(entries: MapSelection[]) {
			const doc = await readConfig(game());
			const text = rotationIntoText(doc.text, { enabled: true, mode: 'ordered', entries });
			expect((await game().configCall('PUT', '/v1/config', text, doc.revision)).status).toBe(200);
		}
		async function api(
			who: PrincipalName,
			route: string,
			input: Omit<CallInput, 'method'> = {}
		): Promise<Outcome> {
			const [method, path] = route.split(' ');
			const mod = await import(join(ROUTES, path, '+server.ts'));
			const out = await callApi(mod[method], w.users[who], {
				...input,
				params: { id, ...input.params },
				method
			});
			invalidateTriggers(id);
			return out;
		}
		const look = async () => {
			const [server] = await env.db.select().from(servers).where(eq(servers.id, id));
			const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
			await observeServer(env, memoryFor(server, org), { status: true, players: true });
		};
		await setRotation(INFANTRY);
		restartMock(`restart-skip-${id}`, Date.now() - 5 * H);
		await look();
		const made = await api('owner', 'POST api/servers/[id]/triggers', {
			body: { kind: 'restart_skip', name: 'Skip the start-up map', enabled: true, config: {} }
		});
		expect(made.status).toBe(201);
		const ruleId = (made.body as { trigger: { id: string } }).trigger.id;
		const rowsOf = () =>
			env.db.select().from(outbox).where(eq(outbox.triggerId, ruleId)).orderBy(outbox.id);
		return {
			id,
			ruleId,
			setRotation,
			api,
			look,
			rowsOf,
			/**
			 * the game restarting, as at `at`: a look while it is down, then up on its start-up map (by
			 * default two seconds before the next look, which on a real server comes later still)
			 */
			restart: async (at = Date.now() - 2_000) => {
				down.add(id);
				await look();
				down.delete(id);
				restartMock(`restart-skip-${id}`, at);
			},
			rule: async () => (await env.db.select().from(triggers).where(eq(triggers.id, ruleId)))[0],
			/** the row once delivery has done with it */
			done: async (rowId: number) => {
				startDelivery(env);
				await until(async () => {
					const [r] = await env.db.select().from(outbox).where(eq(outbox.id, rowId));
					return r.doneAt !== null;
				});
				return (await env.db.select().from(outbox).where(eq(outbox.id, rowId)))[0];
			},
			audited: () =>
				env.db
					.select()
					.from(auditLog)
					.where(and(eq(auditLog.action, 'trigger.restart_skip'), eq(auditLog.serverId, id))),
			status: () =>
				game().json('GET', '/v1/status') as Promise<{
					map: string;
					experiences: string[];
					rotation: { nowIndex: number };
				}>
		};
	}

	test('the run going when it is saved is left; the next restart has its start-up match ended', async () => {
		const t = await setup();
		await t.look();
		expect(await t.rowsOf()).toEqual([]);
		const noted = (await t.rule()).state as { armedAt: number; boot: number };
		expect(noted.boot).toBeLessThan(Date.now() - 4 * H);
		expect((await t.status()).map).toBe('Kavkazi');

		await t.restart();
		await t.look();
		const rows = await t.rowsOf();
		expect(rows.map((r) => [r.action, r.state, r.target])).toEqual([
			['restart_skip', 'pending', 'Bakurani (Day Clear)']
		]);
		const r = await t.done(rows[0].id);
		expect([r.state, r.outcome]).toEqual([
			'delivered',
			'Skipped Bakurani (Day Clear), which the rotation does not have; Ozeti (Infantry Only, Day Early Fog) is next.'
		]);
		const now = await t.status();
		expect([now.map, now.experiences, now.rotation.nowIndex]).toEqual([
			'Europe',
			['Madrid_KOTH_01', 'KOTH_InfantryOnly'],
			0
		]);
		await until(async () => (await t.audited()).length > 0);
		expect(await t.audited()).toHaveLength(1);
		expect((await t.audited())[0]).toMatchObject({
			outcome: 'ok',
			actorName: 'trigger: Skip the start-up map',
			target: 'Bakurani (Day Clear)',
			category: 'trigger'
		});
		// the rule's count is written just after its audit row
		await until(async () => (await t.rule()).fireCount > 0);
		expect((await t.rule()).fireCount).toBe(1);
		// the rest of the run: nothing more
		await t.look();
		expect(await t.rowsOf()).toHaveLength(1);

		const res = await t.api('owner', 'POST api/servers/[id]/triggers/dry-run', {
			body: { kind: 'restart_skip', config: {} }
		});
		expect(res.status).toBe(200);
		const dry = (
			res.body as { result: { fires: number; items: { text: string }[]; notes: string[] } }
		).result;
		expect([dry.fires, dry.items.map((i) => i.text)]).toEqual([
			1,
			['after the restart: skip the map it comes up on']
		]);
		expect(dry.notes[0]).toContain('; it came up on Bakurani (Day Clear).');
	}, 30_000);

	test('a restart onto a map the rotation has: kept as skipped, with no audit row', async () => {
		const t = await setup();
		await t.setRotation([...INFANTRY, STARTUP]);
		await t.restart();
		await t.look();
		const rows = await t.rowsOf();
		expect(rows).toHaveLength(1);
		const r = await t.done(rows[0].id);
		expect([r.state, r.outcome]).toEqual([
			'skipped',
			'Bakurani (Day Clear) is in the rotation: nothing to skip.'
		]);
		expect((await t.status()).map).toBe('Kavkazi');
		expect(await t.audited()).toEqual([]);
	}, 30_000);

	test('switched off before it is sent, nothing is sent; switched on again, it waits for the next restart', async () => {
		const t = await setup();
		// saved an hour ago; the worker sees the restart five minutes late
		await env.db
			.update(triggers)
			.set({ updatedAt: new Date(Date.now() - H) })
			.where(eq(triggers.id, t.ruleId));
		invalidateTriggers(t.id);
		await t.restart(Date.now() - 5 * 60_000);
		await t.look();
		const [queued] = await t.rowsOf();
		expect([queued.action, queued.state]).toEqual(['restart_skip', 'pending']);
		const patch = (body: Record<string, unknown>) =>
			t.api('owner', 'PATCH api/servers/[id]/triggers/[triggerId]', {
				params: { triggerId: t.ruleId },
				body
			});
		expect((await patch({ enabled: false })).status).toBe(200);
		const [dropped] = await t.rowsOf();
		expect([dropped.state, dropped.outcome]).toEqual([
			'skipped',
			'The rule was changed before this was sent.'
		]);
		expect((await t.status()).map).toBe('Kavkazi');

		// on again: the run going now started before, so it is left
		expect((await patch({ enabled: true })).status).toBe(200);
		expect((await t.rule()).state).toBeNull();
		await t.look();
		expect(await t.rowsOf()).toHaveLength(1);
		expect((await t.status()).map).toBe('Kavkazi');
		// the next restart is its own again
		await t.restart();
		await t.look();
		const rows = await t.rowsOf();
		expect(rows).toHaveLength(2);
		expect((await t.done(rows[1].id)).state).toBe('delivered');
		expect((await t.status()).map).toBe('Europe');
	}, 30_000);
});
