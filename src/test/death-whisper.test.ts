// A Death whisper rule as the worker runs it, against the database and a stand-in game: a player
// the kill feed reports killed is whispered one of the rule's messages, filled with who killed them
// and with what. Not again inside the cooldown, which a worker restart keeps (read back from the
// outbox, with the message they had); never a player on the rule's list, nor one with a slot it
// spares (nobody until the list is read); nobody while too few are on. A whisper that cannot go
// within 30 seconds is dropped. One that goes leaves no audit row and no Discord card; one that
// fails leaves both. The dry run replays the day's deaths the same way.
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import {
	auditLog,
	kills,
	organizations,
	outbox,
	samples,
	serverLive,
	servers,
	triggers,
	webhooks
} from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetDeathWhispers, onKillsIngested } from '$lib/server/feed-events';
import { ingestBatch } from '$lib/server/feed';
import { forgetMemory, memoryFor, observeServer, type ServerMemory } from '$lib/server/observe';
import { deliveryStats, startDelivery, stopDelivery } from '$lib/server/outbox';
import { WardogsClient } from '$lib/server/rcon';
import { dryRun, invalidateTriggers, validateConfig } from '$lib/server/triggers';
import { encryptSecret } from '$lib/server/crypto';
import { newId } from '$lib/server/http';
import { resetWebhookQueues } from '$lib/server/webhook-delivery';
import { stubGateway } from './call';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const A = '76561198000000961';
const B = '76561198000000962';
const C = '76561198000000963';
const D = '76561198000000964';
const SIDE: Record<string, string> = {
	[A]: 'Valkyra',
	[B]: 'Lonestar',
	[C]: 'Lonestar',
	[D]: 'Valkyra'
};
const name = (steamId: string) => `p${steamId.slice(-3)}`;

let clock = 100;
/** One `killed` event as the game posts it; no killer is the environment. */
const ev = (killer: string | null, victim: string) => ({
	eventId: newId(),
	type: 'killed',
	eventTime: clock++,
	matchId: 'boot',
	mapName: 'Kavkazi',
	...(killer ? { killerName: name(killer), killerSteamId: killer } : {}),
	victimName: name(victim),
	victimSteamId: victim,
	cause: 'Id.Item.AK74M',
	distance: 15260,
	contextTags: []
});

