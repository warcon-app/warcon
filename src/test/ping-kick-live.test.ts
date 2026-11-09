// The High ping kick on the worker's own look, end to end against the database and the mock game:
// a rule that spares reserved slots never kicks a player on the game's reserved list, the first
// look after a start included, before the list has been read, and kicks the others once it has
// been; a rule that does not spare them kicks everyone over the limit at once.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, outbox, servers, triggers } from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer } from '$lib/server/observe';
import { WardogsClient } from '$lib/server/rcon';
import { validateConfig } from '$lib/server/trigger-rules';
import { invalidateTriggers } from '$lib/server/triggers';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const VISITOR = '76561198000000611';
// on the mock game's reserved list from the start
const RESERVED = '76561198100000201';
const on = (...ids: string[]) =>
	ids.map((steamId) => ({
		name: `p${steamId.slice(-3)}`,
		steamId,
		faction: null,
		kills: 0,
		pingMs: 400
	}));

describe.skipIf(!hasTestDb)('the High ping kick on a live look', () => {
	let env: Env;
	let w: World;
	const lists = new Map<string, ReturnType<typeof on>>();
	let spy: ReturnType<typeof spyOn>;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'ping-kick-live')).toBe(true);
		// The mock game answers everything but the player list, which the test scripts per server.
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`ping-kick-${server.id}`
			);
			const raw = client.raw.bind(client);
			client.raw = async (method, path, body, headers) =>
				method === 'GET' && path === '/v1/players'
					? {
							status: 200,
							statusText: 'OK',
							headers: { 'content-type': 'application/json' },
							text: JSON.stringify({ players: lists.get(server.id) ?? [] })
						}
					: raw(method, path, body, headers);
			return client;
		});
	});

	afterAll(async () => {
		spy.mockRestore();
		forgetMemory(w.server.id);
		forgetMemory(w.otherServer.id);
		await releaseOwnership(env);
	});

	/** A rule under which both players have been over the limit for two minutes as of now. */
	const rule = async (serverId: string, spareReserved: boolean) => {
		const id = newId();
		const now = Date.now();
		await env.db.insert(triggers).values({
			id,
			serverId,
			orgId: w.org.id,
			kind: 'ping_kick',
			name: 'High ping kick',
			enabled: true,
			config: validateConfig('ping_kick', { maxPingMs: 200, durationSeconds: 60, spareReserved }),
			state: {
				lastAt: now,
				players: {
					[RESERVED]: { since: now - 120_000, fired: false },
					[VISITOR]: { since: now - 120_000, fired: false }
				}
			}
		});
		invalidateTriggers(serverId);
		return id;
	};
	/** A fresh worker's memory of the server: nothing read from it yet, the reserved list included. */
	const watch = async (serverId: string) => {
		const [server] = await env.db.select().from(servers).where(eq(servers.id, serverId));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		const look = async (...ids: string[]) => {
			lists.set(serverId, on(...ids));
			// a slow cadence, so a slow look on a busy machine cannot break the streaks
			m.playersIntervalMs = 30_000;
			await observeServer(env, m, { status: true, players: true });
		};
		const kicksOf = async (steamId: string) =>
			(
				await env.db
					.select()
					.from(outbox)
					.where(and(eq(outbox.serverId, serverId), eq(outbox.steamId, steamId)))
			).filter((r) => r.action === 'kick');
		return { m, look, kicksOf };
	};
	const lastResultOf = async (id: string) =>
		(await env.db.select().from(triggers).where(eq(triggers.id, id)))[0].lastResult;

	test('a rule that spares reserved slots waits for the list, then kicks only the others', async () => {
		const id = await rule(w.server.id, true);
		const { m, look, kicksOf } = await watch(w.server.id);
		expect(m.reservedAt).toBe(0);

		// the first look reads the reserved list only after the rules: nobody is kicked
		await look(RESERVED, VISITOR);
		expect(await kicksOf(RESERVED)).toHaveLength(0);
		expect(await kicksOf(VISITOR)).toHaveLength(0);
		expect(await lastResultOf(id)).toBe('Waiting for the reserved slots to be read');
		expect(m.reservedAt).toBeGreaterThan(0);
		expect(m.reserved.has(RESERVED)).toBe(true);

		// read: the other player's kick goes, the reserved player stays
		await look(RESERVED, VISITOR);
		expect(await kicksOf(VISITOR)).toHaveLength(1);
		expect(await kicksOf(RESERVED)).toHaveLength(0);
		expect(await lastResultOf(id)).toBe(`Kicking p${VISITOR.slice(-3)}: high ping`);

		// still on at the next look (the kick not landed yet): neither is kicked again
		await look(RESERVED, VISITOR);
		expect(await kicksOf(VISITOR)).toHaveLength(1);
		expect(await kicksOf(RESERVED)).toHaveLength(0);
	});

	test('a rule that does not spare them kicks the reserved player at the first look', async () => {
		await rule(w.otherServer.id, false);
		const { look, kicksOf } = await watch(w.otherServer.id);
		await look(RESERVED, VISITOR);
		expect(await kicksOf(RESERVED)).toHaveLength(1);
		expect(await kicksOf(VISITOR)).toHaveLength(1);
	});
});
