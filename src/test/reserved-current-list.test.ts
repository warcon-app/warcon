// Who the rules count as holding a reserved slot: the server's list as the panel keeps it, the one
// in its config document, not the list a live build is running, which takes a change up only when
// the server next starts. A slot given in the panel is spared at once and one withdrawn is not, on
// the worker's own look (through the High ping kick, against the mock game as a live build) and in
// a dry run alike. Reading that list hands nobody anything of the document but whom it spares.
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
import { setGateway } from '$lib/server/gateway';
import { localGateway } from '$lib/server/gateway-local';
import { ACTIONS, readConfig } from '$lib/server/actions';
import { reservedFromText, reservedIntoText } from '$lib/reserved-doc';
import { validateConfig } from '$lib/server/trigger-rules';
import { invalidateTriggers } from '$lib/server/triggers';
import type { DryRunResult } from '$lib/types';
import { callApi, stubGateway } from './call';
import { hasTestDb, testEnv } from './db';
import { expected, outcomeOf } from './policy';
import { PRINCIPALS, seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
// running and in the config document of the mock game from the start
const WITHDRAWN = '76561198100000201';
const GIVEN = '76561198000000631';
const VISITOR = '76561198000000632';
const on = (...ids: string[]) =>
	ids.map((steamId) => ({
		name: `p${steamId.slice(-3)}`,
		steamId,
		faction: null,
		kills: 0,
		pingMs: 400
	}));

describe.skipIf(!hasTestDb)('the reserved slots the rules go by', () => {
	let env: Env;
	let w: World;
	const lists = new Map<string, ReturnType<typeof on>>();
	const build = process.env.MOCK_LIVE_BUILD;
	let spy: ReturnType<typeof spyOn>;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		// a live build: reserved slots go through the config document, taken up at the next start
		process.env.MOCK_LIVE_BUILD = 'true';
		expect(await acquireOrRenew(env, 'reserved-current-list')).toBe(true);
		// The mock game answers everything but the player list, which the test scripts per server.
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`reserved-list-${server.id}`
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
		if (build === undefined) delete process.env.MOCK_LIVE_BUILD;
		else process.env.MOCK_LIVE_BUILD = build;
	});

	test('a slot given in the panel is spared at once, one withdrawn is not, whatever the server runs', async () => {
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const client = await WardogsClient.forServer(env, server);
		// The panel gives GIVEN a slot and withdraws WITHDRAWN's: on a live build both changes wait in
		// the config document, and the running list stays as it was until the server restarts.
		const doc = await readConfig(client);
		const ids = [...reservedFromText(doc.text).filter((id) => id !== WITHDRAWN), GIVEN];
		await client.configCall('PUT', '/v1/config', reservedIntoText(doc.text, ids), doc.revision);
		const running = ((await ACTIONS.reserved.run(client, {})) as { reserved: string[] }).reserved;
		expect(running).toContain(WITHDRAWN);
		expect(running).not.toContain(GIVEN);

		// A High ping kick that spares reserved slots, all three over the limit for two minutes.
		const now = Date.now();
		const since = { since: now - 120_000, fired: false };
		await env.db.insert(triggers).values({
			id: newId(),
			serverId: server.id,
			orgId: w.org.id,
			kind: 'ping_kick',
			name: 'High ping kick',
			enabled: true,
			config: validateConfig('ping_kick', { maxPingMs: 200, spareReserved: true }),
			state: { lastAt: now, players: { [WITHDRAWN]: since, [GIVEN]: since, [VISITOR]: since } }
		});
		invalidateTriggers(server.id);
		const m = memoryFor(server, org);
		const look = async () => {
			lists.set(server.id, on(WITHDRAWN, GIVEN, VISITOR));
			m.playersIntervalMs = 30_000;
			await observeServer(env, m, { status: true, players: true });
		};
		const kicksOf = async (steamId: string) =>
			(
				await env.db
					.select()
					.from(outbox)
					.where(and(eq(outbox.serverId, server.id), eq(outbox.steamId, steamId)))
			).filter((r) => r.action === 'kick');

		// the first look reads the lists after the rules: the panel's list, not the running one
		await look();
		expect(m.reserved.has(GIVEN)).toBe(true);
		expect(m.reserved.has(WITHDRAWN)).toBe(false);

		await look();
		expect(await kicksOf(GIVEN)).toHaveLength(0);
		expect(await kicksOf(WITHDRAWN)).toHaveLength(1);
		expect(await kicksOf(VISITOR)).toHaveLength(1);

		// the minute's sync, with nothing to do, keeps the same list (from the snapshot the worker
		// wrote), never the running one
		m.syncAt = 0;
		await look();
		expect(m.reserved.has(GIVEN)).toBe(true);
		expect(m.reserved.has(WITHDRAWN)).toBe(false);
		expect(await kicksOf(GIVEN)).toHaveLength(0);
	});

	test('a dry run spares the same players: the list in the config document, else the running one', async () => {
		const RUNNING_ONLY = '76561198000000641';
		const DOC_ONLY = '76561198000000642';
		const at = new Date(Date.now() - 3_600_000);
		// the server was watched in the window, and two past players' names an ASCII-only filter refuses
		await env.db
			.insert(samples)
			.values({ serverId: w.otherServer.id, ts: at, ok: true, playerCount: 2, map: 'Bakurani' });
		await env.db.insert(playerSessions).values(
			[
				[RUNNING_ONLY, 'Ñandú'],
				[DOC_ONLY, 'Jürgen']
			].map(([steamId, name]) => ({
				serverId: w.otherServer.id,
				steamId,
				name,
				joinedAt: at,
				lastSeen: at,
				leftAt: at
			}))
		);
		const { POST } = await import(join(ROUTES, 'servers/[id]/triggers/dry-run', '+server.ts'));
		const run = async () => {
			const r = await callApi(POST, w.users.owner, {
				method: 'POST',
				params: { id: w.otherServer.id },
				body: {
					kind: 'name_filter',
					config: { characters: 'ascii', action: 'kick', spareReserved: true }
				}
			});
			expect(r.status).toBe(200);
			const result = (r.body as { result: DryRunResult }).result;
			return { texts: result.items.map((i) => i.text).join('\n'), notes: result.notes };
		};

		const gateway = stubGateway({ reserved: [RUNNING_ONLY], document: [DOC_ONLY] });
		const read = await run();
		expect(gateway.runs).toEqual([{ server: w.otherServer.id, action: 'reserved' }]);
		expect(read.texts).toContain(`kick Ñandú (${RUNNING_ONLY})`);
		expect(read.texts).not.toContain(DOC_ONLY);
		expect(read.notes).toContain('1 more would match but holds a reserved slot.');

		// a build that serves no document: the running list
		stubGateway({ reserved: [RUNNING_ONLY], document: null });
		const running = await run();
		expect(running.texts).toContain(`kick Jürgen (${DOC_ONLY})`);
		expect(running.texts).not.toContain(RUNNING_ONLY);
	});

	test('a dry run that reads the document hands no caller anything of it but whom it spares', async () => {
		// The real gateway against the mock game, whose document now holds what a live one does: the
		// RCON password and its hash, and the feed's token.
		setGateway(localGateway);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const client = await WardogsClient.forServer(env, server);
		const SECRETS = ['rcon-pw-7f3a91', 'pbkdf2$e0c4f5d2', 'feed-token-55aa', 'feed.example'];
		const SPARED = '76561198000000651';
		const doc = await readConfig(client);
		const text =
			reservedIntoText(doc.text, [...reservedFromText(doc.text), SPARED]).replace(
				'[/Script/WDRCON.WDRCONSettings]',
				`[/Script/WDRCON.WDRCONSettings]\r\nPassword=${SECRETS[0]}\r\nPasswordHash=${SECRETS[1]}`
			) + `\r\n[WDServerFeed]\r\nUrl=https://${SECRETS[3]}/ingest\r\nToken=${SECRETS[2]}\r\n`;
		await client.configCall('PUT', '/v1/config', text, doc.revision);
		const stored = (await readConfig(client)).text;
		for (const secret of SECRETS) expect(stored).toContain(secret);
		// SPARED is in the document's list, not the running one
		const running = ((await ACTIONS.reserved.run(client, {})) as { reserved: string[] }).reserved;
		expect(running).not.toContain(SPARED);

		const at = new Date(Date.now() - 3_600_000);
		await env.db
			.insert(samples)
			.values({ serverId: server.id, ts: at, ok: true, playerCount: 1, map: 'Bakurani' });
		await env.db.insert(playerSessions).values({
			serverId: server.id,
			steamId: SPARED,
			name: 'Ñoño',
			joinedAt: at,
			lastSeen: at,
			leftAt: at
		});
		const { POST } = await import(join(ROUTES, 'servers/[id]/triggers/dry-run', '+server.ts'));
		// every rule that reads the list in its dry run, and one that does not
		const rules: [string, Record<string, unknown>][] = [
			['name_filter', { characters: 'ascii', action: 'kick', spareReserved: true }],
			['risk_kick', { watchlist: true, spareReserved: true }],
			['name_change', { action: 'kick', spareReserved: true }],
			['seed_reward', { minutes: 1, scope: 'server' }],
			['ping_kick', { maxPingMs: 100, spareReserved: true }]
		];
		const leaked = (body: unknown) => {
			const json = JSON.stringify(body);
			return [...SECRETS, 'DefaultReservedPlayerIds', 'WDRCONSettings', '[/Script'].filter((x) =>
				json.includes(x)
			);
		};
		for (const [kind, config] of rules)
			for (const who of PRINCIPALS) {
				const answer = await callApi(POST, w.users[who], {
					method: 'POST',
					params: { id: server.id },
					body: { kind, config }
				});
				// whoever may run it gets the verdicts, everyone else the refusal the matrix expects
				expect([kind, who, outcomeOf(answer)]).toEqual([
					kind,
					who,
					expected('cap:automation.manage', who)
				]);
				expect([kind, who, leaked(answer.body)]).toEqual([kind, who, []]);
			}
		// and the list was read: the name filter spares SPARED for a slot only the document holds
		const filter = await callApi(POST, w.users.owner, {
			method: 'POST',
			params: { id: server.id },
			body: { kind: 'name_filter', config: rules[0][1] }
		});
		const result = (filter.body as { result: DryRunResult }).result;
		expect(JSON.stringify(result.items)).not.toContain(SPARED);
		expect(result.notes).toContain('1 more would match but holds a reserved slot.');
	});
});
