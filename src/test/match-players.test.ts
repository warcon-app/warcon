// The match rows the worker writes: an upsert that sets a player's line of a match, and the
// feed pass that fills the feed columns of the rows that exist.
import { beforeAll, describe, expect, test } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { kills, matches, matchPlayers } from '$lib/server/db/schema';
import { enrichMatchPlayers, writeMatchPlayers } from '$lib/server/match-players';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const A = '76561198000000001';
const B = '76561198000000002';
const C = '76561198000000003';

describe.skipIf(!hasTestDb)('match rows', () => {
	let env: Env;
	let serverId: string;
	let matchId: number;
	const startedAt = new Date(Date.now() - 3600_000);

	beforeAll(async () => {
		env = await testEnv();
		const w = await seedWorld(env);
		serverId = w.server.id;
		const [row] = await env.db
			.insert(matches)
			.values({ serverId, startedAt, map: 'Zestafona', peakPlayers: 2 })
			.returning({ id: matches.id });
		matchId = row.id;
	});

	const rowsOf = () =>
		env.db
			.select()
			.from(matchPlayers)
			.where(eq(matchPlayers.matchId, matchId))
			.orderBy(asc(matchPlayers.steamId));

	test('a write sets the row; a second write of the same player replaces it', async () => {
		await writeMatchPlayers(env.db, serverId, matchId, [
			{
				steamId: A,
				name: 'a',
				faction: 'Red',
				seconds: 60,
				idleSeconds: 40,
				kills: 3,
				deaths: 1,
				cashDelta: 150
			},
			{
				steamId: B,
				name: 'b',
				faction: 'Blue',
				seconds: 30,
				idleSeconds: 30,
				kills: 0,
				deaths: 2,
				cashDelta: -20
			}
		]);
		await writeMatchPlayers(env.db, serverId, matchId, [
			{
				steamId: A,
				name: 'a2',
				faction: 'Red',
				seconds: 600,
				idleSeconds: 120,
				kills: 12,
				deaths: 4,
				cashDelta: 900
			}
		]);
		const rows = await rowsOf();
		expect(
			rows.map((r) => [r.steamId, r.name, r.seconds, r.idleSeconds, r.kills, r.deaths, r.cashDelta])
		).toEqual([
			[A, 'a2', 600, 120, 12, 4, 900],
			[B, 'b', 30, 30, 0, 2, -20]
		]);
		expect(rows[0].serverId).toBe(serverId);
		expect(rows[0].headshots).toBe(0);
	});

	test('the feed pass fills the rows that exist and makes none for a player it alone saw', async () => {
		const at = (secs: number) => new Date(startedAt.getTime() + secs * 1000);
		const kill = (
			eventTime: number,
			killer: string | null,
			victim: string,
			extra: Partial<typeof kills.$inferInsert> = {}
		): typeof kills.$inferInsert => ({
			ts: at(eventTime),
			serverId,
			eventId: `e${eventTime}`,
			instanceId: 'i',
			matchId: 'g1',
			matchRow: matchId,
			eventTime,
			map: 'Zestafona',
			killerSteamId: killer,
			killerName: killer,
			killerFaction: 'Red',
			victimSteamId: victim,
			victimName: victim,
			victimFaction: 'Blue',
			cause: 'Id.Item.AK74M',
			distanceM: 30,
			headshot: false,
			suicide: false,
			teamKill: false,
			tags: [],
			...extra
		});
		await env.db.insert(kills).values([
			kill(10, A, B, { headshot: true, distanceM: 210 }),
			kill(20, A, C),
			kill(30, A, B, { cause: 'Id.Vehicle.WeaponExtension.STN_02.MainCannon' }),
			kill(40, B, A),
			kill(50, A, A, { suicide: true, cause: null }),
			// the next match's kill carries another row and is not this match's
			{ ...kill(60, A, B), matchRow: matchId + 1, eventId: 'other' }
		]);
		const filled = await enrichMatchPlayers(env.db, serverId, matchId, startedAt);
		expect(filled).toBe(2);
		const rows = await rowsOf();
		expect(rows.length).toBe(2);
		const a = rows.find((r) => r.steamId === A)!;
		expect([
			a.headshots,
			a.vehicleKills,
			a.longestM,
			a.killStreak,
			a.deathStreak,
			a.suicides
		]).toEqual([1, 1, 210, 3, 2, 1]);
		const b = rows.find((r) => r.steamId === B)!;
		expect([b.killStreak, b.deathStreak, b.headshots]).toEqual([1, 2, 0]);
	});
});
