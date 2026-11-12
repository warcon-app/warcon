// A Kill distance rule as the worker runs it, against the database and a stand-in game: kills
// come in through the real ingest, reach the rule on their own server only, and count per match;
// only the chosen weapons from the distance on count; a flag sends nothing to the game and is
// audited, a warning is a whisper row, a kick is a kick row, and a ban is an entry on the panel's
// ban list that the panel's own enforcement removes the player with at the next look, written only
// while the worker is owned. A kill kills the player, then whispers them, soon or not at all. From 0 m every kill with the chosen weapons counts, one without a
// distance too. Nothing a person or a key can call runs the rule's ban or flag.
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
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
	servers,
	triggers
} from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { onKillsIngested } from '$lib/server/feed-events';
import { ingestBatch } from '$lib/server/feed';
import * as listsModule from '$lib/server/lists';
import { forgetMemory, memoryFor, observeServer } from '$lib/server/observe';
import { deliveryStats, startDelivery, stopDelivery } from '$lib/server/outbox';
import { WardogsClient } from '$lib/server/rcon';
import { dryRun, invalidateTriggers, validateConfig } from '$lib/server/triggers';
import { KILL_DISTANCE_FLAG, KILL_DISTANCE_SKIP } from '$lib/server/kill-distance';
import { PANEL_BAN } from '$lib/server/rule-ban';
import { RULE_KILL } from '$lib/server/rule-kill';
import { newId } from '$lib/server/http';
import { callApi, stubGateway } from './call';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const DEFIB = 'Id.Item.Defibrillator.Standard';
const HUMVEE_M249 = 'Id.Vehicle.WeaponExtension.WHL_05.RingTurret';
const HUMVEE_MINIGUN = 'Id.Vehicle.WeaponExtension.WHL_05.RingMinigun';
/** the vehicle itself: a roadkill, or the Humvee blown up with its crew inside */
const HUMVEE = 'Vehicle.Variant.Land.Wheeled.Humvee.Default';
const CHEAT = '76561198000000801';
const MEDIC = '76561198000000802';
const SNIPER = '76561198000000803';
const VICTIM = '76561198000000804';
/** a player the server does not list */
const GONE = '76561198000000805';
/** a gunner whose vehicle is destroyed with a shell in the air, and the enemy who destroys it */
const GUNNER = '76561198000000806';
const ENEMY = '76561198000000807';
const M4 = 'Id.Item.M4';
const ENEMY_GUN = 'Id.Vehicle.WeaponExtension.STN_05.MainBarrel';
const REASON = 'Impossible kill: Defibrillator from 4057 m.';

/** One `killed` event as the game posts it; distance in metres here, centimetres on the wire. */
const ev = (
	killer: string | null,
	o: {
		cause?: string;
		distanceM?: number | null;
		eventTime?: number;
		suicide?: boolean;
		victim?: string;
	} = {}
) => ({
	eventId: newId(),
	type: 'killed',
	eventTime: o.eventTime ?? 100,
	matchId: 'boot',
	mapName: 'Kavkazi',
	...(killer ? { killerName: `p${killer.slice(-3)}`, killerSteamId: killer } : {}),
	victimName: o.victim ? `p${o.victim.slice(-3)}` : 'victim',
	victimSteamId: o.victim ?? VICTIM,
	cause: o.cause ?? DEFIB,
	...(o.distanceM === null ? {} : { distance: (o.distanceM ?? 4057) * 100 }),
	contextTags: o.suicide ? ['Meta.Progression.Context.Player.KillContext.Suicide'] : []
});

