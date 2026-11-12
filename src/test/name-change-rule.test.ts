// The Name change watch as the worker runs it, end to end against the database and the mock game:
// kills come in through the real ingest and each player's name in the feed is held against the
// name the server's player list has for them. A player shown under another listed player's name is
// flagged (or kicked) at that kill, on that server only; their own name with another clan tag, or
// a player off the list, is not judged; switching the rule off or editing it stops what it had
// queued; and the dry run finds the same in the day's kills against the sessions open at each.
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import {
	kills,
	organizations,
	outbox,
	playerSessions,
	servers,
	triggers
} from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import { ingestBatch } from '$lib/server/feed';
import { onKillsIngested } from '$lib/server/feed-events';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer } from '$lib/server/observe';
import { deliveryStats, startDelivery, stopDelivery } from '$lib/server/outbox';
import { WardogsClient } from '$lib/server/rcon';
import { validateConfig } from '$lib/server/trigger-rules';
import { dryRun, invalidateTriggers } from '$lib/server/triggers';
import { NAME_FLAG } from '$lib/server/name-filter';
import { nameChangeSettingsKey, type NameChangeConfig } from '$lib/server/name-change';
import { callApi, stubGateway } from './call';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const COPIER = '76561198000000701';
const ORIGINAL = '76561198000000702';
const STEADY = '76561198000000703';
const STRANGER = '76561198000000704';

type Named = [steamId: string, name: string];

/** One `killed` event as the game posts it, the players named as the feed shows them; no killer
 *  is the environment. */
const ev = (killer: Named | null, victim: Named, eventTime = 100) => ({
	eventId: newId(),
	type: 'killed',
	eventTime,
	matchId: 'boot',
	mapName: 'Kavkazi',
	...(killer ? { killerName: killer[1], killerSteamId: killer[0] } : {}),
	victimName: victim[1],
	victimSteamId: victim[0],
	cause: 'Id.Item.AK74M',
	distance: 5000,
	contextTags: []
});

