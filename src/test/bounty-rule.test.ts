// A Bounty rule as the worker runs it, against the database and a stand-in game: kills come in
// through the real ingest, which takes both players' sides from the sessions the worker's looks
// wrote; a run of kills without dying puts a bounty on a player while enough are on, announced to
// the server; a teammate, a suicide or the environment never ends it, an enemy's kill claims it,
// and the claimer's reserved slot goes on the list the rule names. A leave or a match end lapses
// it, a worker restart keeps it, any save of the rule calls it off. A Bounties webhook gets a card
// for each, with names and never a SteamID. The dry run replays the day's kills the same way.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { and, eq, isNull } from 'drizzle-orm';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import {
	auditLog,
	kills,
	listEntries,
	lists,
	matches,
	organizations,
	outbox,
	playerSessions,
	samples,
	servers,
	triggers,
	webhooks
} from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { onKillsIngested } from '$lib/server/feed-events';
import { ingestBatch } from '$lib/server/feed';
import {
	forgetMemory,
	memoryFor,
	observeServer,
	OFFLINE_AFTER_FAILURES,
	type ServerMemory
} from '$lib/server/observe';
import { startDelivery, stopDelivery } from '$lib/server/outbox';
import { WardogsClient } from '$lib/server/rcon';
import { closeAllSessions, LEAVE_GRACE_MS } from '$lib/server/sessions';
import { dryRun, invalidateTriggers, validateConfig } from '$lib/server/triggers';
import { BOUNTY_CLAIM, BOUNTY_LAPSE, BOUNTY_REWARD, forgetBounties } from '$lib/server/bounty';
import { encryptSecret } from '$lib/server/crypto';
import { newId } from '$lib/server/http';
import { resetWebhookQueues } from '$lib/server/webhook-delivery';
import { callApi, stubGateway, type CallInput, type Outcome } from './call';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
/** A route as a person calls it: `METHOD path` under src/routes. */
async function api(
	w: World,
	who: PrincipalName,
	route: string,
	input: Omit<CallInput, 'method'> = {}
): Promise<Outcome> {
	const [method, path] = route.split(' ');
	const mod = await import(join(ROUTES, path, '+server.ts'));
	return callApi(mod[method], w.users[who], { ...input, method });
}

// The mock game's scoreboard has Valkyra, Lonestar and Manticore.
const A = '76561198000000901'; // Valkyra
const B = '76561198000000902'; // Lonestar
const C = '76561198000000903'; // Lonestar
const D = '76561198000000904'; // Valkyra, A's teammate
const SIDE: Record<string, string> = {
	[A]: 'Valkyra',
	[B]: 'Lonestar',
	[C]: 'Lonestar',
	[D]: 'Valkyra'
};
const name = (steamId: string) => `p${steamId.slice(-3)}`;

let clock = 100;
/** One `killed` event as the game posts it. */
const ev = (killer: string | null, victim: string, o: { suicide?: boolean } = {}) => ({
	eventId: newId(),
	type: 'killed',
	eventTime: clock++,
	matchId: 'boot',
	mapName: 'Kavkazi',
	...(killer ? { killerName: name(killer), killerSteamId: killer } : {}),
	victimName: name(victim),
	victimSteamId: victim,
	cause: 'Id.Item.AK74M',
	distance: 4000,
	contextTags: o.suicide ? ['Meta.Progression.Context.Player.KillContext.Suicide'] : []
});

