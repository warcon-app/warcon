// The players table's marks carry each player's kills and deaths over the matches they finished on
// this server (player_totals), which the Teams view's "Spread by record here" shuffle deals by. The
// player page already shows the same counts per server to anyone who can open it.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Env } from '$lib/server/env';
import { matches, matchPlayers } from '$lib/server/db/schema';
import type { PlayerMark } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';
import { GET as marksRoute } from '../routes/api/servers/[id]/players/marks/+server';

const PLAYED = '76561198000000851';
const NEW = '76561198000000852';
const HOUR = 3_600_000;

describe.skipIf(!hasTestDb)('records on the players table', () => {
	let env: Env;
	let w: World;

	const finished = async (serverId: string, kills: number, deaths: number) => {
		const [m] = await env.db
			.insert(matches)
			.values({
				serverId,
				startedAt: new Date(Date.now() - 2 * HOUR),
				endedAt: new Date(Date.now() - HOUR),
				map: 'Europe',
				finalScores: [
					{ name: 'Valkyra', score: 3 },
					{ name: 'Lonestar', score: 1 }
				],
				winner: 'Valkyra'
			})
			.returning({ id: matches.id });
		await env.db.insert(matchPlayers).values({
			matchId: m.id,
			serverId,
			steamId: PLAYED,
			name: 'Player',
			faction: 'Valkyra',
			seconds: 3000,
			kills,
			deaths
		});
	};
	const marks = (who: World['users'][keyof World['users']]) =>
		callApi(marksRoute, who, {
			params: { id: w.server.id },
			query: new URLSearchParams({ ids: `${PLAYED},${NEW}`, names: 'Player\nJoiner' }).toString()
		});

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		await finished(w.server.id, 20, 8);
		await finished(w.server.id, 10, 2);
		// the same player's matches on the org's other server are not this server's record
		await finished(w.otherServer.id, 99, 1);
	});

	test("a viewer reads each player's record on this server, and null before their first match", async () => {
		const answer = await marks(w.users.viewer);
		expect(answer.status).toBe(200);
		const got = (answer.body as { marks: PlayerMark[] }).marks;
		expect(got.find((m) => m.steamId === PLAYED)?.record).toEqual({ kills: 30, deaths: 10 });
		expect(got.find((m) => m.steamId === NEW)?.record).toBeNull();
	});

	test('another org, a key held to the other server and nobody signed in get nothing', async () => {
		expect((await marks(w.users.outsider)).status).toBe(404);
		expect((await marks(w.users.keyElsewhere)).status).toBe(404);
		expect((await marks(null)).status).toBe(401);
	});
});