describe.skipIf(!hasTestDb)('Death whisper rule, live', () => {
	let env: Env;
	let spy: ReturnType<typeof spyOn>;
	/** who the stand-in game lists, per server */
	const listed = new Map<string, string[]>();
	/** the players in the game's anonymous mode, and the hidden name the others see for each */
	const hiddenAs = new Map<string, string>();
	/** players whose whisper the stand-in refuses */
	const refuse = new Set<string>();
	const whispers: [string, string, string][] = [];
	/** what reached Discord */
	const titles: string[] = [];
	const realFetch = globalThis.fetch;

	// The worker's lease lasts fifteen seconds and is taken once for the file, which runs about
	// that long: every test starts with it renewed, so a slow machine does not lose it part-way.
	beforeEach(async () => {
		expect(await acquireOrRenew(env, 'death whisper test')).toBe(true);
	});

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		stubGateway();
		expect(await acquireOrRenew(env, 'death whisper test')).toBe(true);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`death-${server.id}`
			);
			const raw = client.raw.bind(client);
			const answer = (status: number, body: unknown) => ({
				status,
				statusText: status === 200 ? 'OK' : 'Bad Request',
				headers: { 'content-type': 'application/json' },
				text: JSON.stringify(body)
			});
			client.raw = async (method, path, body, headers) => {
				if (method === 'GET' && path === '/v1/players')
					return answer(200, {
						players: (listed.get(server.id) ?? []).map((steamId) => ({
							name: name(steamId),
							steamId,
							faction: SIDE[steamId],
							// Season 3: everyone has a hidden name, and it is in use for some
							hiddenName: hiddenAs.get(steamId) ?? 'Quail',
							anonymous: hiddenAs.has(steamId),
							kills: 0,
							deaths: 0,
							cash: 0
						}))
					});
				const whisper = /^\/v1\/players\/(\d{17})\/message$/.exec(path);
				if (method === 'POST' && whisper) {
					if (refuse.has(whisper[1]))
						return answer(400, {
							ok: false,
							error: { code: 'message_refused', message: `Refused for ${whisper[1]} at 10.0.0.9` }
						});
					whispers.push([server.id, whisper[1], JSON.parse(body ?? '{}').message]);
					return answer(200, { message: 'Message sent.' });
				}
				return raw(method, path, body, headers);
			};
			return client;
		});
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			if (!String(url).includes('discord.test')) return realFetch(url, init);
			for (const e of JSON.parse(String(init?.body ?? '{}')).embeds ?? []) titles.push(e.title);
			return new Response('{"id":"1"}', { status: 200 });
		}) as typeof fetch;
	});
	/** the servers whose memory the file made: every file shares the worker and the database */
	const watched = new Set<string>();
	afterAll(async () => {
		await stopDelivery();
		// Whispers a test queued and never delivered would go out from the next file's delivery loop,
		// to its stand-in game: they are dropped, and the servers forgotten, as other rules' tests do.
		if (watched.size)
			await env.db
				.update(outbox)
				.set({ state: 'skipped', outcome: 'Test over.', doneAt: new Date() })
				.where(and(inArray(outbox.serverId, [...watched]), sql`${outbox.state} = 'pending'`));
		for (const id of watched) forgetMemory(id);
		forgetDeathWhispers();
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
		watched.add(server.id);
		return memoryFor(server, org);
	};
	/** A look at the server with these players on. */
	const look = async (m: ServerMemory, ...on: string[]) => {
		listed.set(m.server.id, on);
		m.playersIntervalMs = 1000;
		await observeServer(env, m, { status: true, players: true });
		m.status = { ...m.status!, playerCount: on.length };
	};
	const post = async (serverId: string, events: ReturnType<typeof ev>[]) => {
		const r = await ingestBatch(env, serverId, { serverId: 'i', serverName: 'x', events });
		await onKillsIngested(env, serverId, r.kills);
		return r;
	};
	const rule = async (w: World, config: Record<string, unknown>, ruleName = 'Death whisper') => {
		const id = newId();
		await env.db.insert(triggers).values({
			id,
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'death_whisper',
			name: ruleName,
			enabled: true,
			config: validateConfig('death_whisper', config)
		});
		invalidateTriggers(w.server.id);
		return id;
	};
	const rowsOf = (triggerId: string) =>
		env.db.select().from(outbox).where(eq(outbox.triggerId, triggerId)).orderBy(outbox.id);
	const rowOf = async (id: number) =>
		(await env.db.select().from(outbox).where(eq(outbox.id, id)))[0];
	const ruleRow = async (id: string) =>
		(await env.db.select().from(triggers).where(eq(triggers.id, id)))[0];
	/**
	 * Runs the delivery loop until the rows are done and their chains have ended: a row's state is
	 * written first, the trail and the rule's count after it, and a test reads those next.
	 */
	const deliver = async (...ids: number[]) => {
		startDelivery(env);
		for (let i = 0; i < 100; i++) {
			const rows = await Promise.all(ids.map(rowOf));
			const done = rows.every((r) => r.state !== 'pending' && r.state !== 'sending');
			if (done && !deliveryStats().chains) break;
			await Bun.sleep(50);
		}
		await stopDelivery();
		return Promise.all(ids.map(rowOf));
	};
	const trail = (w: World) =>
		env.db
			.select({ outcome: auditLog.outcome, target: auditLog.target, message: auditLog.message })
			.from(auditLog)
			.where(and(eq(auditLog.serverId, w.server.id), eq(auditLog.action, 'trigger.death_whisper')));
	const automationHook = (w: World) =>
		env.db.insert(webhooks).values({
			id: newId(),
			orgId: w.org.id,
			label: 'automation',
			urlEnc: encryptSecret(env, 'https://discord.test/api/webhooks/1/automation'),
			events: ['triggers'],
			serverIds: null
		});

	test('a player killed is whispered, filled with who killed them; not again inside the cooldown', async () => {
		const w = await seedWorld(env);
		await automationHook(w);
		titles.length = 0;
		const m = await memoryOf(w);
		await look(m, A, B, C, D);
		const id = await rule(w, {
			messages: ['{killer} got you with the {weapon} from {distance} m, {name}. Join our Discord.'],
			exempt: [C]
		});
		// B killed by A, C on the rule's list, D by the environment, B again in the same batch
		await post(w.server.id, [ev(A, B), ev(A, C), ev(null, D), ev(D, B)]);
		const rows = await rowsOf(id);
		expect(rows.map((r) => [r.action, r.target, r.steamId])).toEqual([
			['whisper', B, B],
			['whisper', D, D]
		]);
		expect(rows.map((r) => (r.params as { message: string }).message)).toEqual([
			'p961 got you with the AK74 from 153 m, p962. Join our Discord.',
			' got you with the AK74 from 153 m, p964. Join our Discord.'
		]);
		expect(rows[0].okMessage).toBe('Whispered p962.');
		// the detail names the player and which message, never the text
		expect(rows[0].detail).toMatchObject({ name: 'p962', index: 0 });
		expect(JSON.stringify(rows[0].detail)).not.toContain('Discord');
		expect((await ruleRow(id)).lastResult).toBe('Whispering 2 players');
		// B again, and A for the first time: only A
		await post(w.server.id, [ev(C, B), ev(B, A)]);
		expect((await rowsOf(id)).map((r) => r.target)).toEqual([B, D, A]);

		// delivered: to the game, as the panel's own words, with no audit row and no Discord card
		const done = await deliver(...(await rowsOf(id)).map((r) => r.id));
		expect(done.map((r) => [r.state, r.outcome])).toEqual([
			['delivered', 'Whispered p962.'],
			['delivered', 'Whispered p964.'],
			['delivered', 'Whispered p961.']
		]);
		expect(whispers.filter(([s]) => s === w.server.id).map(([, to]) => to)).toEqual([B, D, A]);
		expect(await trail(w)).toEqual([]);
		const after = await ruleRow(id);
		expect([after.fireCount, after.lastResult]).toEqual([3, 'Whispered p961.']);
		await Bun.sleep(2000);
		expect(titles.filter((t) => t === 'Trigger · death whisper')).toEqual([]);
	});

	test('a killer in anonymous mode is named as the player who died knows them', async () => {
		const w = await seedWorld(env);
		hiddenAs.set(A, 'Falcon');
		try {
			const m = await memoryOf(w);
			await look(m, A, B, C, D);
			const id = await rule(w, { messages: ['{killer} got you, {name} [{steamid}]'] });
			// B killed by A, who is anonymous; then A, by B: the whisper to A is A's own
			await post(w.server.id, [ev(A, B)]);
			await post(w.server.id, [ev(B, A)]);
			const rows = await rowsOf(id);
			expect(rows.map((r) => [r.target, (r.params as { message: string }).message])).toEqual([
				[B, `Falcon got you, p962 [${B}]`],
				[A, `p962 got you, p961 [${A}]`]
			]);
			// the trail is the staff's: who was whispered, by their own name
			expect(rows.map((r) => r.okMessage)).toEqual(['Whispered p962.', 'Whispered p961.']);
			// A leaves and the kill arrives a moment later: still inside the grace, still hidden
			listed.set(m.server.id, [B, C, D]);
			await observeServer(env, m, { status: true, players: true });
			expect(m.players.map((p) => p.steamId)).not.toContain(A);
			await post(w.server.id, [ev(A, C)]);
			const late = (await rowsOf(id)).find((r) => r.target === C)!;
			expect((late.params as { message: string }).message).toBe(`Falcon got you, p963 [${C}]`);
		} finally {
			hiddenAs.clear();
		}
	});

	test('a Team kill limit names the victim to the killer as the game shows them', async () => {
		const w = await seedWorld(env);
		hiddenAs.set(C, 'Heron');
		try {
			const m = await memoryOf(w);
			await look(m, A, B, C, D);
			const id = newId();
			await env.db.insert(triggers).values({
				id,
				serverId: w.server.id,
				orgId: w.org.id,
				kind: 'team_kill',
				name: 'Team kill limit',
				enabled: true,
				config: validateConfig('team_kill', {
					warnAt: 1,
					warnMessage: 'You shot {victim}, {name}: {count} so far',
					kickAt: 2,
					kickReason: 'Team kills: {victim} was the last ({count})'
				})
			});
			invalidateTriggers(w.server.id);
			// B and C are both Lonestar; C is in anonymous mode
			await post(w.server.id, [ev(B, C)]);
			await post(w.server.id, [ev(B, C)]);
			const rows = await rowsOf(id);
			expect(rows.map((r) => r.action)).toEqual(['whisper', 'kick']);
			expect((rows[0].params as { message: string }).message).toBe(
				'You shot Heron, p962: 1 so far'
			);
			expect((rows[1].params as { reason: string }).reason).toBe(
				'Team kills: Heron was the last (2)'
			);
			// the trail keeps who it was
			expect(rows[0].detail).toMatchObject({ name: 'p962', victim: 'p963', count: 1 });
		} finally {
			hiddenAs.clear();
		}
	});

	test('a killer who has left the mode goes by their own name again, on the list and off it', async () => {
		const w = await seedWorld(env);
		hiddenAs.set(A, 'Falcon');
		try {
			const m = await memoryOf(w);
			await look(m, A, B, C, D);
			const id = await rule(w, { messages: ['{killer} got you, {name}'] });
			// A switches the mode off: the next look sees them under their own name
			hiddenAs.delete(A);
			await look(m, A, B, C, D);
			await post(w.server.id, [ev(A, B)]);
			// then A is off the list for a moment, as everyone is at a map change. The session keeps
			// the hidden name it was played under, and that it was no longer the one in use.
			listed.set(m.server.id, [B, C, D]);
			await observeServer(env, m, { status: true, players: true });
			expect(m.players.map((p) => p.steamId)).not.toContain(A);
			expect(m.presence.open.get(A)).toMatchObject({ hiddenName: 'Falcon', anonymous: false });
			await post(w.server.id, [ev(A, C)]);
			const rows = await rowsOf(id);
			expect(rows.map((r) => [r.target, (r.params as { message: string }).message])).toEqual([
				[B, 'p961 got you, p962'],
				[C, 'p961 got you, p963']
			]);
		} finally {
			hiddenAs.clear();
		}
	});

	test('a worker that has not looked yet goes by the list the one before it stored, while that is fresh', async () => {
		const w = await seedWorld(env);
		hiddenAs.set(C, 'Heron');
		try {
			// the worker before this one saw C in anonymous mode, and stored the list
			await look(await memoryOf(w), A, B, C, D);
			const id = newId();
			await env.db.insert(triggers).values({
				id,
				serverId: w.server.id,
				orgId: w.org.id,
				kind: 'team_kill',
				name: 'Team kill limit',
				enabled: true,
				config: validateConfig('team_kill', {
					warnAt: 1,
					warnMessage: 'You shot {victim}, {name}: {count} so far',
					kickAt: 3,
					kickReason: 'Team kills: {victim} was the last ({count})'
				})
			});
			invalidateTriggers(w.server.id);
			// this one has just started: it holds no list, and its first look is still to come
			const fresh = await memoryOf(w);
			expect([fresh.playersAt, fresh.players.length]).toEqual([0, 0]);
			await post(w.server.id, [ev(B, C)]);
			const said = async () =>
				(await rowsOf(id)).map((r) => (r.params as { message: string }).message);
			expect(await said()).toEqual(['You shot Heron, p962: 1 so far']);
			// a stored list too old to mean the same players is not gone by
			await env.db
				.update(serverLive)
				.set({ playersAt: new Date(Date.now() - 10 * 60_000) })
				.where(eq(serverLive.serverId, w.server.id));
			await post(w.server.id, [ev(B, C)]);
			expect(await said()).toEqual([
				'You shot Heron, p962: 1 so far',
				'You shot p963, p962: 2 so far'
			]);
		} finally {
			hiddenAs.clear();
		}
	});

	test('a whisper the game refuses is in the audit trail and on Discord, in fixed words', async () => {
		const w = await seedWorld(env);
		await automationHook(w);
		titles.length = 0;
		const m = await memoryOf(w);
		await look(m, A, B);
		const id = await rule(w, { messages: ['Hello {name}'] });
		refuse.add(B);
		try {
			await post(w.server.id, [ev(A, B)]);
			const [row] = await deliver(...(await rowsOf(id)).map((r) => r.id));
			expect([row.state, row.outcome]).toEqual([
				'failed',
				'Refused by the server (400, message_refused).'
			]);
		} finally {
			refuse.delete(B);
		}
		const kept = await trail(w);
		expect(kept).toEqual([
			{ outcome: 'error', target: B, message: 'Refused by the server (400, message_refused).' }
		]);
		// the game's own words, which named an address, are nowhere
		expect(JSON.stringify(kept)).not.toContain('10.0.0.9');
		for (let i = 0; i < 40 && !titles.length; i++) await Bun.sleep(100);
		expect(titles).toContain('Trigger · death whisper');
	});

	test('a whisper that cannot go within 30 seconds is dropped, unaudited', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		await look(m, A, B);
		const id = await rule(w, { messages: ['Hello {name}'] });
		await post(w.server.id, [ev(A, B)]);
		const [queued] = await rowsOf(id);
		await env.db
			.update(outbox)
			.set({ createdAt: sql`now() - interval '31 seconds'` })
			.where(eq(outbox.id, queued.id));
		const [row] = await deliver(queued.id);
		expect(row.state).toBe('skipped');
		expect(row.outcome).toMatch(/^Stale \(3[12]s old\)\.$/);
		expect(whispers.filter(([s]) => s === w.server.id)).toEqual([]);
		expect(await trail(w)).toEqual([]);
	});

	test('a worker restart keeps the cooldown and the message each player had last', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		await look(m, A, B, C);
		const id = await rule(w, { messages: ['one', 'two'], cooldownMinutes: 10 });
		const random = spyOn(Math, 'random').mockReturnValue(0);
		try {
			await post(w.server.id, [ev(A, B)]);
			const [first] = await rowsOf(id);
			expect((first.params as { message: string }).message).toBe('one');
			// a restart: the memory is gone, the outbox row is not
			forgetDeathWhispers();
			await post(w.server.id, [ev(A, B)]);
			expect((await rowsOf(id)).map((r) => r.target)).toEqual([B]);
			// past the cooldown, and forgotten once more: the next is the other message, whatever the pick
			await env.db
				.update(outbox)
				.set({ createdAt: sql`now() - interval '11 minutes'` })
				.where(eq(outbox.id, first.id));
			forgetDeathWhispers();
			await post(w.server.id, [ev(A, B), ev(B, C)]);
			const rows = await rowsOf(id);
			expect(rows.map((r) => [r.target, (r.params as { message: string }).message])).toEqual([
				[B, 'one'],
				[B, 'two'],
				[C, 'one']
			]);
		} finally {
			random.mockRestore();
		}
	});

	test('a death with no killer gets a message that does not name one, while there is one', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		await look(m, A, B, C);
		const id = await rule(w, { messages: ['{killer} got you, {name}', 'Hello {name}'] });
		// the environment: no killer, so only the second fits, whatever the pick
		const random = spyOn(Math, 'random').mockReturnValue(0);
		try {
			await post(w.server.id, [ev(null, B), ev(A, C)]);
		} finally {
			random.mockRestore();
		}
		expect(
			(await rowsOf(id)).map((r) => [r.target, (r.params as { message: string }).message])
		).toEqual([
			[B, 'Hello p962'],
			[C, 'p961 got you, p963']
		]);
	});

	test('a message can tell the player their stats, here and across the organisation', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		await look(m, A, B);
		const id = await rule(w, {
			messages: ['{kills} kills here, {org_kills} in the org, {name} on {map} with {players} on']
		});
		await post(w.server.id, [ev(A, B)]);
		const [row] = await rowsOf(id);
		// read for the player, never left as … (a player with no record has none); the map as players
		// know it
		expect((row.params as { message: string }).message).toBe(
			'0 kills here, 0 in the org, p962 on Bakurani with 2 on'
		);
	});

	test('a rule sparing slots waits for the reserved list, then leaves slot holders alone', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		await look(m, A, B, C);
		const id = await rule(w, { messages: ['Hello {name}'], spareReserved: true });
		m.reservedAt = 0;
		await post(w.server.id, [ev(A, B), ev(B, C)]);
		expect(await rowsOf(id)).toEqual([]);
		expect((await ruleRow(id)).lastResult).toBe('Waiting for the reserved slots to be read');
		m.reserved = new Set([B]);
		m.reservedAt = Date.now();
		await post(w.server.id, [ev(A, B), ev(B, C)]);
		expect((await rowsOf(id)).map((r) => r.target)).toEqual([C]);
	});

	test('nobody while fewer than its count are on', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		await look(m, A, B);
		const id = await rule(w, { messages: ['Hello {name}'], minPlayers: 3 });
		await post(w.server.id, [ev(A, B)]);
		expect(await rowsOf(id)).toEqual([]);
		await look(m, A, B, C);
		await post(w.server.id, [ev(A, B)]);
		expect((await rowsOf(id)).map((r) => r.target)).toEqual([B]);
	});

	test('two rules each whisper; one switched off whispers no more; the other server hears nothing', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		await look(m, A, B, C);
		const tips = await rule(w, { messages: ['Tip'] }, 'Tips');
		const discord = await rule(w, { messages: ['Discord'] }, 'Discord');
		await post(w.server.id, [ev(A, B)]);
		expect((await rowsOf(tips)).map((r) => r.target)).toEqual([B]);
		expect((await rowsOf(discord)).map((r) => r.target)).toEqual([B]);
		await env.db.update(triggers).set({ enabled: false }).where(eq(triggers.id, tips));
		invalidateTriggers(w.server.id);
		await post(w.server.id, [ev(B, C)]);
		expect((await rowsOf(tips)).map((r) => r.target)).toEqual([B]);
		expect((await rowsOf(discord)).map((r) => r.target)).toEqual([B, C]);
		const [other] = await env.db
			.select({ n: sql<number>`count(*)::int` })
			.from(outbox)
			.where(eq(outbox.serverId, w.otherServer.id));
		expect(other.n).toBe(0);
	});

	test('whispers that cannot be written leave the cooldown as it was', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		await look(m, A, B);
		const id = await rule(w, { messages: ['Hello {name}'] });
		await releaseOwnership(env);
		const quiet = console.warn;
		console.warn = () => {};
		try {
			await post(w.server.id, [ev(A, B)]);
		} finally {
			console.warn = quiet;
			expect(await acquireOrRenew(env, 'death whisper test')).toBe(true);
		}
		expect(await rowsOf(id)).toEqual([]);
		await post(w.server.id, [ev(A, B)]);
		expect((await rowsOf(id)).map((r) => r.target)).toEqual([B]);
	});

	test('the dry run replays the day: the cooldown, the list, the player count', async () => {
		const w = await seedWorld(env);
		const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
		const death = (minutesAgo: number, victim: string, killer: string | null = A) => ({
			ts: at(minutesAgo),
			serverId: w.server.id,
			eventId: newId(),
			instanceId: 'i',
			matchId: 'm',
			eventTime: 1000 - minutesAgo,
			map: 'Kavkazi',
			killerSteamId: killer,
			killerName: killer ? name(killer) : null,
			victimSteamId: victim,
			victimName: name(victim),
			cause: 'Id.Item.AK74M',
			distanceM: 40,
			tags: []
		});
		await env.db.insert(samples).values([
			{ serverId: w.server.id, ts: at(200), ok: true, playerCount: 1 },
			{ serverId: w.server.id, ts: at(150), ok: true, playerCount: 30 }
		]);
		await env.db.insert(kills).values([
			death(180, B), // one on: under the count of 2
			death(120, B),
			death(110, B), // inside B's cooldown
			death(100, C), // on the rule's list
			death(60, D, null),
			death(50, B) // past B's cooldown
		]);
		const server = { ...w.server, name: 'one' } as Parameters<typeof dryRun>[1];
		const r = await dryRun(env, server, 'death_whisper', {
			messages: ['{killer} got you, {name}'],
			cooldownMinutes: 30,
			minPlayers: 2,
			exempt: [C]
		});
		expect(r.fires).toBe(3);
		expect(r.items.map((i) => i.text)).toEqual([
			`whisper p962 (${B}): p961 got you, p962`,
			`whisper p964 (${D}):  got you, p964`,
			`whisper p962 (${B}): p961 got you, p962`
		]);
		expect(r.notes).toContain('6 deaths in the window: 3 whispers to 2 players.');
		expect(r.notes).toContain(
			"Passed over: 1 inside a player's 30-minute cooldown, 1 of players on the rule's list, 1 while fewer than 2 were on."
		);
		expect(r.notes).toContain(
			'This server has no kill feed set up (Config tab), so the rule cannot see any deaths.'
		);
	});
});
