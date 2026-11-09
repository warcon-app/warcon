// Weather cycle end to end, on the worker's own looks at the mock game. Saved on, the rule changes
// the weather at the next look and again once its minutes have passed, the next lighting each time,
// each change in the trail as the rule's. A lighting the server does not list is kept as skipped,
// with no audit row, and nothing is sent; a change the game refuses is told in the panel's own words.
// Switched off, or edited, before it is sent, a change is dropped. The dry run replays the samples. Saving it needs Match control as well as Automation
// (access.test.ts); its changes that land stay off Discord (two-teams-discord.test.ts).
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { auditLog, organizations, outbox, samples, servers, triggers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer } from '$lib/server/observe';
import { startDelivery, stopDelivery } from '$lib/server/outbox';
import { WardogsClient } from '$lib/server/rcon';
import { invalidateTriggers } from '$lib/server/triggers';
import { lightingName, WEATHER_CYCLE } from '$lib/server/weather-cycle';
import type { Status } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway, type CallInput, type Outcome } from './call';
import { seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
const MIN = 60_000;
const until = async (ok: () => Promise<boolean>, ms = 20_000) => {
	const end = Date.now() + ms;
	while (!(await ok())) {
		if (Date.now() > end) throw new Error('timed out waiting for the delivery loop');
		await Bun.sleep(25);
	}
};

describe.skipIf(!hasTestDb)('Weather cycle', () => {
	let env: Env;
	let spy: ReturnType<typeof spyOn>;
	let renewing: ReturnType<typeof setInterval>;
	const seen: string[] = [];
	/** servers whose game refuses a change of lighting, in words that name an address */
	const refusing = new Set<string>();
	const gameOf = (serverId: string) =>
		new WardogsClient(
			env,
			{ id: serverId, host: 'demo', port: 1, scheme: 'http' },
			'demo',
			`weather-cycle-${serverId}`
		);

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		stubGateway();
		expect(await acquireOrRenew(env, 'weather-cycle')).toBe(true);
		renewing = setInterval(() => void acquireOrRenew(env, 'weather-cycle'), 5000);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = gameOf(server.id);
			if (!refusing.has(server.id)) return client;
			const raw = client.raw.bind(client);
			client.raw = async (method, path, body, headers) =>
				method === 'PUT' && path === '/v1/world/lighting'
					? {
							status: 400,
							statusText: 'Bad Request',
							headers: { 'content-type': 'application/json' },
							text: JSON.stringify({
								error: {
									code: 'lighting_not_allowed',
									message: 'Error: DayClear is not allowed on 10.9.8.7:7777.'
								}
							})
						}
					: raw(method, path, body, headers);
			return client;
		});
	});

	afterAll(async () => {
		clearInterval(renewing);
		await stopDelivery();
		spy?.mockRestore();
		for (const id of seen) forgetMemory(id);
		await releaseOwnership(env);
	});
	afterEach(() => stopDelivery());

	/** A server of its own and a Weather cycle rule its owner saves with these lightings. */
	async function setup(lightings: string[], more: Record<string, unknown> = {}) {
		const w: World = await seedWorld(env);
		const id = w.server.id;
		seen.push(id);
		const game = () => gameOf(id);
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
		const lighting = async () => ((await game().json('GET', '/v1/status')) as Status).lighting;
		// the server on a lighting none of the rule's are, so its first change is its first lighting
		await game().json('PUT', '/v1/world/lighting', { lighting: 'DayEndClear' });
		const made = await api('owner', 'POST api/servers/[id]/triggers', {
			body: {
				kind: 'weather_cycle',
				name: 'Weather',
				enabled: true,
				config: { lightings, everyMinutes: 5, ...more }
			}
		});
		expect(made.status).toBe(201);
		const ruleId = (made.body as { trigger: { id: string } }).trigger.id;
		const look = async () => {
			const [server] = await env.db.select().from(servers).where(eq(servers.id, id));
			const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
			await observeServer(env, memoryFor(server, org), { status: true, players: true });
		};
		const rowsOf = () =>
			env.db.select().from(outbox).where(eq(outbox.triggerId, ruleId)).orderBy(outbox.id);
		const rule = async () =>
			(await env.db.select().from(triggers).where(eq(triggers.id, ruleId)))[0];
		return {
			id,
			ruleId,
			api,
			look,
			lighting,
			rowsOf,
			rule,
			/** the rule's last change set back by this long, as if that much time had passed */
			wait: async (ms: number) => {
				const r = await rule();
				await env.db
					.update(triggers)
					.set({ lastFiredAt: new Date(r.lastFiredAt!.getTime() - ms) })
					.where(eq(triggers.id, ruleId));
				invalidateTriggers(id);
			},
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
					.where(and(eq(auditLog.action, 'trigger.weather_cycle'), eq(auditLog.serverId, id)))
		};
	}

	test('at the next look, then once its minutes have passed: the next lighting each time', async () => {
		const t = await setup(['DayClear', 'DayLateRain', 'DayLateGray']);
		await t.look();
		let rows = await t.rowsOf();
		expect(rows.map((r) => [r.action, r.state, r.target, r.params])).toEqual([
			[WEATHER_CYCLE, 'pending', 'Day Clear', { rule: expect.any(String), lighting: 'DayClear' }]
		]);
		expect((await t.rule()).lastResult).toBe('Changing to Day Clear');
		let r = await t.done(rows[0].id);
		expect([r.state, r.outcome]).toEqual(['delivered', 'Changed the weather to Day Clear.']);
		expect(await t.lighting()).toBe('DayClear');
		await until(async () => (await t.audited()).length > 0);
		expect(await t.audited()).toHaveLength(1);
		expect((await t.audited())[0]).toMatchObject({
			outcome: 'ok',
			actorName: 'trigger: Weather',
			target: 'Day Clear',
			category: 'trigger',
			message: 'Changed the weather to Day Clear.'
		});
		expect((await t.audited())[0].detail).toMatchObject({
			rconAction: WEATHER_CYCLE,
			lighting: 'DayClear',
			from: 'DayEndClear'
		});

		// within its minutes: nothing more
		await t.look();
		expect(await t.rowsOf()).toHaveLength(1);
		// five minutes on: the next one
		await t.wait(5 * MIN);
		await t.look();
		rows = await t.rowsOf();
		expect(rows.map((x) => x.target)).toEqual(['Day Clear', 'Day Late Rain']);
		r = await t.done(rows[1].id);
		expect([r.state, r.outcome]).toEqual(['delivered', 'Changed the weather to Day Late Rain.']);
		expect(await t.lighting()).toBe('DayLateRain');
		expect((await t.rule()).state).toEqual({ index: 1 });

		// someone sets the next one by hand: the rule passes over it
		await gameOf(t.id).json('PUT', '/v1/world/lighting', { lighting: 'DayLateGray' });
		await t.wait(5 * MIN);
		await t.look();
		rows = await t.rowsOf();
		expect(rows[2].target).toBe('Day Clear');
		expect((await t.done(rows[2].id)).state).toBe('delivered');
		expect(await t.lighting()).toBe('DayClear');
	}, 30_000);

	test('a lighting the server does not list: kept as skipped, nothing sent, no audit row', async () => {
		const t = await setup(['NightStorm', 'DayLateRain']);
		await t.look();
		const [row] = await t.rowsOf();
		expect(row.target).toBe(lightingName('NightStorm'));
		const r = await t.done(row.id);
		expect([r.state, r.outcome]).toEqual([
			'skipped',
			'Not sent: Night Storm is not among the lightings this server lists.'
		]);
		expect(await t.lighting()).toBe('DayEndClear');
		expect(await t.audited()).toEqual([]);
		// its next turn is the next lighting, which the server does list
		await t.wait(5 * MIN);
		await t.look();
		const rows = await t.rowsOf();
		expect((await t.done(rows[1].id)).state).toBe('delivered');
		expect(await t.lighting()).toBe('DayLateRain');
	}, 30_000);

	test('a change the game refuses is told in the panel’s own words, never the game’s', async () => {
		const t = await setup(['DayClear', 'DayLateRain']);
		refusing.add(t.id);
		await t.look();
		const [row] = await t.rowsOf();
		const r = await t.done(row.id);
		const phrase = 'Refused by the server (400, lighting_not_allowed).';
		expect([r.state, r.outcome]).toEqual(['failed', phrase]);
		await until(async () => (await t.audited()).length > 0);
		const [a] = await t.audited();
		expect([a.outcome, a.message]).toEqual(['error', phrase]);
		expect(JSON.stringify([r, a])).not.toContain('10.9.8.7');
		expect(await t.lighting()).toBe('DayEndClear');
		refusing.delete(t.id);
	}, 30_000);

	test('switched off, or edited, before it is sent: nothing is sent', async () => {
		const t = await setup(['DayClear', 'DayLateRain']);
		const patch = (body: Record<string, unknown>) =>
			t.api('owner', 'PATCH api/servers/[id]/triggers/[triggerId]', {
				params: { triggerId: t.ruleId },
				body
			});
		await t.look();
		const [queued] = await t.rowsOf();
		expect(queued.state).toBe('pending');
		expect((await patch({ enabled: false })).status).toBe(200);
		const [dropped] = await t.rowsOf();
		expect([dropped.state, dropped.outcome]).toEqual([
			'skipped',
			'The rule was changed before this was sent.'
		]);
		// off: no look changes anything
		await t.wait(10 * MIN);
		await t.look();
		expect(await t.rowsOf()).toHaveLength(1);
		expect(await t.lighting()).toBe('DayEndClear');

		// on again, a change queued, then the lightings edited: dropped as well
		expect((await patch({ enabled: true })).status).toBe(200);
		await t.look();
		expect((await t.rowsOf()).map((x) => x.state)).toEqual(['skipped', 'pending']);
		expect(
			(await patch({ config: { lightings: ['DayLateRain', 'DayEarlyFog'], everyMinutes: 5 } }))
				.status
		).toBe(200);
		expect((await t.rowsOf()).map((x) => x.state)).toEqual(['skipped', 'skipped']);
		// a rename keeps what is queued
		await t.wait(10 * MIN);
		await t.look();
		expect((await patch({ name: 'Rain and fog' })).status).toBe(200);
		const rows = await t.rowsOf();
		expect(rows.map((x) => x.state)).toEqual(['skipped', 'skipped', 'pending']);
		expect((await t.done(rows[2].id)).state).toBe('delivered');
		expect(await t.lighting()).toBe('DayLateRain');
	}, 30_000);

	test('the dry run replays the samples: a change at the first look with someone on', async () => {
		const t = await setup(['DayClear', 'DayLateRain']);
		await t.look();
		const res = await t.api('owner', 'POST api/servers/[id]/triggers/dry-run', {
			body: { kind: 'weather_cycle', config: { lightings: ['DayClear', 'DayLateRain'] } }
		});
		expect(res.status).toBe(200);
		const dry = (
			res.body as { result: { fires: number; items: { text: string }[]; notes: string[] } }
		).result;
		expect(dry.fires).toBe(1);
		expect(dry.items[0].text).toMatch(/^weather \(\d+ on\): Day End Clear → Day Clear$/);
		expect(dry.notes[0]).toContain('Times shown are the samples a change fell due at');
		// at random, it says so
		const random = await t.api('owner', 'POST api/servers/[id]/triggers/dry-run', {
			body: {
				kind: 'weather_cycle',
				config: { lightings: ['DayClear', 'DayLateRain'], random: true }
			}
		});
		expect((random.body as { result: { items: { text: string }[] } }).result.items[0].text).toMatch(
			/→ another at random$/
		);
		// a rule it refuses is refused here too
		const bad = await t.api('owner', 'POST api/servers/[id]/triggers/dry-run', {
			body: { kind: 'weather_cycle', config: { lightings: ['DayClear'] } }
		});
		expect([bad.status, bad.message]).toEqual([
			400,
			'Pick at least two lightings to change between.'
		]);
	}, 30_000);

	test('the dry run follows the server: each change from what it would show, a new map from its own', async () => {
		const t = await setup(['DayClear', 'DayLateRain', 'DayLateGray']);
		const t0 = Date.now() - 3 * 60 * MIN;
		const at = (minute: number, map: string, lighting: string, count = 10) => ({
			ts: new Date(t0 + minute * MIN),
			serverId: t.id,
			ok: true,
			playerCount: count,
			maxPlayers: 98,
			map,
			experiences: '',
			lighting,
			scores: []
		});
		await env.db.insert(samples).values([
			...[0, 5, 10, 15, 20, 25].map((m) => at(m, 'Kavkazi', 'DayClear')),
			at(30, 'Kavkazi', 'DayClear', 0),
			// the next map comes up on rain, its rotation entry's own
			...[35, 40, 45, 50].map((m) => at(m, 'Europe', 'DayLateRain'))
		]);
		const res = await t.api('owner', 'POST api/servers/[id]/triggers/dry-run', {
			body: {
				kind: 'weather_cycle',
				config: { lightings: ['DayClear', 'DayLateRain', 'DayLateGray'], everyMinutes: 10 }
			}
		});
		expect(res.status).toBe(200);
		const dry = (res.body as { result: { fires: number; items: { at: string; text: string }[] } })
			.result;
		expect(dry.items.map((i) => [(Date.parse(i.at) - t0) / MIN, i.text])).toEqual([
			[0, 'weather (10 on): Day Clear → Day Late Rain'],
			[10, 'weather (10 on): Day Late Rain → Day Late Gray'],
			[20, 'weather (10 on): Day Late Gray → Day Clear'],
			// the new map is on rain, the next in turn: passed over
			[35, 'weather (10 on): Day Late Rain → Day Late Gray'],
			[45, 'weather (10 on): Day Late Gray → Day Clear']
		]);
		expect(dry.fires).toBe(5);
	}, 30_000);
});
