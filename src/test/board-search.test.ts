// Searching a leaderboard narrows its rows and leaves their ranks alone, and a public board can be
// searched only by the names it shows; these check the reads against a database.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Env } from '$lib/server/env';
import { matches, matchPlayers, playerSessions } from '$lib/server/db/schema';
import { loadBoard } from '$lib/server/leaderboards';
import { parseBoardQuery } from '$lib/leaderboard';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const VIPER = '76561198000000171';
const ARTEC = '76561198000000172';
const PERCENT = '76561198000000173';
const HOUR = 3_600_000;

describe.skipIf(!hasTestDb)('searching a leaderboard', () => {
	let env: Env;

	beforeAll(async () => {
		env = await testEnv();
	});

	/** One ended match: VIPER 30 kills, ARTEC 20, PERCENT 10, so by kills they rank 1, 2, 3.
	 *  VIPER played an earlier session as "OldTag". */
	async function seed() {
		const w = await seedWorld(env);
		const t0 = Date.now() - 10 * HOUR;
		const [m] = await env.db
			.insert(matches)
			.values({
				serverId: w.server.id,
				startedAt: new Date(t0),
				endedAt: new Date(t0 + HOUR),
				map: 'Europe',
				finalScores: [{ name: 'Lonestar', score: 100 }],
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
		await env.db.insert(matchPlayers).values([line(VIPER, 30), line(ARTEC, 20), line(PERCENT, 10)]);
		const session = (steamId: string, name: string, start: number) => ({
			serverId: w.server.id,
			steamId,
			name,
			faction: 'Lonestar',
			joinedAt: new Date(start),
			lastSeen: new Date(start + HOUR),
			leftAt: new Date(start + HOUR)
		});
		await env.db
			.insert(playerSessions)
			.values([
				session(VIPER, 'OldTag', t0),
				session(VIPER, 'Viper', t0 + 2 * HOUR),
				session(ARTEC, 'ARTEC', t0),
				session(PERCENT, '100%Real', t0)
			]);
		return w;
	}

	const board = (serverId: string, search: string, audience = {}) =>
		loadBoard(
			env,
			[serverId],
			parseBoardQuery(new URLSearchParams({ minMinutes: '0', q: search })),
			audience
		);

	test('no search ranks everyone from the top', async () => {
		const w = await seed();
		const b = await board(w.server.id, '');
		expect(b.rows.map((r) => [r.rank, r.steamId])).toEqual([
			[1, VIPER],
			[2, ARTEC],
			[3, PERCENT]
		]);
		expect(b.total).toBe(3);
	});

	test('a match keeps its place on the whole board, and the total counts the matches', async () => {
		const w = await seed();
		const b = await board(w.server.id, 'artec');
		expect(b.rows.map((r) => [r.rank, r.steamId, r.name])).toEqual([[2, ARTEC, 'ARTEC']]);
		expect(b.total).toBe(1);
	});

	test('the panel finds an old name and a SteamID, or its start', async () => {
		const w = await seed();
		expect((await board(w.server.id, 'oldtag')).rows.map((r) => r.steamId)).toEqual([VIPER]);
		expect((await board(w.server.id, VIPER)).rows.map((r) => r.steamId)).toEqual([VIPER]);
		expect((await board(w.server.id, '7656119800000017')).rows.map((r) => r.steamId)).toEqual([
			VIPER,
			ARTEC,
			PERCENT
		]);
	});

	test('a public board matches only the name it shows', async () => {
		const w = await seed();
		const pub = { public: true };
		expect((await board(w.server.id, 'viper', pub)).rows.map((r) => r.steamId)).toEqual([VIPER]);
		// the old name and the SteamID are not on the public board, so they find nobody there
		expect((await board(w.server.id, 'oldtag', pub)).rows).toEqual([]);
		expect((await board(w.server.id, VIPER, pub)).rows).toEqual([]);
	});

	test('a percent sign or an underscore is a letter, not a wildcard', async () => {
		const w = await seed();
		expect((await board(w.server.id, '%')).rows.map((r) => r.steamId)).toEqual([PERCENT]);
		expect((await board(w.server.id, '_')).rows).toEqual([]);
	});
});
