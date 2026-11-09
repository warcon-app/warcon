// The kill feed against a real database: the game sends a batch again when it did not hear back,
// and the copy can arrive while the first is still being written.
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import type { Env } from '$lib/server/env';
import { kills, matchEvents, serverLive, servers } from '$lib/server/db/schema';
import { ingestBatch, mintFeedToken } from '$lib/server/feed';
import { resetRates } from '$lib/server/ratelimit';
import { POST as ingest } from '../routes/api/ingest/events/+server';
import { stubGateway } from './call';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const batchOf = (eventIds: string[]) => ({
	serverId: 'e9cf2544-b21e-4b80-9f12-8ec95ff58964',
	serverName: 'Test',
	events: eventIds.map((eventId, i) => ({
		eventId,
		type: 'killed',
		eventTime: 100 + i,
		matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
		mapName: 'Kavkazi',
		killerName: 'Alpha',
		killerSteamId: '76561198000000001',
		victimName: 'Bravo',
		victimSteamId: '76561198000000002',
		cause: 'Id.Item.AK74M',
		distance: 70,
		contextTags: []
	}))
});

// What Season 2 sends beside kills (feed-core.test.ts has them as posted).
const season2 = () => [
	{
		eventId: randomUUID(),
		type: 'player_joined',
		eventTime: 3157.0576,
		matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
		mapName: 'Kavkazi',
		playerName: 'Charlie',
		playerId: '-0000-000000000000',
		playerSteamId: '76561198000000003',
		players: 42
	},
	{
		eventId: randomUUID(),
		type: 'player_left',
		eventTime: 3164.3425,
		matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
		mapName: 'Kavkazi',
		playerName: 'Charlie',
		playerId: '-0000-000000000000',
		playerSteamId: '76561198000000003',
		players: 41
	},
	{
		eventId: randomUUID(),
		type: 'match_state',
		eventTime: 3185.7238,
		matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
		mapName: 'Kavkazi',
		state: 'MatchState.Playing.KOTH'
	},
	{
		eventId: randomUUID(),
		type: 'match_ended',
		eventTime: 7658.5545631460845,
		matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
		mapName: 'Kavkazi',
		players: 98,
		winningFaction: 'Lonestar',
		factionScores: [
			{ faction: 'Lonestar', score: 100 },
			{ faction: 'Valkyra', score: 0 },
			{ faction: 'Manticore', score: 59 }
		]
	}
];
const stateEvent = (state: string, mapName = 'Kavkazi') => ({
	eventId: randomUUID(),
	type: 'match_state',
	eventTime: 1,
	mapName,
	state
});

