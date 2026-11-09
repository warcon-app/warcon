// A Kick on connect risk rule's own list of players it never kicks: someone the rule would turn
// away (an old VAC ban, a new account, a note on the watchlist) let in by SteamID. On the worker's
// look at a server, end to end against the database and the mock game, a listed player stays
// however they come to be on (on before the rule, a join, a reconnect inside the leave grace, the
// sweep of everyone on) and anyone else the rule matches is kicked; the dry run leaves them out
// and counts them; and only those who may run the rule read the list.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import {
	organizations,
	outbox,
	playerMarks,
	playerSessions,
	servers,
	triggers
} from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer } from '$lib/server/observe';
import { WardogsClient } from '$lib/server/rcon';
import { validateConfig } from '$lib/server/trigger-rules';
import { invalidateTriggers, RISK_REKICK_MS } from '$lib/server/triggers';
import type { DryRunResult } from '$lib/types';
import { callApi, stubGateway } from './call';
import { hasTestDb, testEnv } from './db';
import { expected, outcomeOf } from './policy';
import { PRINCIPALS, seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
// all four on the watchlist, the first two listed on the rule
const REGULAR = '76561198000000711';
const REGULAR_TOO = '76561198000000712';
const WATCHED = '76561198000000713';
const WATCHED_TOO = '76561198000000714';
const PLAIN = '76561198000000715';
// as a server would set it up: reserved slots spared (the default), and the regulars let in
const RULE = { watchlist: true, exempt: [REGULAR, REGULAR_TOO], reason: 'no' };
const on = (...ids: string[]) =>
	ids.map((steamId) => ({ name: `p${steamId.slice(-3)}`, steamId, faction: null, kills: 0 }));

describe.skipIf(!hasTestDb)("the Kick on connect risk rule's players it never kicks", () => {
	let env: Env;
	let w: World;
	const lists = new Map<string, ReturnType<typeof on>>();
	let spy: ReturnType<typeof spyOn>;

	beforeAll(async () => {
		// no Steam: a developer's .env may hold a real key, and the watchlist needs none
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'risk-kick-exempt')).toBe(true);
		// The mock game answers everything but the player list, which the test scripts per server.
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`risk-kick-exempt-${server.id}`
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
		await env.db.insert(playerMarks).values(
			[REGULAR, REGULAR_TOO, WATCHED, WATCHED_TOO].map((steamId) => ({
				orgId: w.org.id,
				steamId,
				watched: true,
				reason: 'note'
			}))
		);
	});

	afterAll(async () => {
		spy.mockRestore();
		forgetMemory(w.server.id);
		await releaseOwnership(env);
	});

	test('on the worker look, a listed player stays and anyone else it matches is kicked', async () => {
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		const look = async (...ids: string[]) => {
			lists.set(server.id, on(...ids));
			m.playersIntervalMs = 1000;
			await observeServer(env, m, { status: true, players: true });
		};
		const kicksOf = async (steamId: string) =>
			(
				await env.db
					.select()
					.from(outbox)
					.where(and(eq(outbox.serverId, server.id), eq(outbox.steamId, steamId)))
			).filter((r) => r.action === 'kick');

		// on before the rule exists; its first look judges everyone on
		await look(PLAIN, REGULAR, WATCHED);
		await env.db.insert(triggers).values({
			id: newId(),
			serverId: server.id,
			orgId: w.org.id,
			kind: 'risk_kick',
			name: 'Kick on connect risk',
			enabled: true,
			config: validateConfig('risk_kick', RULE)
		});
		invalidateTriggers(server.id);
		await look(PLAIN, REGULAR, WATCHED);
		expect(await kicksOf(WATCHED)).toHaveLength(1);
		expect(await kicksOf(REGULAR)).toHaveLength(0);

		// joins
		await look(PLAIN, REGULAR, WATCHED, REGULAR_TOO, WATCHED_TOO);
		expect(await kicksOf(WATCHED_TOO)).toHaveLength(1);
		expect(await kicksOf(REGULAR_TOO)).toHaveLength(0);

		// off the list for a look and straight back, inside the leave grace: judged again
		await look(PLAIN);
		await look(PLAIN, REGULAR, REGULAR_TOO, WATCHED);
		expect(await kicksOf(WATCHED)).toHaveLength(2);
		// and at the sweep of everyone on, the watched player's last kick long enough ago
		m.riskKickedAt.set(WATCHED, Date.now() - RISK_REKICK_MS - 1);
		m.riskSweptAt = 0;
		await look(PLAIN, REGULAR, REGULAR_TOO, WATCHED);
		expect(await kicksOf(WATCHED)).toHaveLength(3);

		expect(await kicksOf(REGULAR)).toHaveLength(0);
		expect(await kicksOf(REGULAR_TOO)).toHaveLength(0);
		expect(await kicksOf(PLAIN)).toHaveLength(0);
	});

	test('the dry run leaves them out and says how many it left out', async () => {
		const at = new Date(Date.now() - 3_600_000);
		await env.db.insert(playerSessions).values(
			[REGULAR, WATCHED, PLAIN].map((steamId) => ({
				serverId: w.otherServer.id,
				steamId,
				name: `p${steamId.slice(-3)}`,
				joinedAt: at,
				lastSeen: at,
				leftAt: at
			}))
		);
		stubGateway({ reserved: [] });
		const { POST } = await import(join(ROUTES, 'servers/[id]/triggers/dry-run', '+server.ts'));
		const r = await callApi(POST, w.users.owner, {
			method: 'POST',
			params: { id: w.otherServer.id },
			body: { kind: 'risk_kick', config: RULE }
		});
		expect(r.status).toBe(200);
		const result = (r.body as { result: DryRunResult }).result;
		expect(result.items.map((i) => i.text)).toEqual([
			`kick p713 (${WATCHED}): on the watchlist (note)`
		]);
		expect(result.notes).toContain('1 more would be kicked but is a player it never kicks.');
	});

	test('only those who may run the rule read the list', async () => {
		stubGateway();
		const { GET } = await import(join(ROUTES, 'servers/[id]/triggers', '+server.ts'));
		for (const who of PRINCIPALS) {
			const answer = await callApi(GET, w.users[who], {
				method: 'GET',
				params: { id: w.server.id }
			});
			expect([who, outcomeOf(answer)]).toEqual([who, expected('cap:automation.manage', who)]);
			// the list goes to them and nobody else
			expect([who, JSON.stringify(answer.body).includes(REGULAR)]).toEqual([
				who,
				outcomeOf(answer) === 'ok'
			]);
		}
	});
});
