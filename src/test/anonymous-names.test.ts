// A player in the game's anonymous mode ($lib/anonymous), end to end against the demo game and the
// database. Staff see both names: the player list, the live view and the past-players search carry
// the hidden name beside the player's own, the session keeps it, and either name finds them.
// Anyone else gets the name the game shows: the public status page lists them under the hidden
// name with no link, in the roster and in its kills, on the list or just gone from it, and so
// does the public page of a match they played hidden, for good.
//
// The second suite scripts the game's player list, so that nothing but the mode changes between
// two looks: the live row and the session row follow a change of mode at the look that sees it,
// a player off the list is named by what their session's last look saw (never by a hidden name
// they had left), and a feed that names a hidden player by the hidden name records no name of
// theirs.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import {
	matches,
	matchPlayers,
	organizations,
	playerAliases,
	playerSessions,
	servers
} from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { ingestBatch } from '$lib/server/feed';
import { onKillsIngested } from '$lib/server/feed-events';
import { readLiveRows } from '$lib/server/live';
import { MOCK_PASSWORD, mockHandle, setMockAnonymous } from '$lib/server/mockgame';
import {
	forgetMemory,
	liveKeyOf,
	memoryFor,
	observeServer,
	type ServerMemory
} from '$lib/server/observe';
import { dossier } from '$lib/server/players';
import { serverAccessFor } from '$lib/server/access';
import { WardogsClient } from '$lib/server/rcon';
import { seenFilters, seenPlayers } from '$lib/server/seen';
import { latestHiddenNames } from '$lib/server/sessions';
import { newId } from '$lib/server/http';
import type { PublicKill, PublicStatus } from '$lib/server/public';
import type { MatchView } from '$lib/matches';
import { load as publicMatchLoad } from '../routes/(public)/s/[id]/matches/[matchId]/+page.server';
import { load as publicCareerLoad } from '../routes/(public)/s/[id]/players/[steamId]/+page.server';
import { callApi, callLoad, stubGateway } from './call';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');