describe.skipIf(!hasTestDb)('Bounty rule, live', () => {
	let env: Env;
	let spy: ReturnType<typeof spyOn>;
	/** who the stand-in game lists, per server */
	const listed = new Map<string, string[]>();
	const broadcasts: [string, string][] = [];
	const whispers: [string, string, string][] = [];
	/** what reached Discord */
	const posts: { title: string; description: string }[] = [];
	const realFetch = globalThis.fetch;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		stubGateway();
		expect(await acquireOrRenew(env, 'bounty test')).toBe(true);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`bounty-${server.id}`
			);
			const raw = client.raw.bind(client);
			const ok = (text: string) => ({
				status: 200,
				statusText: 'OK',
				headers: { 'content-type': 'application/json' },
				text
			});
			client.raw = async (method, path, body, headers) => {
				if (method === 'GET' && path === '/v1/players')
					return ok(
						JSON.stringify({
							players: (listed.get(server.id) ?? []).map((steamId) => ({
								name: name(steamId),
								steamId,
								faction: SIDE[steamId],
								kills: 0
							}))
						})
					);
				if (method === 'POST' && path === '/v1/broadcast') {
					broadcasts.push([server.id, JSON.parse(body ?? '{}').message]);
					return ok('{"message":"Broadcast sent."}');
				}
				const whisper = /^\/v1\/players\/(\d{17})\/message$/.exec(path);
				if (method === 'POST' && whisper) {
					whispers.push([server.id, whisper[1], JSON.parse(body ?? '{}').message]);
					return ok('{"message":"Message sent."}');
				}
				return raw(method, path, body, headers);
			};
			return client;
		});
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			if (!String(url).includes('discord.test')) return realFetch(url, init);
			posts.push(...(JSON.parse(String(init?.body ?? '{}')).embeds ?? []));
			return new Response('{"id":"1"}', { status: 200 });
		}) as typeof fetch;
	});
	afterAll(async () => {
		await stopDelivery();
		spy.mockRestore();
		globalThis.fetch = realFetch;
		resetWebhookQueues();
		await releaseOwnership(env);
	});

	/** The worker's memory of a server, fresh. */
	const memoryOf = async (w: World): Promise<ServerMemory> => {
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		forgetMemory(server.id);
		return memoryFor(server, org);
	};
	/** A look at the server with these players on, their sides as SIDE has them. */
	const look = async (m: ServerMemory, ...on: string[]) => {
		listed.set(m.server.id, on);
		m.playersIntervalMs = 1000;
		await observeServer(env, m, { status: true, players: true });
		// the stand-in's scoreboard counts its own players; the rule reads the most anyone says is on
		m.status = { ...m.status!, playerCount: on.length };
	};
	const post = async (serverId: string, events: ReturnType<typeof ev>[]) => {
		const r = await ingestBatch(env, serverId, { serverId: 'i', serverName: 'x', events });
		await onKillsIngested(env, serverId, r.kills);
		return r;
	};
	const rule = async (w: World, config: Record<string, unknown>) => {
		const id = newId();
		await env.db.insert(triggers).values({
			id,
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'bounty',
			name: 'Bounty',
			enabled: true,
			config: validateConfig('bounty', config)
		});
		invalidateTriggers(w.server.id);
		return id;
	};
	const rowsOf = (triggerId: string) =>
		env.db.select().from(outbox).where(eq(outbox.triggerId, triggerId)).orderBy(outbox.id);
	const stateOf = async (triggerId: string) =>
		(
			await env.db
				.select({ state: triggers.state })
				.from(triggers)
				.where(eq(triggers.id, triggerId))
		)[0].state as { open: { steamId: string; streak: number; match: string } | null } | null;
	const rowOf = async (id: number) =>
		(await env.db.select().from(outbox).where(eq(outbox.id, id)))[0];
	/** Runs the delivery loop until the rows are done. */
	const deliver = async (...ids: number[]) => {
		startDelivery(env);
		for (let i = 0; i < 100; i++) {
			const rows = await Promise.all(ids.map(rowOf));
			if (rows.every((r) => r.state !== 'pending' && r.state !== 'sending')) break;
			await Bun.sleep(50);
		}
		await stopDelivery();
		return Promise.all(ids.map(rowOf));
	};
	const slotsOf = (w: World, steamId: string) =>
		env.db
			.select({ serverId: lists.serverId, expiresAt: listEntries.expiresAt })
			.from(listEntries)
			.innerJoin(lists, eq(lists.id, listEntries.listId))
			.where(
				and(
					eq(lists.orgId, w.org.id),
					eq(lists.kind, 'reserve'),
					eq(listEntries.steamId, steamId),
					isNull(listEntries.removedAt)
				)
			);
	const bountiesHook = (w: World) =>
		env.db.insert(webhooks).values({
			id: newId(),
			orgId: w.org.id,
			label: 'bounties',
			urlEnc: encryptSecret(env, 'https://discord.test/api/webhooks/1/bounties'),
			events: ['bounties'],
			serverIds: null
		});
	/** Discord posts go out in bursts, a second and a half after the first. */
	const postsSoon = async (n: number) => {
		for (let i = 0; i < 60 && posts.length < n; i++) await Bun.sleep(100);
		return posts;
	};

	test('a run sets a bounty; a teammate, a suicide and the environment do not end it; an enemy claims it and wins a slot here', async () => {
		const w = await seedWorld(env);
		await bountiesHook(w);
		posts.length = 0;
		const m = await memoryOf(w);
		await look(m, A, B, C, D);
		const id = await rule(w, {
			streak: 3,
			minPlayers: 2,
			slotDays: 2,
			scope: 'server',
			claimMessage: '{name} took {target} down after {streak}, for {reward}',
			whisper: 'Yours until {until}, {name}'
		});
		await post(w.server.id, [ev(A, B), ev(A, C)]);
		expect(await rowsOf(id)).toHaveLength(0);
		await post(w.server.id, [ev(A, B)]);
		const [set] = await rowsOf(id);
		expect(set).toMatchObject({
			action: 'broadcast',
			target: A,
			steamId: null,
			okMessage: 'Announced the bounty on p901 (3 kills).',
			params: {
				message: 'BOUNTY on p901: 3 kills without dying. Kill them for a reserved slot for 2 days.'
			}
		});
		expect((await stateOf(id))?.open).toMatchObject({ steamId: A, streak: 3 });
		// A's teammate, A's own death and the environment: no claim, the bounty stands
		await post(w.server.id, [ev(D, A)]);
		await post(w.server.id, [ev(A, A, { suicide: true })]);
		await post(w.server.id, [ev(null, A)]);
		expect(await rowsOf(id)).toHaveLength(1);
		expect((await stateOf(id))?.open?.steamId).toBe(A);
		// the panel's own view of the rule names the open bounty
		const view = await api(w, 'owner', 'GET api/servers/[id]/triggers', {
			params: { id: w.server.id }
		});
		const listedRule = (view.body as { triggers: { id: string; bounty: unknown }[] }).triggers.find(
			(t) => t.id === id
		);
		expect(listedRule?.bounty).toMatchObject({ steamId: A, name: 'p901', streak: 3 });
		// an enemy's kill claims it
		await post(w.server.id, [ev(B, A)]);
		const rows = await rowsOf(id);
		expect(rows.slice(1).map((r) => [r.action, r.target, r.steamId])).toEqual([
			[BOUNTY_CLAIM, B, null],
			['broadcast', B, null],
			[BOUNTY_REWARD, B, null],
			['whisper', B, B]
		]);
		expect(rows[1].okMessage).toBe('p902 claimed the bounty on p901 (a run of 3).');
		const until = new Date(Date.now() + 2 * 86400_000).toISOString().slice(0, 10);
		expect((rows[2].params as { message: string }).message).toBe(
			'p902 took p901 down after 3, for a reserved slot for 2 days'
		);
		expect((rows[4].params as { message: string }).message).toBe(`Yours until ${until}, p902`);
		expect((await stateOf(id))?.open).toBeNull();
		// delivered: the broadcasts and the whisper reach the game, the slot goes on this server's list
		const done = await deliver(...rows.map((r) => r.id));
		expect(done.map((r) => r.state)).toEqual(Array(5).fill('delivered'));
		expect(done[3].outcome).toBe(`Reserved a slot for p902 until ${until}.`);
		expect(broadcasts.filter(([s]) => s === w.server.id).map(([, t]) => t)).toEqual([
			'BOUNTY on p901: 3 kills without dying. Kill them for a reserved slot for 2 days.',
			'p902 took p901 down after 3, for a reserved slot for 2 days'
		]);
		expect(whispers.filter(([s]) => s === w.server.id)).toEqual([
			[w.server.id, B, `Yours until ${until}, p902`]
		]);
		const slots = await slotsOf(w, B);
		expect(slots.map((s) => s.serverId)).toEqual([w.server.id]);
		expect(Math.abs(slots[0].expiresAt!.getTime() - (Date.now() + 2 * 86400_000))).toBeLessThan(
			60_000
		);
		// the trail has the claim under the rule
		const audited = await env.db
			.select({ message: auditLog.message })
			.from(auditLog)
			.where(and(eq(auditLog.serverId, w.server.id), eq(auditLog.action, 'trigger.bounty')));
		expect(audited.map((a) => a.message)).toContain(
			'p902 claimed the bounty on p901 (a run of 3).'
		);
		// the Bounties channel: a card for each, names and never a SteamID
		const cards = await postsSoon(2);
		expect(cards.map((c) => c.title)).toEqual(['Bounty set', 'Bounty claimed']);
		expect(cards[0].description).toContain('**p901**: 3 kills without dying, for Valkyra');
		expect(cards[1].description).toContain("**p902** ended **p901**'s run at 3");
		expect(cards[1].description).toContain('Reward: a reserved slot for 2 days');
		for (const c of cards) expect(c.description).not.toMatch(/\d{17}/);
	});

	test('a claimer whose slot lasts longer keeps it; one whose slot ends sooner has it made to last; the org list when the rule says', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		await look(m, A, B, C, D);
		const id = await rule(w, { streak: 3, minPlayers: 2, slotDays: 3, scope: 'org' });
		await post(w.server.id, [ev(A, B), ev(A, C), ev(A, B), ev(C, A)]);
		const reward = (await rowsOf(id)).find((r) => r.action === BOUNTY_REWARD)!;
		expect(reward.params).toMatchObject({ steamId: C, scope: 'org', slotDays: 3 });
		const [first] = await deliver(reward.id);
		expect(first.state).toBe('delivered');
		expect((await slotsOf(w, C)).map((s) => s.serverId)).toEqual([null]);
		// claimed again: a slot as long already, kept as it is
		await post(w.server.id, [ev(A, B), ev(A, C), ev(A, B), ev(C, A)]);
		const again = (await rowsOf(id)).filter((r) => r.action === BOUNTY_REWARD)[1];
		const [kept] = await deliver(again.id);
		expect([kept.state, kept.outcome]).toEqual([
			'skipped',
			`p903 already holds a reserved slot in ${w.org.name} that lasts as long or longer.`
		]);
		// a slot that ends sooner is made to last as long
		await env.db
			.update(listEntries)
			.set({ expiresAt: new Date(Date.now() + 3600_000) })
			.where(eq(listEntries.steamId, C));
		await post(w.server.id, [ev(A, B), ev(A, C), ev(A, B), ev(C, A)]);
		const third = (await rowsOf(id)).filter((r) => r.action === BOUNTY_REWARD)[2];
		const [longer] = await deliver(third.id);
		expect(longer.outcome).toMatch(/^p903's reserved slot now lasts until /);
		const [slot] = await slotsOf(w, C);
		expect(slot.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 2 * 86400_000);
	}, 30_000);

	test('nobody is marked with too few on; one bounty at a time; any save of the rule calls it off', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		await look(m, A, B, C, D);
		const id = await rule(w, { streak: 3, minPlayers: 5, reward: 'none' });
		await post(w.server.id, [ev(A, B), ev(A, C), ev(A, B), ev(A, C)]);
		expect(await rowsOf(id)).toHaveLength(0);
		// fewer asked for: a save starts the runs over, so three more kills
		const patch = (body: Record<string, unknown>) =>
			api(w, 'owner', 'PATCH api/servers/[id]/triggers/[triggerId]', {
				params: { id: w.server.id, triggerId: id },
				body
			});
		expect((await patch({ config: { streak: 3, minPlayers: 2, reward: 'none' } })).status).toBe(
			200
		);
		invalidateTriggers(w.server.id);
		await post(w.server.id, [ev(A, B)]);
		expect(await rowsOf(id)).toHaveLength(0);
		await post(w.server.id, [ev(A, C), ev(A, B)]);
		const [set] = await rowsOf(id);
		expect((set.params as { message: string }).message).toBe(
			'BOUNTY on p901: 3 kills without dying. Who ends the run?'
		);
		// B on a run of three too: one bounty at a time
		await post(w.server.id, [ev(B, D), ev(B, D), ev(B, D)]);
		expect(await rowsOf(id)).toHaveLength(1);
		// a rename is a save: the bounty on A is called off
		expect((await patch({ name: 'Wanted' })).status).toBe(200);
		expect(await stateOf(id)).toBeNull();
		invalidateTriggers(w.server.id);
		await post(w.server.id, [ev(C, A)]);
		expect(await rowsOf(id)).toHaveLength(1);
	});

	test('a worker restart keeps the hunt; a leave and a match end lapse it', async () => {
		const w = await seedWorld(env);
		await bountiesHook(w);
		posts.length = 0;
		const m = await memoryOf(w);
		await look(m, A, B, C, D);
		const id = await rule(w, { streak: 3, minPlayers: 2, reward: 'none' });
		await post(w.server.id, [ev(A, B), ev(A, C), ev(A, B)]);
		// restarted: the runs are gone, the bounty is read back from the rule's row
		forgetBounties();
		invalidateTriggers(w.server.id);
		await post(w.server.id, [ev(C, A)]);
		expect((await rowsOf(id)).map((r) => r.action)).toEqual(['broadcast', BOUNTY_CLAIM]);
		// B marked, then gone: a look while they are within the leave grace keeps it
		await post(w.server.id, [ev(B, A), ev(B, D), ev(B, A)]);
		expect((await stateOf(id))?.open?.steamId).toBe(B);
		await look(m, A, C, D);
		expect((await stateOf(id))?.open?.steamId).toBe(B);
		m.presence.open.get(B)!.lastSeen = Date.now() - LEAVE_GRACE_MS - 1000;
		await look(m, A, C, D);
		const lapse = (await rowsOf(id)).at(-1)!;
		expect([lapse.action, lapse.target, lapse.okMessage]).toEqual([
			BOUNTY_LAPSE,
			B,
			'The bounty on p902 lapsed: they left the server (a run of 3).'
		]);
		expect((await stateOf(id))?.open).toBeNull();
		// A marked, then the match ends
		await look(m, A, B, C, D);
		await post(w.server.id, [ev(A, B), ev(A, C), ev(A, B)]);
		expect((await stateOf(id))?.open?.steamId).toBe(A);
		m.lastMatch = { map: 'Elsewhere', scores: [], matchSeconds: null };
		await look(m, A, B, C, D);
		expect((await rowsOf(id)).at(-1)!.okMessage).toBe(
			'The bounty on p901 lapsed: the match ended (a run of 3).'
		);
		// the runs started over with the match: two more kills mark nobody
		await post(w.server.id, [ev(A, B), ev(A, C)]);
		expect((await stateOf(id))?.open).toBeNull();
		const [done] = await deliver(lapse.id);
		expect(done.state).toBe('delivered');
		const cards = await postsSoon(6);
		expect(cards.map((c) => c.title)).toEqual([
			'Bounty set',
			'Bounty claimed',
			'Bounty set',
			'Bounty lapsed',
			'Bounty set',
			'Bounty lapsed'
		]);
		expect(cards[3].description).toContain('**p902** left the server on a run of 3');
		expect(cards[5].description).toContain('The match ended with **p901** on a run of 3');
	});

	test('a bounty read back after a restart is not claimed in a later match: it lapses', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		// the look opens the match the kills are stamped with
		await look(m, A, B, C, D);
		const id = await rule(w, { streak: 3, minPlayers: 2 });
		await post(w.server.id, [ev(A, B), ev(A, C), ev(A, B)]);
		const [open] = await env.db
			.select({ id: matches.id })
			.from(matches)
			.where(and(eq(matches.serverId, w.server.id), isNull(matches.endedAt)));
		expect((await stateOf(id))?.open).toMatchObject({ steamId: A, match: `m${open.id}` });
		// the worker restarts; meanwhile the match ends and the next one opens
		forgetBounties();
		invalidateTriggers(w.server.id);
		await env.db.update(matches).set({ endedAt: new Date() }).where(eq(matches.id, open.id));
		await env.db
			.insert(matches)
			.values({ serverId: w.server.id, startedAt: new Date(), map: 'Kavkazi' });
		await post(w.server.id, [ev(B, A)]);
		const rows = await rowsOf(id);
		expect(rows.map((r) => r.action)).toEqual(['broadcast', BOUNTY_LAPSE]);
		expect(rows[1].okMessage).toBe('The bounty on p901 lapsed: the match ended (a run of 3).');
		expect((await stateOf(id))?.open).toBeNull();
		// the runs started over with it: B's kill there is one, not a claim's leftover
		await post(w.server.id, [ev(B, C), ev(B, D)]);
		expect(await rowsOf(id)).toHaveLength(2);
	});

	test('the first look after the server was out of reach lapses it as such, not as a leave', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		await look(m, A, B, C, D);
		const id = await rule(w, { streak: 3, minPlayers: 2, reward: 'none' });
		await post(w.server.id, [ev(A, B), ev(A, C), ev(A, B)]);
		expect((await stateOf(id))?.open?.steamId).toBe(A);
		// out of reach for a few looks: the worker closes every session and forgets the match
		await closeAllSessions(env.db, m.presence);
		m.failures = OFFLINE_AFTER_FAILURES;
		m.lastMatch = null;
		await look(m, A, B, C, D);
		const lapse = (await rowsOf(id)).at(-1)!;
		expect([lapse.action, lapse.okMessage]).toEqual([
			BOUNTY_LAPSE,
			'The bounty on p901 lapsed: the server was out of reach (a run of 3).'
		]);
		expect((await stateOf(id))?.open).toBeNull();
	});

	test("the rule acts on its own server's kills only", async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		await look(m, A, B, C, D);
		const id = await rule(w, { streak: 3, minPlayers: 0 });
		await post(w.otherServer.id, [ev(A, B), ev(A, C), ev(A, B)]);
		expect(await rowsOf(id)).toHaveLength(0);
	});

	test('the dry run replays the day: bounties set with enough on, claimed, lapsed at a match end and at a leave', async () => {
		const w = await seedWorld(env);
		const now = Date.now();
		const t = (minutes: number) => new Date(now - 6 * 3600_000 + minutes * 60_000);
		const [m1] = await env.db
			.insert(matches)
			.values({ serverId: w.server.id, startedAt: t(-10), endedAt: t(30), map: 'Kavkazi' })
			.returning({ id: matches.id });
		const [m2] = await env.db
			.insert(matches)
			.values({ serverId: w.server.id, startedAt: t(30), map: 'Kavkazi' })
			.returning({ id: matches.id });
		await env.db.insert(samples).values([
			{ serverId: w.server.id, ts: t(-5), ok: true, playerCount: 4 },
			{ serverId: w.server.id, ts: t(4), ok: true, playerCount: 40 }
		]);
		let n = 0;
		const row = (
			minute: number,
			match: number,
			killer: string | null,
			victim: string,
			teamKill = false
		) => ({
			ts: t(minute),
			serverId: w.server.id,
			eventId: `dry-${++n}`,
			instanceId: 'i',
			matchId: 'boot',
			matchRow: match,
			eventTime: n,
			map: 'Kavkazi',
			killerSteamId: killer,
			killerName: killer ? name(killer) : null,
			killerFaction: killer ? SIDE[killer] : null,
			victimSteamId: victim,
			victimName: name(victim),
			victimFaction: SIDE[victim],
			cause: 'Id.Item.AK74M',
			distanceM: 40,
			headshot: false,
			suicide: false,
			teamKill,
			tags: []
		});
		await env.db.insert(kills).values([
			// four on: A's run of three marks nobody
			row(1, m1.id, A, B),
			row(2, m1.id, A, C),
			row(3, m1.id, A, B),
			// forty on: marked at the next kill, a teammate's kill does not claim, B's does
			row(5, m1.id, A, C),
			row(6, m1.id, D, A, true),
			row(7, m1.id, B, A),
			// C marked, then the match ends
			row(10, m1.id, C, A),
			row(11, m1.id, C, D),
			row(12, m1.id, C, A),
			row(31, m2.id, A, B),
			// D marked, then leaves
			row(40, m2.id, D, B),
			row(41, m2.id, D, C),
			row(42, m2.id, D, B)
		]);
		await env.db.insert(playerSessions).values({
			serverId: w.server.id,
			steamId: D,
			name: name(D),
			joinedAt: t(0),
			lastSeen: t(43),
			leftAt: t(43)
		});
		const config = { streak: 3, minPlayers: 20, slotDays: 1 };
		const r = await dryRun(
			env,
			(await env.db.select().from(servers).where(eq(servers.id, w.server.id)))[0],
			'bounty',
			config
		);
		expect(r.fires).toBe(3);
		expect(r.items.map((i) => i.text)).toEqual([
			'bounty on p901 (4 kills, 40 on): BOUNTY on p901: 4 kills without dying. Kill them for a reserved slot for 1 day.',
			'claimed by p902: p901 after a run of 4, a reserved slot for 1 day',
			'bounty on p903 (3 kills, 40 on): BOUNTY on p903: 3 kills without dying. Kill them for a reserved slot for 1 day.',
			'lapsed: the match ended, p903 on a run of 3',
			'bounty on p904 (3 kills, 40 on): BOUNTY on p904: 3 kills without dying. Kill them for a reserved slot for 1 day.',
			'lapsed: p904 left (a run of 3)'
		]);
		expect(r.notes).toContain(
			"3 bounties set, 1 claimed, 2 lapsed. Runs start over at each match, and nobody is marked while the server's samples show fewer than 20 on."
		);
	});
});