describe.skipIf(!hasTestDb)('Kill distance rule, live', () => {
	let env: Env;
	let spy: ReturnType<typeof spyOn>;
	/** who the stand-in game lists, per server */
	const onServer = new Map<string, string[]>();
	/** the kicks it was asked for: server, player, reason */
	const kicked: [string, string, string][] = [];
	/** the whispers it was asked for: server, player, message */
	const whispered: [string, string, string][] = [];
	/** the kills and whispers it was asked for, in order: server, what, player */
	const sent: [string, 'kill' | 'whisper', string][] = [];
	/** players on the server it will not kill (no living character, as far as the panel can tell) */
	const dead = new Set<string>();

	// The worker's lease lasts fifteen seconds and is taken once for the file, which runs about
	// that long: every test starts with it renewed, so a slow machine does not lose it part-way.
	beforeEach(async () => {
		expect(await acquireOrRenew(env, 'kill-distance test')).toBe(true);
	});

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		stubGateway();
		expect(await acquireOrRenew(env, 'kill-distance test')).toBe(true);
		// The mock game answers everything but the player list and kicks, which the test keeps.
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`kill-distance-${server.id}`
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
							players: (onServer.get(server.id) ?? []).map((steamId) => ({
								name: `p${steamId.slice(-3)}`,
								steamId,
								faction: null,
								kills: 0
							}))
						})
					);
				const kick = /^\/v1\/players\/(\d{17})\/kick$/.exec(path);
				if (method === 'POST' && kick) {
					kicked.push([server.id, kick[1], JSON.parse(body ?? '{}').reason]);
					return ok('{}');
				}
				const whisper = /^\/v1\/players\/(\d{17})\/message$/.exec(path);
				if (method === 'POST' && whisper) {
					whispered.push([server.id, whisper[1], JSON.parse(body ?? '{}').message]);
					sent.push([server.id, 'whisper', whisper[1]]);
					return ok('{"message":"Message sent."}');
				}
				const kill = /^\/v1\/players\/(\d{17})\/kill$/.exec(path);
				if (method === 'POST' && kill) {
					sent.push([server.id, 'kill', kill[1]]);
					if (dead.has(kill[1]))
						return {
							...ok('{"error":{"code":"not_alive","message":"GAME-TEXT"}}'),
							status: 409,
							statusText: 'Conflict'
						};
					return ok('{"message":"Player killed."}');
				}
				return raw(method, path, body, headers);
			};
			return client;
		});
	});
	afterAll(async () => {
		await stopDelivery();
		spy.mockRestore();
		await releaseOwnership(env);
	});

	/** A batch through the real ingest, stamped with the server's open match, then the rules. */
	const post = async (serverId: string, events: ReturnType<typeof ev>[], at = new Date()) => {
		const r = await ingestBatch(env, serverId, { serverId: 'i', serverName: 'x', events }, at);
		await onKillsIngested(env, serverId, r.kills);
		return r;
	};
	const openMatch = async (serverId: string) =>
		(
			await env.db
				.insert(matches)
				.values({ serverId, startedAt: new Date(Date.now() - 60_000), map: 'Kavkazi' })
				.returning({ id: matches.id })
		)[0].id;
	const endMatch = (id: number) =>
		env.db.update(matches).set({ endedAt: new Date() }).where(eq(matches.id, id));
	const rule = async (w: World, serverId: string, config: Record<string, unknown>) => {
		const id = newId();
		await env.db.insert(triggers).values({
			id,
			serverId,
			orgId: w.org.id,
			kind: 'kill_distance',
			name: 'Kill distance watch',
			enabled: true,
			config: validateConfig('kill_distance', { causes: [DEFIB], ...config })
		});
		invalidateTriggers(serverId);
		return id;
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
	const bansOf = (w: World, steamId: string) =>
		env.db
			.select({ serverId: lists.serverId, entry: listEntries })
			.from(listEntries)
			.innerJoin(lists, eq(lists.id, listEntries.listId))
			.where(
				and(
					eq(lists.orgId, w.org.id),
					eq(lists.kind, 'ban'),
					eq(listEntries.steamId, steamId),
					isNull(listEntries.removedAt)
				)
			);
	const auditOf = (serverId: string, action: string, target: string) =>
		env.db
			.select()
			.from(auditLog)
			.where(
				and(
					eq(auditLog.serverId, serverId),
					eq(auditLog.action, action),
					eq(auditLog.target, target)
				)
			);
	/**
	 * A delivered row's own audit row is written after its state, by the chain that delivered it,
	 * which stopDelivery lets finish on its own: wait for it rather than read once.
	 */
	const auditSoon = async (serverId: string, action: string, target: string) => {
		for (let i = 0; i < 40; i++) {
			const rows = await auditOf(serverId, action, target);
			if (rows.length) return rows;
			await Bun.sleep(50);
		}
		return auditOf(serverId, action, target);
	};

	test('defibrillator kills from across the map: caught at the second, flagged once and audited, on their own server only', async () => {
		const w = await seedWorld(env);
		await openMatch(w.server.id);
		const here = await rule(w, w.server.id, { action: 'flag' });
		const there = await rule(w, w.otherServer.id, { action: 'flag' });
		await post(w.server.id, [ev(CHEAT)]);
		expect(await rowsOf(here)).toHaveLength(0);
		// a batch of three: the second kill catches them, the rest of the burst asks for nothing
		await post(
			w.server.id,
			[1, 2, 3].map((i) => ev(CHEAT, { eventTime: 100 + i }))
		);
		const rows = await rowsOf(here);
		const message = 'Flagged p801: Defibrillator kill from 4057 m (2 this match)';
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: KILL_DISTANCE_FLAG,
			target: CHEAT,
			steamId: CHEAT,
			state: 'pending',
			okMessage: message
		});
		expect(await rowsOf(there)).toHaveLength(0);
		// The flag is the audit row (and its Discord post) and nothing else, whether or not the
		// worker has looked at the server yet: it has not, here.
		const [done] = await deliver(rows[0].id);
		expect([done.state, done.outcome]).toEqual(['delivered', message]);
		const audited = await auditSoon(w.server.id, 'trigger.kill_distance', CHEAT);
		expect(audited.map((a) => [a.outcome, a.message])).toEqual([['ok', message]]);
		expect(kicked.filter(([s]) => s === w.server.id)).toEqual([]);
	});

	test('closer kills, other weapons, no distance, suicides and the environment are not counted', async () => {
		const w = await seedWorld(env);
		const id = await rule(w, w.server.id, { action: 'kick', count: 1 });
		await post(w.server.id, [
			ev(MEDIC, { distanceM: 2.5 }),
			ev(MEDIC, { distanceM: 99.9 }),
			ev(MEDIC, { distanceM: null }),
			ev(SNIPER, { cause: 'Id.Item.SV98', distanceM: 1200 }),
			ev(MEDIC, { suicide: true }),
			ev(null)
		]);
		expect(await rowsOf(id)).toHaveLength(0);
	});

	test('a kill just after the killer’s own death is not counted, and the audit trail says so: a shell that landed after their vehicle was destroyed', async () => {
		const w = await seedWorld(env);
		await openMatch(w.server.id);
		const id = await rule(w, w.server.id, {
			causes: [M4],
			minDistanceM: 1300,
			count: 1,
			action: 'flag'
		});
		// the gunner's vehicle destroyed with them in it, then their shell landing on two players
		// at once, credited to the rifle they carry
		await post(w.server.id, [
			ev(ENEMY, { cause: ENEMY_GUN, distanceM: 2297, eventTime: 3383.97, victim: GUNNER })
		]);
		await post(w.server.id, [
			ev(GUNNER, { cause: M4, distanceM: 2295, eventTime: 3388.23, victim: ENEMY }),
			ev(GUNNER, { cause: M4, distanceM: 2280, eventTime: 3388.23 })
		]);
		// another gunner's death and their shell in one batch
		await post(w.server.id, [
			ev(ENEMY, { cause: ENEMY_GUN, distanceM: 2400, eventTime: 3390, victim: SNIPER }),
			ev(SNIPER, { cause: M4, distanceM: 2410, eventTime: 3396 })
		]);
		// nothing done to anyone; each kill left out is a note, sent nothing and asked of no one
		const notes = await rowsOf(id);
		expect(notes.map((r) => [r.action, r.target, r.steamId, r.okMessage])).toEqual([
			[
				KILL_DISTANCE_SKIP,
				GUNNER,
				null,
				'Not counted: M4 kill from 2295 m by p806, 4.3 s after they died'
			],
			[
				KILL_DISTANCE_SKIP,
				GUNNER,
				null,
				'Not counted: M4 kill from 2280 m by p806, 4.3 s after they died'
			],
			[
				KILL_DISTANCE_SKIP,
				SNIPER,
				null,
				'Not counted: M4 kill from 2410 m by p803, 6.0 s after they died'
			]
		]);
		// written while the rule holds the settings it was decided under, like a flag
		expect((notes[0].params as { rule?: string }).rule).toMatch(/^[A-Za-z0-9_-]{16}$/);
		const done = await deliver(...notes.map((r) => r.id));
		expect(done.map((d) => [d.state, d.outcome])).toEqual(
			notes.map((r) => ['delivered', r.okMessage])
		);
		const audited = await auditSoon(w.server.id, 'trigger.kill_distance', SNIPER);
		expect(audited.map((a) => [a.outcome, a.category, a.message])).toEqual([
			['ok', 'trigger', 'Not counted: M4 kill from 2410 m by p803, 6.0 s after they died']
		]);
		expect(audited[0].detail).toMatchObject({
			rconAction: KILL_DISTANCE_SKIP,
			cause: M4,
			distanceM: 2410,
			afterDeathS: 6
		});
		// a living player's kill from as far counts, and so does the gunner's a minute on
		await post(w.server.id, [ev(CHEAT, { cause: M4, distanceM: 2300, eventTime: 3400 })]);
		await post(w.server.id, [ev(GUNNER, { cause: M4, distanceM: 2300, eventTime: 3445 })]);
		const acted = (await rowsOf(id)).filter((r) => r.action !== KILL_DISTANCE_SKIP);
		expect(acted.map((r) => [r.action, r.steamId, r.okMessage])).toEqual([
			[KILL_DISTANCE_FLAG, CHEAT, 'Flagged p801: M4 kill from 2300 m'],
			[KILL_DISTANCE_FLAG, GUNNER, 'Flagged p806: M4 kill from 2300 m']
		]);
		// the notes and flags asked nothing of the game
		expect(sent.filter(([s]) => s === w.server.id)).toEqual([]);
		expect(kicked.filter(([s]) => s === w.server.id)).toEqual([]);
	});

	test('a warning on a Humvee’s guns from 0 m: whispered once in the cooldown, a kill without a distance too, in the panel’s words', async () => {
		const w = await seedWorld(env);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		onServer.set(server.id, [CHEAT, MEDIC, SNIPER]);
		try {
			await observeServer(env, m, { status: true, players: true });
			const id = await rule(w, w.server.id, {
				causes: [HUMVEE_M249, HUMVEE_MINIGUN],
				minDistanceM: 0,
				count: 1,
				action: 'warn',
				cooldownMinutes: 10,
				reason: '{name}: the {weapon} is not allowed here ({distance} m).'
			});
			await post(w.server.id, [ev(CHEAT, { cause: HUMVEE_M249, distanceM: 35, eventTime: 100 })]);
			// the same player again inside the cooldown, a kill the feed sent without a distance
			await post(w.server.id, [
				ev(CHEAT, { cause: HUMVEE_MINIGUN, distanceM: null, eventTime: 120 })
			]);
			// another player's minigun kill without a distance, and an M249 carried by hand
			await post(w.server.id, [
				ev(MEDIC, { cause: HUMVEE_MINIGUN, distanceM: null, eventTime: 130 }),
				ev(SNIPER, { cause: 'Id.Item.M249', distanceM: 35, eventTime: 131 })
			]);
			const rows = await rowsOf(id);
			expect(
				rows.map((r) => [
					r.action,
					r.steamId,
					(r.params as { message: string }).message,
					r.okMessage
				])
			).toEqual([
				[
					'whisper',
					CHEAT,
					'p801: the Humvee M249 is not allowed here (35 m).',
					'Warned p801: Humvee M249 kill from 35 m'
				],
				[
					'whisper',
					MEDIC,
					'p802: the Humvee minigun is not allowed here (… m).',
					'Warned p802: Humvee minigun kill'
				]
			]);
			// sent only while the rule holds the settings it was decided under
			expect((rows[0].params as { rule?: string }).rule).toMatch(/^[A-Za-z0-9_-]{16}$/);
			const done = await deliver(...rows.map((r) => r.id));
			// what became of it is told in the panel's words, never the game's
			expect(done.map((d) => [d.state, d.outcome])).toEqual([
				['delivered', 'Warned p801: Humvee M249 kill from 35 m'],
				['delivered', 'Warned p802: Humvee minigun kill']
			]);
			expect(whispered.filter(([s]) => s === w.server.id)).toEqual([
				[w.server.id, CHEAT, 'p801: the Humvee M249 is not allowed here (35 m).'],
				[w.server.id, MEDIC, 'p802: the Humvee minigun is not allowed here (… m).']
			]);
			const [audit] = await auditSoon(w.server.id, 'trigger.kill_distance', CHEAT);
			expect([audit.outcome, audit.category, audit.message]).toEqual([
				'ok',
				'trigger',
				'Warned p801: Humvee M249 kill from 35 m'
			]);
			expect(kicked.filter(([s]) => s === w.server.id)).toEqual([]);
			// a killer the server does not list: queued, but a warning needs them on
			await post(w.server.id, [ev(GONE, { cause: HUMVEE_M249, distanceM: 40, eventTime: 140 })]);
			const [left] = (await rowsOf(id)).filter((r) => r.steamId === GONE);
			expect((await deliver(left.id)).map((d) => [d.state, d.outcome])).toEqual([
				['skipped', 'Player already left.']
			]);
			expect(whispered.filter(([, p]) => p === GONE)).toEqual([]);
		} finally {
			forgetMemory(server.id);
		}
	});

	test('a kill on the Humvee from 0 m: one kill and its whisper for a roadkill of three, in the panel’s words; a player gone, or a kill gone stale, is not killed', async () => {
		const w = await seedWorld(env);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		onServer.set(server.id, [CHEAT, MEDIC, SNIPER]);
		dead.add(SNIPER);
		try {
			await observeServer(env, m, { status: true, players: true });
			const id = await rule(w, w.server.id, {
				causes: [HUMVEE],
				minDistanceM: 0,
				count: 1,
				action: 'kill',
				reason: '{name}: no {weapon} on this server.'
			});
			// three run over at once, the feed sending no distance, and the next batch right behind
			await post(
				w.server.id,
				[100, 101, 102].map((t) => ev(CHEAT, { cause: HUMVEE, distanceM: null, eventTime: t }))
			);
			await post(w.server.id, [ev(CHEAT, { cause: HUMVEE, distanceM: null, eventTime: 104 })]);
			const rows = await rowsOf(id);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				action: RULE_KILL,
				target: CHEAT,
				steamId: CHEAT,
				okMessage: 'Killed p801: Humvee kill',
				params: {
					steamId: CHEAT,
					name: 'p801',
					why: 'Humvee kill',
					message: 'p801: no Humvee on this server.'
				}
			});
			// sent only while the rule holds the settings it was decided under
			expect((rows[0].params as { rule?: string }).rule).toMatch(/^[A-Za-z0-9_-]{16}$/);
			const [done] = await deliver(rows[0].id);
			// what became of it is told in the panel's words, never the game's
			expect([done.state, done.outcome]).toEqual(['delivered', 'Killed p801: Humvee kill']);
			expect(sent.filter(([s]) => s === w.server.id)).toEqual([
				[w.server.id, 'kill', CHEAT],
				[w.server.id, 'whisper', CHEAT]
			]);
			expect(whispered.filter(([s]) => s === w.server.id)).toEqual([
				[w.server.id, CHEAT, 'p801: no Humvee on this server.']
			]);
			const [audit] = await auditSoon(w.server.id, 'trigger.kill_distance', CHEAT);
			expect([audit.outcome, audit.category, audit.message]).toEqual([
				'ok',
				'trigger',
				'Killed p801: Humvee kill'
			]);
			// one the game will not kill is told all the same, and the trail says so in the panel's words
			await post(w.server.id, [ev(SNIPER, { cause: HUMVEE, distanceM: null, eventTime: 130 })]);
			const [unkilled] = (await rowsOf(id)).filter((r) => r.steamId === SNIPER);
			const told = 'Told p803, but the game refused the kill: Humvee kill';
			expect((await deliver(unkilled.id)).map((d) => [d.state, d.outcome])).toEqual([
				['delivered', told]
			]);
			expect(sent.filter(([s, , p]) => s === w.server.id && p === SNIPER)).toEqual([
				[w.server.id, 'kill', SNIPER],
				[w.server.id, 'whisper', SNIPER]
			]);
			const [audited] = await auditSoon(w.server.id, 'trigger.kill_distance', SNIPER);
			expect([audited.outcome, audited.message]).toEqual(['ok', told]);
			// a killer the server does not list: queued, but a kill needs them on
			await post(w.server.id, [ev(GONE, { cause: HUMVEE, distanceM: null, eventTime: 140 })]);
			const [left] = (await rowsOf(id)).filter((r) => r.steamId === GONE);
			expect((await deliver(left.id)).map((d) => [d.state, d.outcome])).toEqual([
				['skipped', 'Player already left.']
			]);
			// one decided more than half a minute ago goes no more
			await post(w.server.id, [ev(MEDIC, { cause: HUMVEE, distanceM: null, eventTime: 150 })]);
			const [late] = (await rowsOf(id)).filter((r) => r.steamId === MEDIC);
			await env.db
				.update(outbox)
				.set({ createdAt: new Date(Date.now() - 31_000) })
				.where(eq(outbox.id, late.id));
			const [stale] = await deliver(late.id);
			expect(stale.state).toBe('skipped');
			expect(stale.outcome).toMatch(/^Stale \(3\ds old\)\.$/);
			expect(sent.filter(([s, , p]) => s === w.server.id && p !== CHEAT && p !== SNIPER)).toEqual(
				[]
			);
		} finally {
			dead.clear();
			forgetMemory(server.id);
		}
	}, 30_000);

	test('a kick rule kicks once for a burst, with its reason, while the kick lands', async () => {
		const w = await seedWorld(env);
		const id = await rule(w, w.server.id, { action: 'kick', count: 1 });
		// a batch the game held back: three kills a minute apart on its clock, taken in at once
		await post(w.server.id, [
			ev(CHEAT, { eventTime: 100 }),
			ev(CHEAT, { eventTime: 170 }),
			ev(CHEAT, { eventTime: 240 })
		]);
		// and the next batch right behind it
		await post(w.server.id, [ev(CHEAT, { eventTime: 245 })]);
		const rows = await rowsOf(id);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			action: 'kick',
			steamId: CHEAT,
			params: { steamId: CHEAT, reason: REASON }
		});
	});

	test('kills count per match: a new match starts the count over', async () => {
		const w = await seedWorld(env);
		const first = await openMatch(w.server.id);
		const id = await rule(w, w.server.id, { action: 'kick', count: 2 });
		await post(w.server.id, [ev(CHEAT, { eventTime: 1500 })]);
		await endMatch(first);
		await openMatch(w.server.id);
		await post(w.server.id, [ev(CHEAT, { eventTime: 20 })]);
		expect(await rowsOf(id)).toHaveLength(0);
		await post(w.server.id, [ev(CHEAT, { eventTime: 900 })]);
		const rows = await rowsOf(id);
		expect(rows.map((r) => r.okMessage)).toEqual([
			'Kicked p801: Defibrillator kill from 4057 m (2 this match)'
		]);
	});

	test('an edited rule counts again from nothing: kills taken under its old settings are no evidence', async () => {
		const w = await seedWorld(env);
		await openMatch(w.server.id);
		const id = await rule(w, w.server.id, { action: 'ban', count: 3, minDistanceM: 1 });
		await post(w.server.id, [ev(CHEAT, { distanceM: 2, eventTime: 10 })]);
		await post(w.server.id, [ev(CHEAT, { distanceM: 2, eventTime: 20 })]);
		await env.db
			.update(triggers)
			.set({
				config: validateConfig('kill_distance', {
					causes: [DEFIB],
					action: 'ban',
					count: 3,
					minDistanceM: 100
				})
			})
			.where(eq(triggers.id, id));
		invalidateTriggers(w.server.id);
		await post(w.server.id, [ev(CHEAT, { eventTime: 30 })]);
		expect(await rowsOf(id)).toHaveLength(0);
	});

	test('an action that could not be queued does not start the hold', async () => {
		const w = await seedWorld(env);
		const id = await rule(w, w.server.id, { action: 'kick', count: 1 });
		await releaseOwnership(env);
		await post(w.server.id, [ev(CHEAT)]);
		expect(await rowsOf(id)).toHaveLength(0);
		expect(await acquireOrRenew(env, 'kill-distance test')).toBe(true);
		await post(w.server.id, [ev(CHEAT, { eventTime: 105 })]);
		expect(await rowsOf(id)).toHaveLength(1);
	});

	test('a ban goes on the server’s own list, and the ban enforcement removes the player at the next look', async () => {
		const w = await seedWorld(env);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		const look = async () => {
			onServer.set(server.id, [CHEAT, MEDIC]);
			m.playersIntervalMs = 1000;
			await observeServer(env, m, { status: true, players: true });
		};
		try {
			await look();
			const id = await rule(w, w.server.id, { action: 'ban', count: 1 });
			await post(w.server.id, [ev(CHEAT)]);
			const [row] = await rowsOf(id);
			// a ban stands whether or not the player is still on when it is delivered
			expect(row).toMatchObject({ action: PANEL_BAN, target: CHEAT, steamId: null });
			const [done] = await deliver(row.id);
			expect([done.state, done.outcome]).toEqual([
				'delivered',
				'Banned p801 here for good: Defibrillator kill from 4057 m'
			]);
			const bans = await bansOf(w, CHEAT);
			expect(
				bans.map((b) => [
					b.serverId,
					b.entry.reason,
					b.entry.expiresAt,
					b.entry.addedBy,
					b.entry.addedByName
				])
			).toEqual([[w.server.id, REASON, null, null, 'trigger: Kill distance watch']]);
			const [audit] = await auditSoon(w.server.id, 'trigger.kill_distance', CHEAT);
			expect([audit.outcome, audit.category]).toEqual(['ok', 'trigger']);
			// the server takes its lists again at its next look, and the player is removed
			expect(m.syncAt).toBe(0);
			await look();
			expect(kicked.filter(([s]) => s === w.server.id)).toEqual([[w.server.id, CHEAT, REASON]]);
			const enforced = await auditOf(w.server.id, 'ban.enforce', CHEAT);
			expect(enforced.map((r) => r.outcome)).toEqual(['ok']);
		} finally {
			forgetMemory(server.id);
		}
	});

	test('an org-wide ban goes on the organisation’s list for its days; a second one is skipped', async () => {
		const w = await seedWorld(env);
		const config = { action: 'ban', banScope: 'org', banDays: 7, count: 1 };
		const one = await rule(w, w.server.id, config);
		const two = await rule(w, w.server.id, config);
		await post(w.server.id, [ev(CHEAT)]);
		const [first] = await rowsOf(one);
		const [second] = await rowsOf(two);
		expect(first.params).toMatchObject({ scope: 'org', days: 7, reason: REASON });
		const done = await deliver(first.id, second.id);
		const [ban] = await bansOf(w, CHEAT);
		expect(ban.serverId).toBeNull();
		const days = (ban.entry.expiresAt!.getTime() - Date.now()) / 86400_000;
		expect(days).toBeGreaterThan(6.99);
		expect(days).toBeLessThanOrEqual(7);
		// whichever went second found the player already on the list
		expect(done.map((d) => d.state).sort()).toEqual(['delivered', 'skipped']);
		expect(done.find((d) => d.state === 'skipped')!.outcome).toBe(
			`${CHEAT} is already on the ban list of ${w.org.name}.`
		);
		expect(await bansOf(w, CHEAT)).toHaveLength(1);
	});

	test('a worker that loses ownership on its way to a ban writes nothing', async () => {
		const w = await seedWorld(env);
		const id = await rule(w, w.server.id, { action: 'ban', count: 1 });
		await post(w.server.id, [ev(CHEAT)]);
		const [row] = await rowsOf(id);
		// the handover lands while the ban's list is being looked up
		const real = listsModule.serverListOf;
		const lookup = spyOn(listsModule, 'serverListOf');
		lookup.mockImplementation(async (...args: Parameters<typeof real>) => {
			const list = await real(...args);
			await releaseOwnership(env);
			return list;
		});
		try {
			startDelivery(env);
			for (let i = 0; i < 60 && (await rowOf(row.id)).attempts === 0; i++) await Bun.sleep(50);
			await Bun.sleep(300);
			await stopDelivery();
		} finally {
			lookup.mockRestore();
			expect(await acquireOrRenew(env, 'kill-distance test')).toBe(true);
		}
		expect(await bansOf(w, CHEAT)).toHaveLength(0);
	});

	test('switching the rule off drops what it had queued, and a row decided under old settings is stopped at delivery', async () => {
		const w = await seedWorld(env);
		const id = await rule(w, w.server.id, { action: 'ban', count: 1 });
		await post(w.server.id, [ev(CHEAT)]);
		const [queued] = await rowsOf(id);
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
			params: { id: w.server.id, triggerId: id },
			body: { enabled: false }
		});
		expect(off.status).toBe(200);
		expect(await rowOf(queued.id)).toMatchObject({
			state: 'skipped',
			outcome: 'The rule was changed before this was sent.'
		});
		// back on; a row queued as an edit landed, which the edit's drop did not see
		await env.db.update(triggers).set({ enabled: true }).where(eq(triggers.id, id));
		invalidateTriggers(w.server.id);
		await post(w.server.id, [ev(MEDIC)]);
		const [late] = (await rowsOf(id)).filter((r) => r.target === MEDIC);
		await env.db
			.update(triggers)
			.set({
				config: validateConfig('kill_distance', {
					causes: [DEFIB],
					action: 'ban',
					count: 1,
					minDistanceM: 5000
				})
			})
			.where(eq(triggers.id, id));
		const [done] = await deliver(late.id);
		expect([done.state, done.outcome]).toEqual([
			'skipped',
			'The rule was changed before this was sent.'
		]);
		expect(await bansOf(w, CHEAT)).toHaveLength(0);
		expect(await bansOf(w, MEDIC)).toHaveLength(0);
	});

	test('a shorter ban already on the list is made to last as long as the rule’s; a longer one is left alone', async () => {
		const w = await seedWorld(env);
		const list = await listsModule.serverListOf(env, { id: w.server.id, orgId: w.org.id }, 'ban');
		await listsModule.grantEntry(env, list, {
			steamId: CHEAT,
			reason: 'spawn camping',
			expiresAt: new Date(Date.now() + 3600_000),
			addedByName: 'an admin'
		});
		await listsModule.grantEntry(env, list, {
			steamId: MEDIC,
			reason: 'cheating',
			expiresAt: null,
			addedByName: 'an admin'
		});
		const id = await rule(w, w.server.id, { action: 'ban', count: 1, banDays: 30 });
		await post(w.server.id, [ev(CHEAT), ev(MEDIC, { eventTime: 101 })]);
		const rows = await rowsOf(id);
		const done = await deliver(...rows.map((r) => r.id));
		const byTarget = new Map(rows.map((r, i) => [r.target, done[i]]));
		expect(byTarget.get(CHEAT)!.outcome).toBe(
			'Banned p801 here for 30 days: Defibrillator kill from 4057 m (the ban already there now lasts as long)'
		);
		expect(byTarget.get(MEDIC)!.state).toBe('skipped');
		const [cheat] = await bansOf(w, CHEAT);
		const days = (cheat.entry.expiresAt!.getTime() - Date.now()) / 86400_000;
		expect([cheat.entry.reason, cheat.entry.addedByName, days > 29.99]).toEqual([
			'spawn camping',
			'an admin',
			true
		]);
		const [medic] = await bansOf(w, MEDIC);
		expect(medic.entry.expiresAt).toBeNull();
		// the list's own record says the rule set the length, as an edit by hand would
		const [lengthened] = await auditOf(w.server.id, 'list.update', CHEAT);
		expect([lengthened.actorName, lengthened.category, lengthened.message]).toEqual([
			'trigger: Kill distance watch',
			'server',
			`Ban lengthened on ${(await env.db.select({ name: servers.name }).from(servers).where(eq(servers.id, w.server.id)))[0].name} for 30 days by a rule`
		]);
		expect(await auditOf(w.server.id, 'list.update', MEDIC)).toHaveLength(0);
	});

	test('saving the rule again with the same settings keeps what it queued; a change drops it', async () => {
		const w = await seedWorld(env);
		const config = { causes: [DEFIB], action: 'ban', count: 1 };
		const id = await rule(w, w.server.id, config);
		await post(w.server.id, [ev(CHEAT)]);
		const [queued] = await rowsOf(id);
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
		const save = (body: Record<string, unknown>) =>
			callApi(mod.PATCH, w.users.owner, {
				method: 'PATCH',
				params: { id: w.server.id, triggerId: id },
				body
			});
		// the editor sends the whole config with a rename, keys in its own order
		expect(
			(await save({ name: 'Defib watch', config: { count: 1, action: 'ban', causes: [DEFIB] } }))
				.status
		).toBe(200);
		expect((await rowOf(queued.id)).state).toBe('pending');
		expect((await save({ config: { ...config, minDistanceM: 200 } })).status).toBe(200);
		expect(await rowOf(queued.id)).toMatchObject({
			state: 'skipped',
			outcome: 'The rule was changed before this was sent.'
		});
	});

	test('an org-wide ban has every server of the organisation the worker watches take its lists again', async () => {
		const w = await seedWorld(env);
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const load = async (serverId: string) => {
			const [server] = await env.db.select().from(servers).where(eq(servers.id, serverId));
			const m = memoryFor(server, org);
			m.syncAt = 12345;
			return m;
		};
		const here = await load(w.server.id);
		const there = await load(w.otherServer.id);
		try {
			const id = await rule(w, w.server.id, { action: 'ban', banScope: 'org', count: 1 });
			await post(w.server.id, [ev(CHEAT)]);
			const [row] = await rowsOf(id);
			expect((await deliver(row.id))[0].state).toBe('delivered');
			expect([here.syncAt, there.syncAt]).toEqual([0, 0]);
		} finally {
			forgetMemory(w.server.id);
			forgetMemory(w.otherServer.id);
		}
	});

	test('the dry run replays the window per match through the same step', async () => {
		const w = await seedWorld(env);
		const received = new Date();
		const row = (
			killer: string,
			cause: string,
			distanceM: number,
			matchRow: number | null,
			eventTime: number
		) => ({
			ts: received,
			serverId: w.server.id,
			eventId: newId(),
			instanceId: 'i',
			matchId: 'm',
			matchRow,
			eventTime,
			map: 'Kavkazi',
			killerSteamId: killer,
			killerName: `p${killer.slice(-3)}`,
			victimSteamId: VICTIM,
			victimName: 'victim',
			cause,
			distanceM,
			tags: []
		});
		await env.db
			.insert(kills)
			.values([
				row(CHEAT, DEFIB, 4057, 9001, 10),
				row(CHEAT, 'ID.ITEM.DEFIBRILLATOR.STANDARD', 4053, 9001, 20),
				row(MEDIC, DEFIB, 2, 9001, 30),
				row(MEDIC, DEFIB, 3, 9001, 40),
				row(SNIPER, DEFIB, 900, 9001, 50),
				row(SNIPER, DEFIB, 950, 9002, 60),
				row(SNIPER, 'Id.Item.SV98', 1600, 9002, 70)
			]);
		const server = { ...w.server, name: 'one' } as Parameters<typeof dryRun>[1];
		const r = await dryRun(env, server, 'kill_distance', {
			causes: [DEFIB],
			action: 'ban',
			banDays: 3
		});
		expect(r.items.map((i) => i.text)).toEqual([
			`ban p801 (${CHEAT}) here for 3 days: Defibrillator kill from 4053 m (2 this match)`
		]);
		expect(r.notes).toContain(
			'4 kills with Defibrillator from 100 m or more in the window, counted per match.'
		);
	});

	test('the dry run from 0 m counts kills without a distance; from 1 m it does not', async () => {
		const w = await seedWorld(env);
		const at = new Date();
		const row = (killer: string, cause: string, distanceM: number | null, eventTime: number) => ({
			ts: at,
			serverId: w.server.id,
			eventId: newId(),
			instanceId: 'i',
			matchId: 'm',
			matchRow: 9101,
			eventTime,
			map: 'Kavkazi',
			killerSteamId: killer,
			killerName: `p${killer.slice(-3)}`,
			victimSteamId: VICTIM,
			victimName: 'victim',
			cause,
			distanceM,
			tags: []
		});
		await env.db
			.insert(kills)
			.values([
				row(CHEAT, HUMVEE_M249, null, 10),
				row(MEDIC, HUMVEE_M249, 35, 20),
				row(SNIPER, 'Id.Item.M249', 35, 30)
			]);
		const server = { ...w.server, name: 'one' } as Parameters<typeof dryRun>[1];
		const run = (minDistanceM: number) =>
			dryRun(env, server, 'kill_distance', {
				causes: [HUMVEE_M249],
				minDistanceM,
				count: 1,
				action: 'warn'
			});
		const any = await run(0);
		expect(any.items.map((i) => i.text)).toEqual([
			`warn p801 (${CHEAT}): Humvee M249 kill`,
			`warn p802 (${MEDIC}): Humvee M249 kill from 35 m`
		]);
		expect(any.notes).toContain(
			'2 kills with Humvee M249 at any distance in the window, counted per match.'
		);
		const far = await run(1);
		expect(far.items.map((i) => i.text)).toEqual([
			`warn p802 (${MEDIC}): Humvee M249 kill from 35 m`
		]);
		expect(far.notes).toContain(
			'1 kill with Humvee M249 from 1 m or more in the window, counted per match.'
		);
	});

	test('the dry run leaves out a kill just after the killer’s own death, and says so', async () => {
		const w = await seedWorld(env);
		const at = Date.now() - 600_000;
		const row = (
			killer: string,
			victim: string,
			cause: string,
			distanceM: number,
			eventTime: number,
			receivedMs: number
		) => ({
			ts: new Date(at + receivedMs),
			serverId: w.server.id,
			eventId: newId(),
			instanceId: 'i',
			matchId: 'm',
			matchRow: 9201,
			eventTime,
			map: 'Kavkazi',
			killerSteamId: killer,
			killerName: `p${killer.slice(-3)}`,
			victimSteamId: victim,
			victimName: `p${victim.slice(-3)}`,
			cause,
			distanceM,
			tags: []
		});
		await env.db
			.insert(kills)
			.values([
				row(ENEMY, GUNNER, ENEMY_GUN, 2297, 3383.97, 0),
				row(GUNNER, ENEMY, M4, 2295, 3388.23, 4000),
				row(GUNNER, VICTIM, M4, 2280, 3388.23, 4000),
				row(CHEAT, VICTIM, M4, 2300, 3394, 10_000),
				row(GUNNER, VICTIM, M4, 2300, 3445, 62_000)
			]);
		const server = { ...w.server, name: 'one' } as Parameters<typeof dryRun>[1];
		const r = await dryRun(env, server, 'kill_distance', {
			causes: [M4],
			minDistanceM: 1300,
			count: 1,
			action: 'kick'
		});
		expect(r.items.map((i) => i.text)).toEqual([
			`kick p801 (${CHEAT}): M4 kill from 2300 m`,
			`kick p806 (${GUNNER}): M4 kill from 2300 m`
		]);
		expect(r.notes).toContain(
			'2 kills with M4 from 1300 m or more in the window, counted per match.'
		);
		expect(r.notes).toContain(
			'2 more came within a minute of the killer’s own death and are not counted: a vehicle’s shell that lands after the vehicle was destroyed comes credited to the gunner’s own weapon.'
		);
	});

	test('nothing a person or a key can call runs a rule’s ban, flag, note or kill', async () => {
		const w = await seedWorld(env);
		const mod = await import(
			join(
				import.meta.dir,
				'..',
				'routes',
				'api',
				'servers',
				'[id]',
				'rcon',
				'[action]',
				'+server.ts'
			)
		);
		for (const action of [PANEL_BAN, KILL_DISTANCE_FLAG, KILL_DISTANCE_SKIP, RULE_KILL]) {
			const r = await callApi(mod.POST, w.users.owner, {
				method: 'POST',
				params: { id: w.server.id, action },
				body: { steamId: CHEAT, reason: 'x', days: 0, scope: 'org', name: 'x', message: 'x' }
			});
			expect([action, r.status, r.code]).toEqual([action, 404, 'unknown_action']);
		}
		expect(await bansOf(w, CHEAT)).toHaveLength(0);
	});
});