describe.skipIf(!hasTestDb)('kill feed ingest', () => {
	let env: Env;

	beforeAll(async () => {
		env = await testEnv();
	});

	const stored = async (serverId: string, eventId: string) =>
		(
			await env.db
				.select({ id: kills.eventId })
				.from(kills)
				.where(and(eq(kills.serverId, serverId), eq(kills.eventId, eventId)))
		).length;

	test('a batch that arrives many times at once is written once', async () => {
		const w = await seedWorld(env);
		const ids = [randomUUID(), randomUUID()];
		const results = await Promise.all(
			Array.from({ length: 12 }, () => ingestBatch(env, w.server.id, batchOf(ids)))
		);
		expect(results.reduce((n, r) => n + r.accepted, 0)).toBe(2);
		expect(results.reduce((n, r) => n + r.duplicates, 0)).toBe(22);
		for (const id of ids) expect(await stored(w.server.id, id)).toBe(1);
	});

	test("the same event id on another server is that server's own kill", async () => {
		const w = await seedWorld(env);
		const id = randomUUID();
		const [a, b] = await Promise.all([
			ingestBatch(env, w.server.id, batchOf([id])),
			ingestBatch(env, w.otherServer.id, batchOf([id]))
		]);
		expect([a.accepted, b.accepted]).toEqual([1, 1]);
	});

	test('joins, leaves, match states and results are counted and never written as kills', async () => {
		const w = await seedWorld(env);
		const id = randomUUID();
		const body = batchOf([id]);
		const r = await ingestBatch(env, w.server.id, {
			...body,
			events: [...season2(), ...body.events]
		});
		expect(r).toMatchObject({ accepted: 1, other: 4, skipped: 0, duplicates: 0 });
		const rows = await env.db
			.select({ eventId: kills.eventId })
			.from(kills)
			.where(eq(kills.serverId, w.server.id));
		expect(rows).toEqual([{ eventId: id }]);
	});

	test("the route answers what it counted, and only to the server's own token", async () => {
		const { fed } = stubGateway();
		resetRates();
		const w = await seedWorld(env);
		const [row] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const token = await mintFeedToken(env, new Request('http://localhost/'), w.users.owner!, row);
		const id = randomUUID();
		const body = batchOf([id]);
		const post = (authorization?: string) =>
			ingest({
				request: new Request('http://localhost/api/ingest/events', {
					method: 'POST',
					headers: { 'content-type': 'application/json', ...(authorization && { authorization }) },
					body: JSON.stringify({ ...body, events: [...season2(), ...body.events] })
				})
			} as unknown as RequestEvent);
		expect((await post()).status).toBe(401);
		expect((await post(`Bearer wkf_${'a'.repeat(43)}`)).status).toBe(401);
		expect(await stored(w.server.id, id)).toBe(0);
		const res = await post(`Bearer ${token}`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			ok: true,
			accepted: 1,
			other: 4,
			skipped: 0,
			duplicates: 0,
			repeats: 0
		});
		expect(await stored(w.server.id, id)).toBe(1);
		// The worker hears the state and the result once, from the accepted post only.
		expect(fed).toHaveLength(1);
		expect(fed[0].server).toBe(w.server.id);
		expect(fed[0].feed.state).toMatchObject({ state: 'MatchState.Playing.KOTH', map: 'Kavkazi' });
		expect(fed[0].feed.end).toMatchObject({ winner: 'Lonestar', players: 98 });
	});

	test('a batch with no kill in it still shows the feed is alive', async () => {
		const w = await seedWorld(env);
		const at = new Date('2026-10-15T11:20:00Z');
		const r = await ingestBatch(env, w.server.id, { ...batchOf([]), events: season2() }, at);
		expect(r).toMatchObject({ accepted: 0, other: 4, skipped: 0, kills: [] });
		const [live] = await env.db
			.select({ feedAt: serverLive.feedAt })
			.from(serverLive)
			.where(eq(serverLive.serverId, w.server.id));
		expect(live?.feedAt?.toISOString()).toBe(at.toISOString());
	});

	test('the match state is kept when it arrives, the last of a batch, until another replaces it', async () => {
		const w = await seedWorld(env);
		const state = async () =>
			(
				await env.db
					.select({ matchState: serverLive.matchState, feedAt: serverLive.feedAt })
					.from(serverLive)
					.where(eq(serverLive.serverId, w.server.id))
			)[0];
		const t1 = new Date('2026-10-15T11:00:00Z');
		const r = await ingestBatch(
			env,
			w.server.id,
			{
				...batchOf([]),
				events: [
					stateEvent('MatchState.PreMatch'),
					stateEvent('MatchState.PreMatch.WaitingForPlayers.PlayerCount', 'Zestafona')
				]
			},
			t1
		);
		const waiting = {
			state: 'MatchState.PreMatch.WaitingForPlayers.PlayerCount',
			map: 'NorthAmerica',
			at: t1.toISOString()
		};
		expect(r.state).toEqual(waiting);
		expect(r.end).toBeNull();
		expect((await state())?.matchState).toEqual(waiting);
		// Within the ten seconds the liveness stamp waits, a state is still written at once.
		const t2 = new Date(t1.getTime() + 2000);
		await ingestBatch(
			env,
			w.server.id,
			{ ...batchOf([]), events: [stateEvent('MatchState.Playing.KOTH')] },
			t2
		);
		expect(await state()).toEqual({
			matchState: { state: 'MatchState.Playing.KOTH', map: 'Kavkazi', at: t2.toISOString() },
			feedAt: t2
		});
		// Kills alone leave it as it is.
		const t3 = new Date(t2.getTime() + 60_000);
		const kill = await ingestBatch(env, w.server.id, batchOf([randomUUID()]), t3);
		expect(kill.state).toBeNull();
		expect((await state())?.matchState).toMatchObject({ state: 'MatchState.Playing.KOTH' });
	});

	const eventsOf = (serverId: string) =>
		env.db
			.select({
				seq: matchEvents.seq,
				instanceId: matchEvents.instanceId,
				type: matchEvents.type,
				eventTime: matchEvents.eventTime,
				matchId: matchEvents.matchId,
				map: matchEvents.map,
				state: matchEvents.state,
				players: matchEvents.players,
				winningFaction: matchEvents.winningFaction,
				scores: matchEvents.scores
			})
			.from(matchEvents)
			.where(eq(matchEvents.serverId, serverId))
			.orderBy(asc(matchEvents.ts), asc(matchEvents.seq));

	test('match states and results are kept as they came, in batch order, and a copy is not kept twice', async () => {
		const w = await seedWorld(env);
		const {
			events: [kill]
		} = batchOf([randomUUID()]);
		const [, , playing, end] = season2();
		const body = {
			...batchOf([]),
			events: [
				{ ...stateEvent('MatchState.PreMatch'), eventTime: 0.5 },
				kill,
				playing,
				end,
				{ ...stateEvent('MatchState.PostMatch'), matchId: end.matchId, eventTime: 7659 }
			]
		};
		const first = await ingestBatch(env, w.server.id, body);
		expect(first).toMatchObject({ accepted: 1, duplicates: 0, repeats: 0 });
		expect(first.state).toMatchObject({ state: 'MatchState.PostMatch' });
		expect(first.end).toMatchObject({ winner: 'Lonestar' });
		const rows = [
			{
				seq: 0,
				instanceId: body.serverId,
				type: 'match_state',
				eventTime: 0.5,
				matchId: null,
				map: 'Kavkazi',
				state: 'MatchState.PreMatch',
				players: null,
				winningFaction: null,
				scores: null
			},
			{
				seq: 2,
				instanceId: body.serverId,
				type: 'match_state',
				eventTime: 3185.7238,
				matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
				map: 'Kavkazi',
				state: 'MatchState.Playing.KOTH',
				players: null,
				winningFaction: null,
				scores: null
			},
			{
				seq: 3,
				instanceId: body.serverId,
				type: 'match_ended',
				eventTime: 7658.5545631460845,
				matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
				map: 'Kavkazi',
				state: null,
				players: 98,
				winningFaction: 'Lonestar',
				scores: [
					{ name: 'Lonestar', score: 100 },
					{ name: 'Manticore', score: 59 },
					{ name: 'Valkyra', score: 0 }
				]
			},
			{
				seq: 4,
				instanceId: body.serverId,
				type: 'match_state',
				eventTime: 7659,
				matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
				map: 'Kavkazi',
				state: 'MatchState.PostMatch',
				players: null,
				winningFaction: null,
				scores: null
			}
		];
		expect(await eventsOf(w.server.id)).toEqual(rows);
		// The game sends it again: nothing new is kept, written or handed on.
		const again = await ingestBatch(env, w.server.id, body);
		expect(again).toMatchObject({ accepted: 0, duplicates: 5, repeats: 0, state: null, end: null });
		expect(await eventsOf(w.server.id)).toEqual(rows);
	});

	test('a state the same as the last one kept is counted, and neither kept, written nor handed on', async () => {
		const w = await seedWorld(env);
		const live = async () =>
			(
				await env.db
					.select({ matchState: serverLive.matchState })
					.from(serverLive)
					.where(eq(serverLive.serverId, w.server.id))
			)[0]?.matchState;
		const playing = () => ({ ...stateEvent('MatchState.Playing.KOTH'), matchId: 'm1' });
		const t1 = new Date('2026-10-15T12:00:00Z');
		await ingestBatch(env, w.server.id, { ...batchOf([]), events: [playing()] }, t1);
		const again = await ingestBatch(
			env,
			w.server.id,
			{ ...batchOf([]), events: [playing(), playing()] },
			new Date(t1.getTime() + 2000)
		);
		expect(again).toMatchObject({ duplicates: 0, repeats: 2, state: null });
		expect(await eventsOf(w.server.id)).toHaveLength(1);
		expect(await live()).toMatchObject({ at: t1.toISOString() });
		// The same state from a game that has started again is the new run's: kept.
		const t3 = new Date(t1.getTime() + 60_000);
		const rebooted = await ingestBatch(
			env,
			w.server.id,
			{ ...batchOf([]), serverId: randomUUID(), events: [playing()] },
			t3
		);
		expect(rebooted).toMatchObject({ repeats: 0, state: { at: t3.toISOString() } });
		expect(await eventsOf(w.server.id)).toHaveLength(2);
		// Another state, then the first again: both kept.
		await ingestBatch(
			env,
			w.server.id,
			{ ...batchOf([]), events: [stateEvent('MatchState.PostMatch'), playing()] },
			new Date(t3.getTime() + 60_000)
		);
		expect((await eventsOf(w.server.id)).map((r) => r.state)).toEqual([
			'MatchState.Playing.KOTH',
			'MatchState.Playing.KOTH',
			'MatchState.PostMatch',
			'MatchState.Playing.KOTH'
		]);
	});
});