describe.skipIf(!hasTestDb)('Players in anonymous mode', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	let m: ServerMemory;
	/** the player whose anonymous mode the tests switch, another who never has it on, and the
	 *  hidden name the demo gives the first */
	let anon: { steamId: string; name: string };
	let plain: { steamId: string; name: string };
	let hidden = '';
	/** the match that ended with `anon` in the mode */
	let played = 0;
	const gameKey = (serverId: string) => `anon-${serverId}`;
	const look = (heartbeat = false) => {
		if (heartbeat) m.presence.heartbeatAt = 0;
		return observeServer(env, m, { status: true, players: true });
	};
	const session = async (steamId: string) =>
		(
			await env.db
				.select()
				.from(playerSessions)
				.where(and(eq(playerSessions.serverId, w.server.id), eq(playerSessions.steamId, steamId)))
		)[0];
	const publicPage = async (): Promise<PublicStatus> => {
		const { GET } = await import(join(ROUTES, 'public/servers/[id]', '+server.ts'));
		const got = await callApi(GET, null, { method: 'GET', params: { id: w.server.id } });
		expect(got.status).toBe(200);
		return (got.body as { server: PublicStatus }).server;
	};
	/** The public JSON of a match: its lines, awards and kills. */
	const publicMatch = async (matchId: number) => {
		const { GET } = await import(
			join(ROUTES, 'public/servers/[id]/matches/[matchId]', '+server.ts')
		);
		const got = await callApi(GET, null, {
			method: 'GET',
			params: { id: w.server.id, matchId: String(matchId) }
		});
		expect(got.status).toBe(200);
		return got.body as MatchView & { feed: PublicKill[] };
	};
	/** One kill as the feed posts it: both players under their own names, as the feeds seen do. */
	const kill = (killer: { steamId: string; name: string }, victim: typeof killer) => ({
		eventId: newId(),
		type: 'killed',
		eventTime: 500,
		matchId: 'boot',
		mapName: 'Kavkazi',
		killerName: killer.name,
		killerSteamId: killer.steamId,
		victimName: victim.name,
		victimSteamId: victim.steamId,
		cause: 'Id.Item.AK74M',
		distance: 4000,
		contextTags: []
	});

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		stubGateway();
		expect(await acquireOrRenew(env, 'anonymous names test')).toBe(true);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(
			async (_env, server) =>
				new WardogsClient(
					env,
					{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
					'demo',
					gameKey(server.id)
				)
		);
		await env.db
			.update(servers)
			.set({ publicStatus: true, publicLeaderboards: true, publicKills: true })
			.where(eq(servers.id, w.server.id));
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		forgetMemory(server.id);
		m = memoryFor(server, org);
		m.playersIntervalMs = 1000;
		await look();
		expect(m.players.length).toBeGreaterThan(2);
		[anon, plain] = m.players.map((p) => ({ steamId: p.steamId, name: p.name }));
	});

	afterAll(async () => {
		forgetMemory(w.server.id);
		spy?.mockRestore();
		await releaseOwnership(env);
	});

	test('nobody is anonymous until the game says so', async () => {
		expect(
			m.players.filter((p) => p.steamId === anon.steamId || p.steamId === plain.steamId)
		).toEqual([
			expect.not.objectContaining({ hiddenName: expect.anything() }),
			expect.not.objectContaining({ hiddenName: expect.anything() })
		]);
		expect((await session(anon.steamId)).hiddenName).toBeNull();
		const page = await publicPage();
		expect(page.roster.find((r) => r.name === anon.name)?.steamId).toBe(anon.steamId);
	});

	test('a look keeps the hidden name of a player in anonymous mode: in memory, in the live row and on their session', async () => {
		expect(setMockAnonymous(gameKey(w.server.id), anon.steamId, true)).toBe(true);
		await look(true);
		const row = m.players.find((p) => p.steamId === anon.steamId)!;
		expect(typeof row.hiddenName).toBe('string');
		hidden = row.hiddenName!;
		expect(hidden).toMatch(/^[A-Z][a-z]{2,8}$/);
		expect(row.name).toBe(anon.name);
		// every player has a hidden name in the game; only the one in use is kept
		expect(m.players.find((p) => p.steamId === plain.steamId)).not.toHaveProperty('hiddenName');
		const live = (await readLiveRows(env, [w.server.id])).get(w.server.id)!;
		expect(live.players.find((p) => p.steamId === anon.steamId)?.hiddenName).toBe(hidden);
		expect((await session(anon.steamId)).hiddenName).toBe(hidden);
		expect((await session(anon.steamId)).name).toBe(anon.name);
		expect((await session(plain.steamId)).hiddenName).toBeNull();
	});

	test('staff are given both names by the players read, a key that holds View included', async () => {
		const { GET } = await import(join(ROUTES, 'servers/[id]/rcon/[action]', '+server.ts'));
		// the players read goes to the game: through the worker here, as the route's gateway would
		const { setGateway } = await import('$lib/server/gateway');
		const { localGateway } = await import('$lib/server/gateway-local');
		setGateway(localGateway);
		try {
			for (const who of [w.users.viewer, w.users.keyView]) {
				const got = await callApi(GET, who, {
					method: 'GET',
					params: { id: w.server.id, action: 'players' }
				});
				expect(got.status).toBe(200);
				const players = (
					got.body as {
						result: { players: { steamId: string; name: string; hiddenName?: string }[] };
					}
				).result.players;
				expect(players.find((p) => p.steamId === anon.steamId)).toMatchObject({
					name: anon.name,
					hiddenName: hidden
				});
			}
			for (const who of [null, w.users.outsider])
				expect(
					(
						await callApi(GET, who, {
							method: 'GET',
							params: { id: w.server.id, action: 'players' }
						})
					).status
				).toBe(who ? 404 : 401);
		} finally {
			stubGateway();
		}
	});

	test('the public status page shows them as the game does: the hidden name, and no link', async () => {
		await ingestBatch(env, w.server.id, {
			serverId: 'i',
			serverName: 'x',
			events: [kill(anon, plain), kill(plain, anon)]
		});
		const page = await publicPage();
		const mine = page.roster.filter((r) => r.name === hidden);
		expect(mine.length).toBeGreaterThan(0);
		for (const r of mine) expect(r.steamId).toBeNull();
		// everyone else is linked as before
		expect(page.roster.find((r) => r.name === plain.name)?.steamId).toBe(plain.steamId);
		const ours = page.kills!.filter(
			(k) =>
				[k.killer?.name, k.victim.name].includes(hidden) &&
				[k.killer?.name, k.victim.name].includes(plain.name)
		);
		expect(ours.map((k) => [k.killer?.name, k.victim.name])).toEqual(
			expect.arrayContaining([
				[hidden, plain.name],
				[plain.name, hidden]
			])
		);
		// nothing the public is sent names them or carries their SteamID
		const sent = JSON.stringify(page);
		expect(sent).not.toContain(anon.name);
		expect(sent).not.toContain(anon.steamId);
	});

	test('once they have left the list their last kills stay under the hidden name', async () => {
		// the list without them (a look's view, not the game's: the session is what answers)
		const live = (await readLiveRows(env, [w.server.id])).get(w.server.id)!;
		const without = { ...live, players: live.players.filter((p) => p.steamId !== anon.steamId) };
		const { hiddenNamesFor, publicStatus, requirePublicServer } =
			await import('$lib/server/public');
		const { recentKills } = await import('$lib/server/feed');
		const { EMPTY_FILTER } = await import('$lib/kills');
		const kills = await recentKills(env, w.server.id, null, 20, EMPTY_FILTER);
		const names = await hiddenNamesFor(env, w.server.id, without, kills);
		expect(names.get(anon.steamId)).toBe(hidden);
		expect(names.has(plain.steamId)).toBe(false);
		const ps = await requirePublicServer(env, w.server.id, 'status');
		const sent = JSON.stringify(publicStatus(ps, without, kills, names));
		expect(sent).toContain(hidden);
		expect(sent).not.toContain(anon.name);
		expect(sent).not.toContain(anon.steamId);
		// the read behind it: the newest session's word, for those who have one
		expect(await latestHiddenNames(env.db, [w.server.id], [anon.steamId, plain.steamId])).toEqual(
			new Map([[anon.steamId, hidden]])
		);
		expect(await latestHiddenNames(env.db, [w.otherServer.id], [anon.steamId])).toEqual(new Map());
	});

	test('staff find them by either name, and the player page says when they played under it', async () => {
		const find = async (q: string) =>
			(
				await seenPlayers(env, {
					orgId: w.org.id,
					serverIds: [w.server.id],
					filters: { ...seenFilters(new URLSearchParams({ q })), serverId: '' },
					limit: 20,
					offset: 0
				})
			).players;
		const byHidden = await find(hidden.toLowerCase());
		expect(byHidden.find((p) => p.steamId === anon.steamId)).toMatchObject({
			name: anon.name,
			hiddenNames: [hidden]
		});
		expect((await find(anon.name)).map((p) => p.steamId)).toContain(anon.steamId);
		expect((await find(plain.name)).find((p) => p.steamId === plain.steamId)?.hiddenNames).toEqual(
			[]
		);
		// another server of the organisation knows nothing of it
		expect(
			(
				await seenPlayers(env, {
					orgId: w.org.id,
					serverIds: [w.otherServer.id],
					filters: { ...seenFilters(new URLSearchParams({ q: hidden })), serverId: '' },
					limit: 20,
					offset: 0
				})
			).players
		).toEqual([]);
		// the route a Players tab asks: View, on this server
		const { GET } = await import(join(ROUTES, 'servers/[id]/players/seen', '+server.ts'));
		const asked = (who: World['users'][keyof World['users']]) =>
			callApi(GET, who, { method: 'GET', params: { id: w.server.id }, query: `q=${hidden}` });
		expect((await asked(w.users.viewer)).status).toBe(200);
		expect((await asked(w.users.outsider)).status).toBe(404);
		expect((await asked(null)).status).toBe(401);

		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const access = (await serverAccessFor(env, w.users.viewer!, w.server.id))!;
		const page = await dossier(env, w.users.viewer!, server, access, anon.steamId);
		expect(page.name).toBe(anon.name);
		expect(page.hiddenNames).toEqual([expect.objectContaining({ name: hidden, sessions: 1 })]);
		expect(page.recent[0]).toMatchObject({ name: anon.name, hiddenName: hidden });
		const other = await dossier(env, w.users.viewer!, server, access, plain.steamId);
		expect(other.hiddenNames).toEqual([]);
	});

	test('a match they played hidden: its public page names them as the game did, the panel both ways', async () => {
		await ingestBatch(env, w.server.id, {
			serverId: 'i',
			serverName: 'x',
			events: [kill(anon, plain), kill(plain, anon)]
		});
		// the game ends the match; the look that sees it closes the match and everyone's line of it
		const over = mockHandle(gameKey(w.server.id), 'POST', '/v1/match/end', {
			authorization: `Bearer ${MOCK_PASSWORD}`
		});
		expect(over.status).toBe(200);
		await look();
		const [match] = await env.db
			.select({ id: matches.id })
			.from(matches)
			.where(and(eq(matches.serverId, w.server.id), isNotNull(matches.endedAt)))
			.orderBy(desc(matches.id))
			.limit(1);
		expect(match).toBeDefined();
		played = match.id;
		const rows = await env.db.select().from(matchPlayers).where(eq(matchPlayers.matchId, played));
		expect(rows.find((r) => r.steamId === anon.steamId)).toMatchObject({
			name: anon.name,
			hiddenName: hidden
		});
		expect(rows.find((r) => r.steamId === plain.steamId)?.hiddenName).toBeNull();

		const page = await publicMatch(played);
		expect(page.lines.length).toBe(rows.length);
		// their line: the hidden name, and in place of the SteamID nothing a career page answers to
		const masked = page.lines.filter((l) => !/^\d{17}$/.test(l.steamId));
		expect(masked.map((l) => l.name)).toContain(hidden);
		for (const l of masked) expect(l).not.toHaveProperty('hiddenName');
		expect(page.lines.find((l) => l.steamId === plain.steamId)?.name).toBe(plain.name);
		// the kills of the match name them the same way
		expect(page.feed.map((k) => [k.killer?.name, k.victim.name])).toEqual(
			expect.arrayContaining([
				[hidden, plain.name],
				[plain.name, hidden]
			])
		);
		// and the page a browser is sent holds the same and no more
		const load = await callLoad(publicMatchLoad, null, {
			params: { id: w.server.id, matchId: String(played) }
		});
		expect(load.status).toBe(200);
		for (const sent of [JSON.stringify(page), JSON.stringify(load.body)]) {
			expect(sent).toContain(hidden);
			expect(sent).not.toContain(anon.name);
			expect(sent).not.toContain(anon.steamId);
		}

		// the panel's match page is the staff's: both names, to whoever may view the server
		const { GET } = await import(join(ROUTES, 'servers/[id]/matches/[matchId]', '+server.ts'));
		const asked = (who: World['users'][keyof World['users']]) =>
			callApi(GET, who, { method: 'GET', params: { id: w.server.id, matchId: String(played) } });
		for (const who of [w.users.viewer, w.users.keyView]) {
			const got = await asked(who);
			expect(got.status).toBe(200);
			expect(
				(got.body as unknown as MatchView).lines.find((l) => l.steamId === anon.steamId)
			).toMatchObject({ name: anon.name, hiddenName: hidden });
		}
		expect((await asked(w.users.outsider)).status).toBe(404);
		expect((await asked(null)).status).toBe(401);

		// Their public career, under their own name, does not list that match: its figures are the
		// hidden line's. The panel's career does, and the player who played it openly has it on both.
		const career = async (steamId: string, publicly: boolean) => {
			const { GET: route } = await import(
				join(
					ROUTES,
					publicly
						? 'public/servers/[id]/players/[steamId]'
						: 'servers/[id]/players/[steamId]/career',
					'+server.ts'
				)
			);
			const got = await callApi(route, publicly ? null : w.users.viewer, {
				method: 'GET',
				params: { id: w.server.id, steamId }
			});
			expect(got.status).toBe(200);
			const body = got.body as { career: { matches: number; last: { matchId: number }[] } };
			return { matches: body.career.matches, last: body.career.last.map((l) => l.matchId) };
		};
		const theirs = await career(anon.steamId, true);
		expect(theirs.last).not.toContain(played);
		expect(theirs.matches).toBe((await career(anon.steamId, false)).matches);
		expect((await career(anon.steamId, false)).last).toContain(played);
		expect((await career(plain.steamId, true)).last).toContain(played);

		// The other player's public career: its most killed and nemeses are counted from these very
		// kills and link each player's career, so the one in the mode is in neither.
		const { combatSummary } = await import('$lib/server/players');
		const counted = (await combatSummary(env, [w.server.id], plain.steamId))!;
		expect(counted.victims.map((v) => v.steamId)).toContain(anon.steamId);
		expect(counted.nemeses.map((n) => n.steamId)).toContain(anon.steamId);
		const theirPage = await callLoad(publicCareerLoad, null, {
			params: { id: w.server.id, steamId: plain.steamId }
		});
		expect(theirPage.status).toBe(200);
		const shown = (theirPage.body as { combat: typeof counted }).combat;
		expect(shown.kills).toBe(counted.kills);
		expect(shown.victims.map((v) => v.steamId)).not.toContain(anon.steamId);
		expect(shown.nemeses.map((n) => n.steamId)).not.toContain(anon.steamId);
		const sentCareer = JSON.stringify(theirPage.body);
		expect(sentCareer).not.toContain(anon.steamId);
		expect(sentCareer).not.toContain(anon.name);
		// the hidden player's own public career page is theirs as ever, less the match
		const ownPage = await callLoad(publicCareerLoad, null, {
			params: { id: w.server.id, steamId: anon.steamId }
		});
		expect(ownPage.status).toBe(200);
		expect(JSON.stringify(ownPage.body)).not.toContain(hidden);
		const listed = (body: unknown) =>
			(body as { career: { last: { matchId: number }[] } }).career.last.map((l) => l.matchId);
		expect(listed(ownPage.body)).not.toContain(played);
		expect(listed(theirPage.body)).toContain(played);
	});

	test('the mode switched off again: the list says so at once, the session keeps what was', async () => {
		setMockAnonymous(gameKey(w.server.id), anon.steamId, false);
		await look(true);
		expect(m.players.find((p) => p.steamId === anon.steamId)).not.toHaveProperty('hiddenName');
		const page = await publicPage();
		expect(page.roster.find((r) => r.name === anon.name)?.steamId).toBe(anon.steamId);
		// the session was played under that name for a while: staff can still find it
		expect((await session(anon.steamId)).hiddenName).toBe(hidden);
		// and the match they played hidden does not come to name them afterwards
		const sent = JSON.stringify(await publicMatch(played));
		expect(sent).toContain(hidden);
		expect(sent).not.toContain(anon.name);
		expect(sent).not.toContain(anon.steamId);
	});
});

