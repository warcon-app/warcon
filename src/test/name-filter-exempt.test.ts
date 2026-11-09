// A Name filter rule's own list of players it never acts on: a clan tag kept to a server's staff.
// On the worker's look at a server, end to end against the database and the mock game, a listed
// player wearing the blocked tag stays however their name arrives (a name that changes on the
// first look after a start, before any list has been read, a join, a reconnect inside the leave
// grace) and anyone else wearing it is kicked; the dry run leaves them out too; and only those
// who may run the rule can read the list. A rule that spares reserved slots instead acts on
// nobody until the worker has read who holds one.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import {
	organizations,
	outbox,
	playerSessions,
	samples,
	servers,
	triggers
} from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer } from '$lib/server/observe';
import { WardogsClient } from '$lib/server/rcon';
import { validateConfig } from '$lib/server/trigger-rules';
import { invalidateTriggers } from '$lib/server/triggers';
import type { DryRunResult } from '$lib/types';
import { callApi, stubGateway } from './call';
import { hasTestDb, testEnv } from './db';
import { expected, outcomeOf } from './policy';
import { PRINCIPALS, seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
const STAFF = '76561198000000701';
const STAFF_TOO = '76561198000000702';
const FAKE = '76561198000000703';
const FAKE_TOO = '76561198000000704';
const PLAIN = '76561198000000705';
// the tag kept to staff, the way the README says to set it up
const TAG_RULE = { blocked: ['nobs'], spareReserved: false, exempt: [STAFF, STAFF_TOO] };
const named = (...players: [string, string][]) =>
	players.map(([steamId, name]) => ({ name, steamId, faction: null, kills: 0 }));

describe.skipIf(!hasTestDb)("the Name filter's players it never acts on", () => {
	let env: Env;
	let w: World;
	const lists = new Map<string, ReturnType<typeof named>>();
	let spy: ReturnType<typeof spyOn>;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'name-filter-exempt')).toBe(true);
		// The mock game answers everything but the player list, which the test scripts per server.
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`name-filter-exempt-${server.id}`
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
		await releaseOwnership(env);
	});

	test('on the worker look, staff keep the tag and anyone else wearing it is kicked', async () => {
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		await env.db.insert(triggers).values({
			id: newId(),
			serverId: server.id,
			orgId: w.org.id,
			kind: 'name_filter',
			name: 'Name filter',
			enabled: true,
			config: validateConfig('name_filter', TAG_RULE)
		});
		invalidateTriggers(server.id);
		const look = async (...players: [string, string][]) => {
			lists.set(server.id, named(...players));
			const m = memoryFor(server, org);
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

		// on before the tag went up: a first look opens their sessions quietly
		await look([STAFF, 'Ramon'], [FAKE, 'Fake'], [PLAIN, 'Plain']);
		// the worker starts over: the sessions come back from the database, no list has been read,
		// and both now wear the tag
		forgetMemory(server.id);
		await look([STAFF, '[NoBS] Ramon'], [FAKE, '[NoBS] Fake'], [PLAIN, 'Plain']);
		expect(await kicksOf(FAKE)).toHaveLength(1);
		expect(await kicksOf(STAFF)).toHaveLength(0);

		// joins, the tag spelled another way
		await look(
			[STAFF, '[NoBS] Ramon'],
			[FAKE, '[NoBS] Fake'],
			[PLAIN, 'Plain'],
			[STAFF_TOO, '[N0BS] Second'],
			[FAKE_TOO, '[N0B$]Two']
		);
		expect(await kicksOf(FAKE_TOO)).toHaveLength(1);
		expect(await kicksOf(STAFF_TOO)).toHaveLength(0);

		// off the list for a look and straight back, inside the leave grace: judged again, still staff
		await look([PLAIN, 'Plain']);
		await look([STAFF, '[NoBS] Ramon'], [STAFF_TOO, '[N0BS] Second'], [PLAIN, 'Plain']);
		expect(await kicksOf(STAFF)).toHaveLength(0);
		expect(await kicksOf(STAFF_TOO)).toHaveLength(0);
		expect(await kicksOf(PLAIN)).toHaveLength(0);
	});

	test('the dry run leaves them out and says how many it left out', async () => {
		const at = new Date(Date.now() - 3_600_000);
		await env.db
			.insert(samples)
			.values({ serverId: w.otherServer.id, ts: at, ok: true, playerCount: 3, map: 'Bakurani' });
		await env.db.insert(playerSessions).values(
			(
				[
					[STAFF, '[NoBS] Ramon'],
					[FAKE, '[NoBS] Fake'],
					[PLAIN, 'Plain']
				] as const
			).map(([steamId, name]) => ({
				serverId: w.otherServer.id,
				steamId,
				name,
				joinedAt: at,
				lastSeen: at,
				leftAt: at
			}))
		);
		const gateway = stubGateway({ reserved: [] });
		const { POST } = await import(join(ROUTES, 'servers/[id]/triggers/dry-run', '+server.ts'));
		const r = await callApi(POST, w.users.owner, {
			method: 'POST',
			params: { id: w.otherServer.id },
			body: { kind: 'name_filter', config: TAG_RULE }
		});
		expect(r.status).toBe(200);
		const result = (r.body as { result: DryRunResult }).result;
		expect(result.items.map((i) => i.text)).toEqual([
			`kick [NoBS] Fake (${FAKE}): blocked word 'nobs'`
		]);
		expect(result.notes).toContain('1 more would match but is a player it never acts on.');
		// a rule that does not spare reserved slots reads none
		expect(gateway.runs).toEqual([]);
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
			expect([who, JSON.stringify(answer.body).includes(STAFF)]).toEqual([
				who,
				outcomeOf(answer) === 'ok'
			]);
		}
	});

	test('sparing reserved slots, it acts on nobody before the worker has read who holds one', async () => {
		// both on the mock game's reserved list from the start
		const [SLOT, SLOT_TOO] = ['76561198100000201', '76561198100000202'];
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.otherServer.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const id = newId();
		await env.db.insert(triggers).values({
			id,
			serverId: server.id,
			orgId: w.org.id,
			kind: 'name_filter',
			name: 'Name filter',
			enabled: true,
			config: validateConfig('name_filter', { blocked: ['nobs'], spareReserved: true })
		});
		invalidateTriggers(server.id);
		const look = async (...players: [string, string][]) => {
			lists.set(server.id, named(...players));
			const m = memoryFor(server, org);
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

		await look([SLOT, 'Ramon'], [FAKE, 'Fake']);
		// the worker starts over and both now wear the tag: who holds a slot is not known yet, so
		// neither is kicked (a wrong kick is worse than a name let by)
		forgetMemory(server.id);
		await look([SLOT, '[NoBS] Ramon'], [FAKE, '[NoBS] Fake']);
		expect(await kicksOf(SLOT)).toHaveLength(0);
		expect(await kicksOf(FAKE)).toHaveLength(0);
		const [rule] = await env.db.select().from(triggers).where(eq(triggers.id, id));
		expect(rule.lastResult).toBe('Waiting for the reserved slots to be read');

		// read at the end of that look: from the next one a slot is spared and anyone else kicked
		await look(
			[SLOT, '[NoBS] Ramon'],
			[FAKE, '[NoBS] Fake'],
			[SLOT_TOO, '[NoBS] Two'],
			[FAKE_TOO, '[NoBS] New']
		);
		expect(await kicksOf(FAKE_TOO)).toHaveLength(1);
		expect(await kicksOf(SLOT_TOO)).toHaveLength(0);
		expect(await kicksOf(SLOT)).toHaveLength(0);
		forgetMemory(server.id);
	});
});