describe.skipIf(!hasTestDb)('the name change rule on the kill feed', () => {
	let env: Env;
	/** who the stand-in game lists, per server, under which name */
	const lists = new Map<string, Named[]>();
	const used: string[] = [];
	let spy: ReturnType<typeof spyOn>;

	// The worker's lease lasts fifteen seconds and is taken once for the file, which runs about
	// that long: every test starts with it renewed, so a slow machine does not lose it part-way.
	beforeEach(async () => {
		expect(await acquireOrRenew(env, 'name-change-live')).toBe(true);
	});

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		stubGateway();
		expect(await acquireOrRenew(env, 'name-change-live')).toBe(true);
		// The mock game answers everything but the player list, which the test scripts per server.
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`name-change-${server.id}`
			);
			const raw = client.raw.bind(client);
			client.raw = async (method, path, body, headers) =>
				method === 'GET' && path === '/v1/players'
					? {
							status: 200,
							statusText: 'OK',
							headers: { 'content-type': 'application/json' },
							text: JSON.stringify({
								players: (lists.get(server.id) ?? []).map(([steamId, name]) => ({
									steamId,
									name,
									faction: null,
									kills: 0
								}))
							})
						}
					: raw(method, path, body, headers);
			return client;
		});
	});

	afterAll(async () => {
		await stopDelivery();
		spy.mockRestore();
		for (const id of used) forgetMemory(id);
		await releaseOwnership(env);
	});

	const rule = async (w: World, serverId: string, config: Record<string, unknown>) => {
		const id = newId();
		await env.db.insert(triggers).values({
			id,
			serverId,
			orgId: w.org.id,
			kind: 'name_change',
			name: 'Name change watch',
			enabled: true,
			config: validateConfig('name_change', config)
		});
		invalidateTriggers(serverId);
		return id;
	};
	/** The server's player list, as the worker reads it at a look. */
	const listing = async (w: World, serverId: string, ...players: Named[]) => {
		const [server] = await env.db.select().from(servers).where(eq(servers.id, serverId));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		used.push(serverId);
		lists.set(serverId, players);
		m.playersIntervalMs = 1000;
		await observeServer(env, m, { status: true, players: true });
		return m;
	};
	/** A batch through the real ingest, then the rules. */
	const post = async (serverId: string, ...events: ReturnType<typeof ev>[]) => {
		const r = await ingestBatch(env, serverId, { serverId: 'i', serverName: 'x', events });
		await onKillsIngested(env, serverId, r.kills);
	};
	const rowsOf = (triggerId: string) =>
		env.db.select().from(outbox).where(eq(outbox.triggerId, triggerId)).orderBy(outbox.id);
	const rowOf = async (id: number) =>
		(await env.db.select().from(outbox).where(eq(outbox.id, id)))[0];
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

	test("a player the feed shows under another listed player's name is flagged at that kill, as the name they are listed under, on that server only", async () => {
		const w = await seedWorld(env);
		const here = await rule(w, w.server.id, { takenOnly: true });
		const there = await rule(w, w.otherServer.id, { takenOnly: true });
		await listing(
			w,
			w.server.id,
			[COPIER, 'Ghostpepper'],
			[ORIGINAL, 'Silver Fox'],
			[STEADY, 'Steady']
		);
		await listing(w, w.otherServer.id, [COPIER, 'Ghostpepper'], [ORIGINAL, 'Silver Fox']);
		await post(w.server.id, ev([COPIER, 'Ghostpepper'], [STEADY, 'Steady']));
		expect(await rowsOf(here)).toHaveLength(0);

		await post(w.server.id, ev([COPIER, 'Silver Fox'], [STEADY, 'Steady']));
		const rows = await rowsOf(here);
		expect(rows.map((r) => [r.action, r.target, r.steamId])).toEqual([[NAME_FLAG, COPIER, COPIER]]);
		expect(rows[0].okMessage).toBe(
			`Flagged Ghostpepper: shown as Silver Fox, the name of ${ORIGINAL}`
		);
		expect(rows[0].detail).toMatchObject({
			name: 'Ghostpepper',
			shown: 'Silver Fox',
			holder: ORIGINAL,
			changes: 1
		});
		expect(rows[0].params).toEqual({
			rule: nameChangeSettingsKey(
				validateConfig('name_change', { takenOnly: true }) as NameChangeConfig
			)
		});
		// shown under the same name again, as killer or victim: nothing more
		await post(
			w.server.id,
			ev([COPIER, 'Silver Fox'], [STEADY, 'Steady']),
			ev([STEADY, 'Steady'], [COPIER, 'Silver Fox'], 101)
		);
		expect(await rowsOf(here)).toHaveLength(1);
		// the other server's rule never saw the kills
		expect(await rowsOf(there)).toHaveLength(0);
		const [fired] = await env.db
			.select({ lastResult: triggers.lastResult })
			.from(triggers)
			.where(eq(triggers.id, here));
		expect(fired.lastResult).toBe(
			`Flagging Ghostpepper: shown as Silver Fox, the name of ${ORIGINAL}`
		);
	});

	test('their own name with another clan tag is no change, a player off the list is not judged, and a victim is judged as a killer is', async () => {
		const w = await seedWorld(env);
		const id = await rule(w, w.server.id, {});
		await listing(w, w.server.id, [COPIER, 'Ghostpepper'], [STEADY, '[ABC] Steady']);
		await post(
			w.server.id,
			ev([STEADY, '[XYZ] Steady'], [COPIER, 'Ghostpepper']),
			ev([STRANGER, 'Silver Fox'], [STEADY, 'Steady'], 101)
		);
		expect(await rowsOf(id)).toHaveLength(0);
		// a change of name shows when the player dies too
		await post(w.server.id, ev([STEADY, '[ABC] Steady'], [COPIER, 'Tango']));
		expect((await rowsOf(id)).map((r) => [r.action, r.target, r.okMessage])).toEqual([
			[NAME_FLAG, COPIER, 'Flagged Ghostpepper: shown as Tango']
		]);
	});

	test('a kick rule asks the game to kick the player, with the reason filled in', async () => {
		const w = await seedWorld(env);
		const config = {
			action: 'kick',
			spareReserved: false,
			reason: 'Not as {name} (was {previous}), {kills} kills here.'
		};
		const id = await rule(w, w.otherServer.id, config);
		await listing(w, w.otherServer.id, [COPIER, 'Ghostpepper'], [STEADY, 'Steady']);
		await post(w.otherServer.id, ev([COPIER, 'Steady'], [STEADY, 'Steady']));
		const [kick] = await env.db
			.select()
			.from(outbox)
			.where(and(eq(outbox.triggerId, id), eq(outbox.action, 'kick')));
		// the name they show, the rule's {previous} (the name they are listed under), their stats here
		expect(kick.params).toEqual({
			steamId: COPIER,
			reason: 'Not as Steady (was Ghostpepper), 0 kills here.',
			rule: nameChangeSettingsKey(validateConfig('name_change', config) as NameChangeConfig)
		});
		expect(kick.steamId).toBe(COPIER);
		// a kick rule acts at every change: still at it, kicked again; and shown under a name it was
		// kicked for before (back after the kick, or the kick not landed yet), again
		await post(w.otherServer.id, ev([COPIER, 'Silver Fox'], [STEADY, 'Steady'], 101));
		await post(w.otherServer.id, ev([COPIER, 'Silver Fox'], [STEADY, 'Steady'], 102));
		expect(
			(await rowsOf(id)).map((r) => [r.action, (r.detail as { shown: string }).shown])
		).toEqual([
			['kick', 'Steady'],
			['kick', 'Silver Fox'],
			['kick', 'Silver Fox']
		]);
	});

	test('an edit starts the count over: a player an alert rule flagged is kicked once it kicks', async () => {
		const w = await seedWorld(env);
		const id = await rule(w, w.server.id, {});
		await listing(w, w.server.id, [COPIER, 'Ghostpepper'], [STEADY, 'Steady']);
		await post(w.server.id, ev([COPIER, 'Steady'], [STEADY, 'Steady']));
		await env.db
			.update(triggers)
			.set({ config: validateConfig('name_change', { action: 'kick', spareReserved: false }) })
			.where(eq(triggers.id, id));
		invalidateTriggers(w.server.id);
		await post(w.server.id, ev([COPIER, 'Steady'], [STEADY, 'Steady'], 101));
		expect((await rowsOf(id)).map((r) => r.action)).toEqual([NAME_FLAG, 'kick']);
	});

	test('a suicide names its player once, an environment kill its victim alone, and nothing is judged while the list is empty', async () => {
		const w = await seedWorld(env);
		const id = await rule(w, w.server.id, {});
		await listing(w, w.server.id, [COPIER, 'Ghostpepper'], [STEADY, 'Steady']);
		await post(
			w.server.id,
			ev([COPIER, 'Tango'], [COPIER, 'Tango']),
			ev(null, [STEADY, 'Bravo'], 101)
		);
		expect((await rowsOf(id)).map((r) => [r.target, r.okMessage])).toEqual([
			[COPIER, 'Flagged Ghostpepper: shown as Tango'],
			[STEADY, 'Flagged Steady: shown as Bravo']
		]);
		// the next map loading: nobody listed, nothing to hold the feed against
		const kicking = await rule(w, w.server.id, { action: 'kick', spareReserved: false });
		await listing(w, w.server.id);
		await post(w.server.id, ev([COPIER, 'Zulu'], [STEADY, 'Steady'], 102));
		expect(await rowsOf(kicking)).toHaveLength(0);
		await listing(w, w.server.id, [COPIER, 'Ghostpepper'], [STEADY, 'Steady']);
		await post(w.server.id, ev([COPIER, 'Zulu'], [STEADY, 'Steady'], 103));
		expect((await rowsOf(kicking)).map((r) => r.action)).toEqual(['kick']);
	});

	test('a kick rule flags a reserved slot instead, and everyone until the reserved list is read', async () => {
		const w = await seedWorld(env);
		const id = await rule(w, w.server.id, { action: 'kick' });
		const m = await listing(w, w.server.id, [COPIER, 'Ghostpepper'], [STEADY, 'Steady']);
		m.reserved = new Set([COPIER]);
		m.reservedAt = Date.now();
		await post(w.server.id, ev([COPIER, 'Alpha'], [STEADY, 'Bravo']));
		expect((await rowsOf(id)).map((r) => [r.target, r.action, r.okMessage])).toEqual([
			[COPIER, NAME_FLAG, 'Flagged Ghostpepper (reserved slot): shown as Alpha'],
			[STEADY, 'kick', 'Kicked Steady: shown as Bravo']
		]);
		m.reservedAt = 0;
		await post(w.server.id, ev([STEADY, 'Charlie'], [COPIER, 'Ghostpepper'], 101));
		expect((await rowsOf(id)).map((r) => r.action)).toEqual([NAME_FLAG, 'kick', NAME_FLAG]);
	});

	test('switching the rule off drops the kick it had queued, and a flag decided under old settings is not delivered', async () => {
		const w = await seedWorld(env);
		const kicking = await rule(w, w.server.id, { action: 'kick', spareReserved: false });
		await listing(w, w.server.id, [COPIER, 'Ghostpepper'], [STEADY, 'Steady']);
		await post(w.server.id, ev([COPIER, 'Juliet'], [STEADY, 'Steady']));
		const [queued] = await rowsOf(kicking);
		expect([queued.action, queued.state]).toEqual(['kick', 'pending']);
		const mod = await import(
			join(
				import.meta.dir,
				'..',
				'routes',
				'api',
				'servers',
				'[id]',
				'triggers',
				'[triggerId]',
				'+server.ts'
			)
		);
		const off = await callApi(mod.PATCH, w.users.owner, {
			method: 'PATCH',
			params: { id: w.server.id, triggerId: kicking },
			body: { enabled: false }
		});
		expect(off.status).toBe(200);
		expect(await rowOf(queued.id)).toMatchObject({
			state: 'skipped',
			outcome: 'The rule was changed before this was sent.'
		});

		// a flag under the settings its rule still holds is delivered; one an edit overtook is not
		const flagging = await rule(w, w.server.id, {});
		await post(w.server.id, ev([COPIER, 'Kilo'], [STEADY, 'Steady'], 101));
		const [held] = await rowsOf(flagging);
		expect(held.action).toBe(NAME_FLAG);
		expect((await deliver(held.id)).map((r) => r.state)).toEqual(['delivered']);
		// an alert rule tells staff once a window: a quick change after it is not flagged again
		await post(w.server.id, ev([COPIER, 'Lima'], [STEADY, 'Steady'], 102));
		expect(await rowsOf(flagging)).toHaveLength(1);
		const fresh = await rule(w, w.server.id, { windowMinutes: 5 });
		await post(w.server.id, ev([COPIER, 'Mike'], [STEADY, 'Steady'], 103));
		const [late] = await rowsOf(fresh);
		await env.db
			.update(triggers)
			.set({ config: validateConfig('name_change', { windowMinutes: 30 }) })
			.where(eq(triggers.id, fresh));
		const [done] = await deliver(late.id);
		expect([done.state, done.outcome]).toEqual([
			'skipped',
			'The rule was changed before this was sent.'
		]);
	});

	test("the dry run finds the same in the day's kills, against the names of the sessions open at each", async () => {
		const w = await seedWorld(env);
		const server = { ...w.server, name: 'one' } as Parameters<typeof dryRun>[1];
		const at = Date.now() - 3600_000;
		await env.db.insert(playerSessions).values(
			(
				[
					[COPIER, 'Ghostpepper'],
					[ORIGINAL, '[R-14] Silver Fox'],
					[STEADY, 'Steady']
				] as Named[]
			).map(([steamId, name]) => ({
				serverId: w.server.id,
				steamId,
				name,
				joinedAt: new Date(at - 60_000),
				lastSeen: new Date(at - 60_000)
			}))
		);
		// a player who left before the kills that name them is not on the list then
		await env.db.insert(playerSessions).values({
			serverId: w.server.id,
			steamId: STRANGER,
			name: 'Tango',
			joinedAt: new Date(at - 120_000),
			lastSeen: new Date(at - 90_000),
			leftAt: new Date(at - 90_000)
		});
		const kill = (i: number, killer: Named, victim: Named) => ({
			ts: new Date(at + i * 60_000),
			serverId: w.server.id,
			eventId: newId(),
			instanceId: 'i',
			matchId: 'm',
			eventTime: i * 60,
			map: 'Kavkazi',
			killerSteamId: killer[0],
			killerName: killer[1],
			victimSteamId: victim[0],
			victimName: victim[1],
			cause: 'Id.Item.AK74M',
			tags: []
		});
		await env.db
			.insert(kills)
			.values([
				kill(0, [COPIER, 'Ghostpepper'], [ORIGINAL, '[R-14] Silver Fox']),
				kill(1, [COPIER, 'Silver Fox'], [STEADY, 'Steady']),
				kill(2, [STEADY, '[ABC] Steady'], [COPIER, 'Tango']),
				kill(3, [STRANGER, 'Steady'], [ORIGINAL, '[R-14] Silver Fox'])
			]);
		const taken = await dryRun(env, server, 'name_change', { takenOnly: true });
		expect(taken.items.map((i) => i.text)).toEqual([
			`flag Ghostpepper (${COPIER}): shown as Silver Fox, the name of ${ORIGINAL}`
		]);
		const every = await dryRun(env, server, 'name_change', { action: 'kick' });
		expect(every.items.map((i) => i.text)).toEqual([
			`kick Ghostpepper (${COPIER}): shown as Silver Fox, the name of ${ORIGINAL}`,
			`kick Ghostpepper (${COPIER}): shown as Tango`
		]);
		expect(every.notes.join(' ')).toContain('4 kills in the window');
	});
});
