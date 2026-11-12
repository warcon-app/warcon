// Boards and careers are summed from each player's line of every match that ended; these check
// the reads against a database.
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { matches, matchPlayers, playerSessions } from '$lib/server/db/schema';
import { loadBoard, loadCareer, riskPerformanceFor } from '$lib/server/leaderboards';
import { parseBoardQuery } from '$lib/leaderboard';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const STEAM = '76561198000000061';
const OTHER = '76561198000000062';
const HOUR = 3_600_000;

describe.skipIf(!hasTestDb)('career and boards from the match rows', () => {
	let env: Env;

	beforeAll(async () => {
		env = await testEnv();
	});

	const scores = [
		{ name: 'Lonestar', score: 100 },
		{ name: 'Wagner', score: 40 }
	];

	test('a line on the holding team has no result; the totals are the scoreboard counters', async () => {
		const w = await seedWorld(env);
		const t0 = Date.now() - 10 * HOUR;
		const [first, second, open] = await env.db
			.insert(matches)
			.values([
				{
					serverId: w.server.id,
					startedAt: new Date(t0),
					endedAt: new Date(t0 + HOUR),
					map: 'Europe',
					finalScores: scores,
					winner: 'Lonestar'
				},
				{
					serverId: w.server.id,
					startedAt: new Date(t0 + 2 * HOUR),
					endedAt: new Date(t0 + 3 * HOUR),
					map: 'Kavkazi',
					finalScores: scores,
					winner: 'Lonestar'
				},
				{ serverId: w.server.id, startedAt: new Date(t0 + 4 * HOUR), map: 'Kavkazi' }
			])
			.returning({ id: matches.id });
		const line = (matchId: number, faction: string, kills: number, deaths: number, extra = {}) => ({
			matchId,
			serverId: w.server.id,
			steamId: STEAM,
			name: 'ARTEC',
			faction,
			seconds: 1800,
			kills,
			deaths,
			...extra
		});
		await env.db.insert(matchPlayers).values([
			line(first.id, 'White', 5, 1, { headshots: 2, killStreak: 4 }),
			line(second.id, 'Wagner', 3, 2, { killStreak: 2, deathStreak: 2, cashDelta: 250 }),
			// the match in progress: a leaver's line, not on any board yet
			line(open.id, 'Wagner', 40, 0)
		]);
		await env.db.insert(playerSessions).values([
			{
				serverId: w.server.id,
				steamId: STEAM,
				name: 'ARTEC',
				faction: 'Wagner',
				joinedAt: new Date(t0),
				lastSeen: new Date(t0 + HOUR),
				leftAt: new Date(t0 + HOUR),
				cash: 9_000,
				seedSeconds: 1800
			},
			{
				serverId: w.server.id,
				steamId: STEAM,
				name: 'ARTEC',
				faction: 'Wagner',
				joinedAt: new Date(t0 + 2 * HOUR),
				lastSeen: new Date(t0 + 3 * HOUR),
				leftAt: new Date(t0 + 3 * HOUR),
				cash: 12_000
			}
		]);

		const career = await loadCareer(env, {
			serverId: w.server.id,
			orgId: w.org.id,
			ids: [w.server.id],
			nameOf: new Map(),
			steamId: STEAM
		});
		expect(career).toMatchObject({
			matches: 2,
			wins: 0,
			losses: 1,
			draws: 0,
			kills: 8,
			deaths: 3,
			minutes: 60,
			headshots: 2,
			killStreak: 4,
			deathStreak: 2
		});
		expect(career.last.map((m) => [m.map, m.faction, m.result, m.kills, m.cashDelta])).toEqual([
			['Kavkazi', 'Wagner', 'loss', 3, 250],
			['Europe', 'White', null, 5, 0]
		]);
		expect(career.maps).toEqual([
			{ key: 'Europe', matches: 1, wins: 0, losses: 0, draws: 0, kills: 5, deaths: 1 },
			{ key: 'Kavkazi', matches: 1, wins: 0, losses: 1, draws: 0, kills: 3, deaths: 2 }
		]);

		const board = await loadBoard(
			env,
			[w.server.id],
			parseBoardQuery(new URLSearchParams('minMinutes=0&range=30d')),
			w.org.id
		);
		const row = board.rows.find((r) => r.steamId === STEAM);
		expect(row).toMatchObject({
			matches: 2,
			wins: 0,
			losses: 1,
			kills: 8,
			deaths: 3,
			headshots: 2,
			killStreak: 4,
			minutes: 120,
			seedMinutes: 30
		});
		// the sessions' cash summed: each session banks its matches' cash like kills
		expect(row?.cash).toBe(21_000);
		// no feed on the seeded server: the scoreboard's kills show all the same
		expect(board.hasFeed).toBe(false);

		const perf = await riskPerformanceFor(env, [w.server.id], [STEAM]);
		expect(perf.get(STEAM)).toMatchObject({ matches: 2, losses: 1, kills: 8, deaths: 3 });

		// The newer match was played in the game's anonymous mode: its public page has the player
		// under the hidden name, so the public career does not list it beside their own. The panel's
		// career lists it, and both count it.
		await env.db
			.update(matchPlayers)
			.set({ hiddenName: 'Heron' })
			.where(and(eq(matchPlayers.matchId, second.id), eq(matchPlayers.steamId, STEAM)));
		const asked = {
			serverId: w.server.id,
			orgId: w.org.id,
			ids: [w.server.id],
			nameOf: new Map<string, string>(),
			steamId: STEAM
		};
		const panel = await loadCareer(env, asked);
		const shown = await loadCareer(env, { ...asked, publicView: true });
		expect(panel.last.map((m) => m.matchId)).toEqual([second.id, first.id]);
		expect(shown.last.map((m) => m.matchId)).toEqual([first.id]);
		expect(JSON.stringify(shown)).not.toContain('Heron');
		expect({ ...shown, last: [] }).toEqual({ ...panel, last: [] });
		expect(shown).toMatchObject({ matches: 2, kills: 8, deaths: 3 });
	});

	test('kills per hour leaves seed time out of the hours', async () => {
		const w = await seedWorld(env);
		const t0 = Date.now() - 10 * HOUR;
		const [m] = await env.db
			.insert(matches)
			.values({
				serverId: w.server.id,
				startedAt: new Date(t0),
				endedAt: new Date(t0 + HOUR),
				map: 'Europe',
				finalScores: scores,
				winner: 'Lonestar'
			})
			.returning({ id: matches.id });
		const line = (steamId: string, kills: number) => ({
			matchId: m.id,
			serverId: w.server.id,
			steamId,
			name: steamId,
			faction: 'Lonestar',
			seconds: 3600,
			kills,
			deaths: 1
		});
		await env.db.insert(matchPlayers).values([line(STEAM, 20), line(OTHER, 30)]);
		const session = (steamId: string, seedSeconds: number) => ({
			serverId: w.server.id,
			steamId,
			name: steamId,
			faction: 'Lonestar',
			joinedAt: new Date(t0),
			lastSeen: new Date(t0 + 2 * HOUR),
			leftAt: new Date(t0 + 2 * HOUR),
			seedSeconds
		});
		// STEAM: 20 kills in one hour of play (the other hour was seeding); OTHER: 30 kills in two
		await env.db.insert(playerSessions).values([session(STEAM, 3600), session(OTHER, 0)]);
		const board = await loadBoard(
			env,
			[w.server.id],
			parseBoardQuery(new URLSearchParams('minMinutes=0&range=30d&sort=perHour')),
			w.org.id
		);
		expect(board.rows.map((r) => r.steamId)).toEqual([STEAM, OTHER]);
	});
});