describe.skipIf(!hasTestDb)('Players in anonymous mode, on a scripted game', () => {
	const P = '76561198000000971';
	const Q = '76561198000000972';
	const R = '76561198000000973';
	const S = '76561198000000974';
	const SIDE: Record<string, string> = {
		[P]: 'Valkyra',
		[Q]: 'Lonestar',
		[R]: 'Lonestar',
		[S]: 'Valkyra'
	};
	const nameOf = (steamId: string) => `s${steamId.slice(-3)}`;
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	let m: ServerMemory;
	/** who the game lists, and who of them is in anonymous mode, as whom */
	let listed: string[] = [];
	const hiddenAs = new Map<string, string>();
	const answer = (body: unknown) => ({
		status: 200,
		statusText: 'OK',
		headers: { 'content-type': 'application/json' },
		text: JSON.stringify(body)
	});
	/** A look at the game with these players on. No heartbeat is due: what a look writes of a
	 *  session between heartbeats is what is under test. */
	const look = async (...on: string[]) => {
		listed = on;
		m.playersIntervalMs = 1000;
		m.presence.heartbeatAt = Date.now();
		await observeServer(env, m, { status: true, players: true });
	};
	const liveOf = async () => (await readLiveRows(env, [w.server.id])).get(w.server.id)!.players;
	const rowOf = async (steamId: string) =>
		(
			await env.db
				.select()
				.from(playerSessions)
				.where(and(eq(playerSessions.serverId, w.server.id), eq(playerSessions.steamId, steamId)))
				.orderBy(desc(playerSessions.id))
				.limit(1)
		)[0];
	let clock = 700;
	/** One kill as the feed posts it, each player under the name given (their own by default). */
	const kill = (killer: string, victim: string, killerName = nameOf(killer)) => ({
		eventId: newId(),
		type: 'killed',
		eventTime: clock++,
		matchId: 'boot',
		mapName: 'Kavkazi',
		killerName,
		killerSteamId: killer,
		victimName: nameOf(victim),
		victimSteamId: victim,
		cause: 'Id.Item.AK74M',
		distance: 4000,
		contextTags: []
	});
	const post = async (...events: ReturnType<typeof kill>[]) => {
		const r = await ingestBatch(env, w.server.id, { serverId: 'i', serverName: 'x', events });
		await onKillsIngested(env, w.server.id, r.kills);
		return events.map((e) => e.eventId);
	};
	/** The public status page's kills among these, oldest first, as killer and victim names. */
	const publicKills = async (eventIds: string[]) => {
		const { GET } = await import(join(ROUTES, 'public/servers/[id]', '+server.ts'));
		const got = await callApi(GET, null, { method: 'GET', params: { id: w.server.id } });
		expect(got.status).toBe(200);
		const page = (got.body as { server: PublicStatus }).server;
		const byId = new Map(page.kills!.map((k) => [k.eventId, [k.killer?.name, k.victim.name]]));
		return {
			roster: page.roster,
			kills: eventIds.map((id) => byId.get(id)),
			sent: JSON.stringify(page)
		};
	};

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		stubGateway();
		expect(await acquireOrRenew(env, 'anonymous names, scripted')).toBe(true);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`anon-scripted-${server.id}`
			);
			const raw = client.raw.bind(client);
			client.raw = async (method, path, body, headers) => {
				if (method === 'GET' && path === '/v1/players')
					return answer({
						players: listed.map((steamId) => ({
							name: nameOf(steamId),
							steamId,
							faction: SIDE[steamId],
							// everyone has a hidden name; it is in use for some
							hiddenName: hiddenAs.get(steamId) ?? 'Quail',
							anonymous: hiddenAs.has(steamId),
							kills: 0,
							deaths: 0,
							cash: 0
						}))
					});
				if (method === 'GET' && path === '/v1/status')
					return answer({
						serverName: 'Scripted',
						map: 'Kavkazi',
						experiences: [],
						players: { current: listed.length, max: 100 },
						factionScores: [
							{ name: 'Valkyra', colorHex: '#D86060', score: 10 },
							{ name: 'Lonestar', colorHex: '#5B95D8', score: 8 }
						],
						rotation: { nowIndex: 0, nextIndex: 1 }
					});
				return raw(method, path, body, headers);
			};
			return client;
		});
		await env.db
			.update(servers)
			.set({ publicStatus: true, publicKills: true })
			.where(eq(servers.id, w.server.id));
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		forgetMemory(server.id);
		m = memoryFor(server, org);
		await look(P, Q, R);
		await look(P, Q, R);
	});

	afterAll(async () => {
		forgetMemory(w.server.id);
		spy?.mockRestore();
		await releaseOwnership(env);
	});

	test('the live row follows a change of mode at the look that sees it, with nothing else changed', async () => {
		expect((await liveOf()).filter((p) => p.hiddenName)).toEqual([]);
		// what decides a rewrite of the row counts who is hidden, and as whom
		const open = liveKeyOf(m);
		const asFalcon = liveKeyOf({
			...m,
			players: m.players.map((p) => (p.steamId === P ? { ...p, hiddenName: 'Falcon' } : p))
		});
		const asHeron = liveKeyOf({
			...m,
			players: m.players.map((p) => (p.steamId === P ? { ...p, hiddenName: 'Heron' } : p))
		});
		expect(new Set([open, asFalcon, asHeron]).size).toBe(3);
		// and the row itself: the same three players a moment later, one of them now hidden
		hiddenAs.set(P, 'Falcon');
		await look(P, Q, R);
		expect((await liveOf()).map((p) => [p.steamId, p.hiddenName])).toEqual([
			[P, 'Falcon'],
			[Q, undefined],
			[R, undefined]
		]);
		hiddenAs.delete(P);
		await look(P, Q, R);
		expect((await liveOf()).filter((p) => p.hiddenName)).toEqual([]);
	});

	test('a session row says what its player is seen as at the look that changes it, a join included', async () => {
		// P went into the mode and out of it in the test above, between two heartbeats
		expect(await rowOf(P)).toMatchObject({ name: 's971', hiddenName: 'Falcon', anonymous: false });
		expect(await rowOf(Q)).toMatchObject({ hiddenName: null, anonymous: false });
		// R goes into the mode mid-session; S joins already in it
		hiddenAs.set(R, 'Heron');
		hiddenAs.set(S, 'Ibex');
		await look(P, Q, R, S);
		expect(await rowOf(R)).toMatchObject({ name: 's973', hiddenName: 'Heron', anonymous: true });
		expect(await rowOf(S)).toMatchObject({ name: 's974', hiddenName: 'Ibex', anonymous: true });
		// R leaves it again: the name stays as the session's record, and is no longer in use
		hiddenAs.delete(R);
		await look(P, Q, R, S);
		expect(await rowOf(R)).toMatchObject({ hiddenName: 'Heron', anonymous: false });
		expect(m.presence.open.get(R)).toMatchObject({ hiddenName: 'Heron', anonymous: false });
	});

	test('off the list, a player is named as their last look had them: never by a hidden name they had left', async () => {
		// S is in the mode; R was and has left it; both kill P while all are listed
		const ids = await post(kill(S, P), kill(R, P));
		const listedView = await publicKills(ids);
		expect(listedView.kills).toEqual([
			['Ibex', 's971'],
			['s973', 's971']
		]);
		// a map change empties the list for a moment: everyone is off it, their sessions still open
		await look();
		expect(m.players).toEqual([]);
		expect(m.presence.open.size).toBe(4);
		const emptied = await publicKills(ids);
		expect(emptied.roster).toEqual([]);
		expect(emptied.kills).toEqual(listedView.kills);
		expect(emptied.sent).not.toContain('Heron');
		expect(emptied.sent).not.toContain('s974');
		// the read behind it
		expect(await latestHiddenNames(env.db, [w.server.id], [P, Q, R, S])).toEqual(
			new Map([[S, 'Ibex']])
		);
		// then they have all left for good; Q's last look, never written, saw them in the mode
		const q = m.presence.open.get(Q)!;
		q.hiddenName = 'Owl';
		q.anonymous = true;
		for (const s of m.presence.open.values()) s.lastSeen = Date.now() - 120_000;
		await look();
		expect(m.presence.open.size).toBe(0);
		expect(await rowOf(Q)).toMatchObject({ hiddenName: 'Owl', anonymous: true });
		expect((await rowOf(Q)).leftAt).not.toBeNull();
		expect(await rowOf(S)).toMatchObject({ hiddenName: 'Ibex', anonymous: true });
		expect(await rowOf(R)).toMatchObject({ hiddenName: 'Heron', anonymous: false });
		expect((await publicKills(ids)).kills).toEqual(listedView.kills);
	});

	test('a feed that names a hidden player by the hidden name records no name of theirs', async () => {
		hiddenAs.clear();
		hiddenAs.set(S, 'Ibex');
		await look(P, Q, S);
		// the feed gives S the hidden name, and Q a name the list does not have for them
		await post(kill(S, P, 'Ibex'), kill(Q, P, 'Queue'));
		const kept = await env.db
			.select({ steamId: playerAliases.steamId, name: playerAliases.name })
			.from(playerAliases)
			.where(eq(playerAliases.serverId, w.server.id));
		expect(kept).toEqual([{ steamId: Q, name: 'Queue' }]);
		// were one on record all the same (a worker that had not seen the list yet), the past-players
		// search does not list it among the names the feed made up for them
		const at = new Date();
		await env.db
			.insert(playerAliases)
			.values({ serverId: w.server.id, steamId: S, name: 'Ibex', firstSeen: at, lastSeen: at });
		const { players } = await seenPlayers(env, {
			orgId: w.org.id,
			serverIds: [w.server.id],
			filters: { ...seenFilters(new URLSearchParams()), serverId: '' },
			limit: 20,
			offset: 0
		});
		const seen = (steamId: string) => players.find((p) => p.steamId === steamId)!;
		expect([seen(S).hiddenNames, seen(S).feedNames]).toEqual([['Ibex'], []]);
		expect(seen(Q).feedNames).toEqual(['Queue']);
	});
});
