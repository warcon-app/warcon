// The match events of Season 2's feed (match-feed.ts) through the worker's own looks at a
// scripted game, against a real database: the game's result of a match takes the place of the
// last look's (the match row, the players' totals, the match broadcast) whether it arrives before
// the look that sees the match end or just after it; a result naming other factions, or held too
// long, is not used; an abandoned match takes one that came while the server did not answer; and
// the match state reaches the live view, also for a worker started afterwards.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { OrgRow, ServerRow } from '$lib/server/access';
import { matches, organizations, outbox, servers, triggers } from '$lib/server/db/schema';
import { acquireOrRenew } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer, type ServerMemory } from '$lib/server/observe';
import { GameError, WardogsClient } from '$lib/server/rcon';
import { FEED_END_FRESH_MS, LATE_END_MS, onMatchFeed } from '$lib/server/match-feed';
import { parseEnd, type ParsedEnd } from '$lib/server/feed-core';
import { ingestBatch } from '$lib/server/feed';
import { liveView } from '$lib/server/live';
import { subscribe, type WarconEvent } from '$lib/server/events';
import { invalidateTriggers, validateConfig } from '$lib/server/triggers';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const VALKYRA = '76561198000052001';
const LONESTAR = '76561198000052002';

interface Game {
	map: string;
	/** Valkyra, Lonestar */
	scores: [number, number];
	/** looks left until it answers again */
	down: number;
}
interface Fixture {
	server: ServerRow;
	org: OrgRow;
	m: ServerMemory;
	g: Game;
}

/** match_ended as the game posts it (feed-core.test.ts has the host's own). */
const ended = (winner: string, scores: [string, number][]): ParsedEnd =>
	parseEnd({
		eventId: randomUUID(),
		type: 'match_ended',
		eventTime: 1800,
		matchId: randomUUID(),
		mapName: 'Kavkazi',
		players: 2,
		winningFaction: winner,
		factionScores: scores.map(([faction, score]) => ({ faction, score }))
	})!;

describe.skipIf(!hasTestDb)('match results and states from the feed', () => {
	let env: Env;
	let spy: ReturnType<typeof spyOn>;
	const games = new Map<string, Game>();
	const json = (body: unknown) => ({
		status: 200,
		statusText: 'OK',
		headers: { 'content-type': 'application/json' },
		text: JSON.stringify(body)
	});

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		expect(await acquireOrRenew(env, 'match-feed-result')).toBe(true);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`match-feed-${server.id}`
			);
			const raw = client.raw.bind(client);
			client.raw = async (method, path, body, headers) => {
				const g = games.get(server.id);
				if (!g || method !== 'GET' || (path !== '/v1/players' && path !== '/v1/status'))
					return raw(method, path, body, headers);
				if (g.down > 0) throw new GameError(502, 'connect ECONNREFUSED', 'unreachable');
				if (path === '/v1/players')
					return json({
						players: [
							{ steamId: VALKYRA, name: 'Vee', faction: 'Valkyra', kills: 1, deaths: 0, cash: 0 },
							{ steamId: LONESTAR, name: 'Ell', faction: 'Lonestar', kills: 0, deaths: 1, cash: 0 }
						],
						count: 2
					});
				return json({
					serverName: 'Feed results',
					map: g.map,
					experiences: [],
					players: { current: 2, max: 100 },
					factionScores: [
						{ name: 'Valkyra', colorHex: '#D86060', score: g.scores[0] },
						{ name: 'Lonestar', colorHex: '#5B95D8', score: g.scores[1] }
					],
					rotation: { nowIndex: 0, nextIndex: 1 }
				});
			};
			return client;
		});
	});

	afterAll(() => {
		spy.mockRestore();
		for (const id of games.keys()) forgetMemory(id);
	});

	const look = async (f: Fixture) => {
		f.m.playersIntervalMs = 1000;
		await observeServer(env, f.m, { status: true, players: true });
		if (f.g.down > 0) f.g.down--;
	};
	/** A server of its own, its match open after two looks, and a match broadcast rule on it. */
	const fresh = async (): Promise<Fixture> => {
		const w = await seedWorld(env);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		await env.db.insert(triggers).values({
			id: `broadcast-${server.id}`,
			serverId: server.id,
			orgId: org.id,
			kind: 'match_broadcast',
			name: 'Match broadcast',
			enabled: true,
			config: validateConfig('match_broadcast', {
				endMessage: '{faction} won · {scores}',
				startMessage: '',
				minPlayers: 1
			})
		});
		invalidateTriggers(server.id);
		forgetMemory(server.id);
		const g: Game = { map: 'Kavkazi', scores: [10, 8], down: 0 };
		games.set(server.id, g);
		const f = { server, org, m: memoryFor(server, org), g };
		await look(f);
		g.scores = [98, 97];
		await look(f);
		return f;
	};
	/** The scores fall back: the look sees the match end. */
	const nextMatch = async (f: Fixture) => {
		f.g.scores = [0, 0];
		await look(f);
	};
	const endedMatches = (serverId: string) =>
		env.db
			.select({ id: matches.id, finalScores: matches.finalScores, winner: matches.winner })
			.from(matches)
			.where(and(eq(matches.serverId, serverId), isNotNull(matches.endedAt)))
			.orderBy(asc(matches.id));
	const results = async (serverId: string) =>
		Object.fromEntries(
			(
				(await env.db.execute(
					// player_totals, kept by the triggers of migration 0038
					`SELECT steam_id, wins, losses, draws FROM player_totals WHERE server_id = '${serverId}'`
				)) as unknown as { steam_id: string; wins: number; losses: number; draws: number }[]
			).map((r) => [r.steam_id, [r.wins, r.losses, r.draws]])
		);
	const broadcasts = async (serverId: string) =>
		(
			await env.db
				.select({ params: outbox.params })
				.from(outbox)
				.where(eq(outbox.serverId, serverId))
				.orderBy(asc(outbox.id))
		).map((r) => (r.params as { message?: string }).message);

	test('a result that comes before the look that sees the end is the match it closes', async () => {
		const f = await fresh();
		// The last look saw Valkyra ahead; the game says Lonestar took it at the line.
		await onMatchFeed(env, f.m, {
			state: null,
			end: ended('Lonestar', [
				['Lonestar', 100],
				['Valkyra', 99]
			])
		});
		await nextMatch(f);
		expect(await endedMatches(f.server.id)).toEqual([
			{
				id: expect.any(Number),
				finalScores: [
					{ name: 'Lonestar', score: 100 },
					{ name: 'Valkyra', score: 99 }
				],
				winner: 'Lonestar'
			}
		]);
		expect(await results(f.server.id)).toEqual({ [LONESTAR]: [1, 0, 0], [VALKYRA]: [0, 1, 0] });
		expect(await broadcasts(f.server.id)).toEqual(['Lonestar won · Lonestar 100 · Valkyra 99']);
		// Used once: the next match ends on what its looks saw.
		f.g.scores = [40, 12];
		await look(f);
		await nextMatch(f);
		expect((await endedMatches(f.server.id)).map((r) => r.winner)).toEqual(['Lonestar', 'Valkyra']);
	});

	test("a result that comes just after the look corrects the match it closed, and its players' totals", async () => {
		const f = await fresh();
		await nextMatch(f);
		const [before] = await endedMatches(f.server.id);
		expect(before.winner).toBe('Valkyra');
		expect(await results(f.server.id)).toEqual({ [VALKYRA]: [1, 0, 0], [LONESTAR]: [0, 1, 0] });
		const late = ended('Lonestar', [
			['Lonestar', 100],
			['Valkyra', 99]
		]);
		await onMatchFeed(env, f.m, { state: null, end: late });
		expect(await endedMatches(f.server.id)).toEqual([
			{
				id: before.id,
				finalScores: [
					{ name: 'Lonestar', score: 100 },
					{ name: 'Valkyra', score: 99 }
				],
				winner: 'Lonestar'
			}
		]);
		expect(await results(f.server.id)).toEqual({ [LONESTAR]: [1, 0, 0], [VALKYRA]: [0, 1, 0] });
		// The game sending it again changes nothing, and it is not kept for the next match.
		await onMatchFeed(env, f.m, { state: null, end: late });
		expect(f.m.feedEnd).toBeNull();
		f.g.scores = [40, 12];
		await look(f);
		await nextMatch(f);
		expect((await endedMatches(f.server.id)).map((r) => r.winner)).toEqual(['Lonestar', 'Valkyra']);
	});

	test('a result naming other factions, or held too long, is not used', async () => {
		const f = await fresh();
		await onMatchFeed(env, f.m, {
			state: null,
			end: ended('Red', [
				['Red', 100],
				['Blue', 3]
			])
		});
		await nextMatch(f);
		f.g.scores = [5, 30];
		await look(f);
		// Long after that look closed the first match, a result comes and waits too long for its own.
		f.m.closed!.at -= LATE_END_MS + 1000;
		await onMatchFeed(env, f.m, {
			state: null,
			end: ended('Valkyra', [
				['Valkyra', 100],
				['Lonestar', 99]
			])
		});
		f.m.feedEnd!.at -= FEED_END_FRESH_MS + 1000;
		await nextMatch(f);
		expect(await endedMatches(f.server.id)).toEqual([
			{
				id: expect.any(Number),
				finalScores: [
					{ name: 'Valkyra', score: 98 },
					{ name: 'Lonestar', score: 97 }
				],
				winner: 'Valkyra'
			},
			{
				id: expect.any(Number),
				finalScores: [
					{ name: 'Lonestar', score: 30 },
					{ name: 'Valkyra', score: 5 }
				],
				winner: 'Lonestar'
			}
		]);
	});

	test('a match abandoned across an outage takes the result that came meanwhile', async () => {
		const f = await fresh();
		f.g.down = 3;
		for (let i = 0; i < 3; i++) await look(f);
		await onMatchFeed(env, f.m, {
			state: null,
			end: ended('Lonestar', [
				['Lonestar', 100],
				['Valkyra', 99]
			])
		});
		// Back on another map: no boundary was seen, so the open match is abandoned.
		f.g.map = 'Europe';
		f.g.scores = [0, 0];
		await look(f);
		expect(await endedMatches(f.server.id)).toEqual([
			{
				id: expect.any(Number),
				finalScores: [
					{ name: 'Lonestar', score: 100 },
					{ name: 'Valkyra', score: 99 }
				],
				winner: 'Lonestar'
			}
		]);
	});

	test('the state reaches the live view at once, and a worker started later reads it back', async () => {
		const f = await fresh();
		const seen: WarconEvent[] = [];
		const stop = subscribe((e) => seen.push(e));
		const at = new Date();
		const r = await ingestBatch(
			env,
			f.server.id,
			{
				serverId: randomUUID(),
				serverName: 'Feed results',
				events: [
					{
						eventId: randomUUID(),
						type: 'match_state',
						eventTime: 1,
						mapName: 'Kavkazi',
						state: 'MatchState.PostMatch'
					}
				]
			},
			at
		);
		await onMatchFeed(env, f.m, { state: r.state, end: r.end });
		stop();
		const state = { state: 'MatchState.PostMatch', map: 'Kavkazi', at: at.toISOString() };
		expect(seen.some((e) => e.type === 'live' && e.live.matchState?.state === state.state)).toBe(
			true
		);
		expect(liveView(f.m).matchState).toEqual(state);
		// The worker's own write of the row leaves the state alone.
		await look(f);
		forgetMemory(f.server.id);
		f.m = memoryFor(f.server, f.org);
		expect(liveView(f.m).matchState).toBeNull();
		await look(f);
		expect(liveView(f.m).matchState).toEqual(state);
	});

	test('a state for a server not looked at yet waits in memory, and does not show it as down', async () => {
		const w = await seedWorld(env);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		forgetMemory(server.id);
		const m = memoryFor(server, org);
		const seen: WarconEvent[] = [];
		const stop = subscribe((e) => seen.push(e));
		const state = { state: 'MatchState.PreMatch', map: 'Kavkazi', at: new Date().toISOString() };
		await onMatchFeed(env, m, { state, end: null });
		stop();
		forgetMemory(server.id);
		expect(seen.filter((e) => e.type === 'live')).toEqual([]);
		expect(m.matchState).toEqual(state);
	});
});
