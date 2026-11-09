// Migration 0047 gives 0032's rows the feed's kills and deaths where the feed saw the whole match,
// keeps every session's counters in the player's totals (a sum where it was one, a single match's
// where it was that), and gives a row the feed's side where its own was not on the scoreboard; the
// totals are rebuilt from the rows. Each install here is a database of its own, migrated to just
// before 0047: a history seeded around the time 66fa7a6 was written (C), 0032 run over it, the
// worker's rows written, then 0047 applied by the migrator as at a deploy. Their own, because the
// bound and the switch are each install's, which the other suites' history would move.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { connect, runMigrations, type Db } from '$lib/server/db';
import { kills, matches, matchPlayers, playerSessions } from '$lib/server/db/schema';
import { hasTestDb } from './db';
import { oracleBase, oracleRangeBase, rangeRows, totalsRows } from './totals-oracle';

const FEED = '0047_match_players_from_feed';
const HOUR = 3_600_000;
const MIN = 60_000;
const C = Date.parse('2026-09-20T22:41:46Z');
const h = (hours: number) => new Date(C + hours * HOUR);
const SCORES = [
	{ name: 'Lonestar', score: 100 },
	{ name: 'Wagner', score: 40 }
];
const id = (n: number) => `765611980000001${String(n).padStart(2, '0')}`;
// the feed's own players, who have no row
const E = id(1);
const G = id(2);
const V = id(3);
const LW: [string, string] = ['Lonestar', 'Wagner'];
const WL: [string, string] = ['Wagner', 'Lonestar'];

async function run(db: Db, file: string) {
	const text = await Bun.file(`drizzle/${file}.sql`).text();
	await db.transaction(async (tx) => {
		for (const stmt of text.split('--> statement-breakpoint')) await tx.execute(sql.raw(stmt));
	});
}

/** A database migrated to just before 0047 (cut, as player-totals-writes explains), and its drop. */
async function install() {
	const base = process.env.TEST_DATABASE_URL!;
	const name = `warcon_test_feed_${randomBytes(4).toString('hex')}`;
	const admin = new SQL(base, { max: 1 });
	await admin.unsafe(`CREATE DATABASE "${name}"`);
	await admin.close();
	const url = new URL(base);
	url.pathname = `/${name}`;
	const { client, db } = connect(url.href);
	const dir = await mkdtemp(join(tmpdir(), 'warcon-migrate-'));
	await cp('drizzle', dir, { recursive: true });
	const journal = JSON.parse(await readFile(join(dir, 'meta', '_journal.json'), 'utf8'));
	const cut = journal.entries.findIndex((e: { tag: string }) => e.tag === FEED);
	expect(cut).toBeGreaterThan(0);
	journal.entries = journal.entries.slice(0, cut);
	await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
	await runMigrations(db, dir);
	const drop = async () => {
		await client.close();
		const a = new SQL(base, { max: 1 });
		await a.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
		await a.close();
		await rm(dir, { recursive: true, force: true });
	};
	return { db, drop };
}

/** One-hour matches from these hours after C, those in `unscored` without scores. */
async function addMatches(db: Db, serverId: string, starts: number[], unscored: number[] = []) {
	const rows = await db
		.insert(matches)
		.values(
			starts.map((s) => ({
				serverId,
				startedAt: h(s),
				endedAt: h(s + 1),
				map: 'Europe',
				finalScores: unscored.includes(s) ? null : SCORES,
				winner: unscored.includes(s) ? null : 'Lonestar'
			}))
		)
		.returning({ id: matches.id, startedAt: matches.startedAt });
	return rows.map((r) => ({ id: r.id, start: r.startedAt.getTime() }));
}

type Match = { id: number; start: number };

function feed(serverId: string) {
	let n = 0;
	/** A kill `min` minutes into the match (or at an hour after C with no match). */
	return (
		m: Match | number,
		min: number,
		killer: string | null,
		victim: string,
		sides: [string | null, string | null] = LW,
		extra: Partial<typeof kills.$inferInsert> = {}
	): typeof kills.$inferInsert => {
		const start = typeof m === 'number' ? h(m).getTime() : m.start;
		return {
			ts: new Date(start + min * MIN),
			serverId,
			eventId: `${serverId}:${++n}`,
			instanceId: 'i',
			matchId: 'g',
			matchRow: typeof m === 'number' ? null : m.id,
			eventTime: min * 60,
			map: 'Europe',
			killerSteamId: killer,
			killerName: killer,
			killerFaction: sides[0],
			victimSteamId: victim,
			victimName: victim,
			victimFaction: sides[1],
			cause: 'Id.Item.AK74M',
			distanceM: 30,
			headshot: false,
			suicide: false,
			teamKill: false,
			tags: [],
			...extra
		};
	};
}

/** A closed session from one hour after C to another, with its counters. */
const session = (
	serverId: string,
	steamId: string,
	from: number,
	to: number,
	faction: string,
	k: number,
	d: number
) => ({
	serverId,
	steamId,
	name: `Player ${steamId.slice(-2)}`,
	faction,
	joinedAt: h(from),
	lastSeen: h(to),
	leftAt: h(to),
	kills: k,
	deaths: d,
	cash: 1000
});

/** The worker's row of a match. */
const worker = (matchId: number, serverId: string, k: number, d: number, cashDelta: number) => ({
	matchId,
	serverId,
	steamId: V,
	name: 'Player 03',
	faction: 'Lonestar',
	seconds: 3000,
	kills: k,
	deaths: d,
	cashDelta
});

const rowsOf = (db: Db, matchId: number) =>
	db
		.select()
		.from(matchPlayers)
		.where(eq(matchPlayers.matchId, matchId))
		.orderBy(asc(matchPlayers.steamId));
const lineOf = async (db: Db, matchId: number, steamId: string) =>
	(await rowsOf(db, matchId))
		.filter((r) => r.steamId === steamId)
		.map((r) => [r.faction, r.kills, r.deaths])[0];

async function exact(db: Db, ids: string[]) {
	await db.transaction(async (tx) => {
		expect(await totalsRows(tx, ids)).toEqual(await oracleBase(tx, ids));
		for (const from of [h(-24), h(2.5)])
			expect(await rangeRows(tx, ids, from)).toEqual(await oracleRangeBase(tx, ids, from));
	});
	const [trigger] = (await db.execute(sql`
		SELECT tgenabled FROM pg_trigger WHERE tgname = 'player_totals_lines_updated'`)) as {
		tgenabled: string;
	}[];
	expect(trigger.tgenabled).toBe('O');
}

describe.skipIf(!hasTestDb)('the match rows from the feed', () => {
	const A = 'feed-a';
	const B = 'feed-b';
	// single before the switch: NS1 ends covered with the feed below its counters, NS2 ends
	// uncovered; DS1, DS2 look single and DU1, DU2, P look summing, which puts the switch between
	// C+1h and C+3h; HW drops inside that, HX on both sides of it, J1 inside it with J2 rejoining
	// after it; summing after it: P over three covered matches, Z with a remainder on its own last,
	// L losing its sum to a covered last match, DC doubling it on an uncovered one; RJ a rejoin of a
	// single and a summing session; XL a sum ending in a match that is not 0032's. NS1, NS3, L and
	// L2 have kills in a match the feed did not see whole, which would move them if it counted.
	const [
		NS1,
		NS2,
		DS1,
		DS2,
		DU1,
		DU2,
		HW,
		HX,
		J,
		P,
		Z,
		W,
		T,
		L,
		DC,
		U,
		Q,
		Y,
		N,
		R,
		RJ,
		XL,
		NS3,
		L2
	] = Array.from({ length: 24 }, (_, i) => id(10 + i));
	// WK: the worker's row, with no cash moved, in a covered match of 0032's, for a session it
	// closed after the bound
	const WK = id(35);
	let db: Db;
	let drop: () => Promise<void>;
	let m: Match[] = [];
	let o: Match[] = [];

	beforeAll(async () => {
		({ db, drop } = await install());
		// M0 the feed's first; M2 the feed stopping early; M10 no scores; M12 a game restart;
		// M14 the worker's first with cash moved (its end is the bound); M15 the worker's, quiet
		m = await addMatches(db, A, [-4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], [6]);
		// another server: o0 0032's, o1 the worker's while nobody's cash moved, o2 with cash moved
		o = await addMatches(db, B, [-1, 11, 12]);
		const k = feed(A);
		const kb = feed(B);
		const frames = [0, 1, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].flatMap((i) => [
			k(m[i], 1, E, G),
			k(m[i], 59, E, G)
		]);
		await db.insert(kills).values([
			...frames,
			k(m[2], 1, E, G),
			k(m[2], 40, E, G),
			k(m[12], 30, E, G),
			k(m[12], 31, E, G, LW, { eventTime: 30 }),
			// M0: NS1 3; M1: NS1 2 and 1, NS2 3 and 2; M2: NS3 1; M3: NS3 1
			...[32, 36, 40].map((t) => k(m[0], t, NS1, E)),
			k(m[2], 10, NS3, E),
			k(m[3], 40, NS3, E),
			k(m[1], 5, NS1, E),
			k(m[1], 10, NS1, E),
			k(m[1], 15, E, NS1, WL),
			...[20, 25, 30].map((t) => k(m[1], t, NS2, E)),
			...[35, 40].map((t) => k(m[1], t, E, NS2, WL)),
			// M3, M4, M5: DS1 and DS2 6 in their first match, 2 and 1 in their last
			...[5, 10, 15, 20, 25, 30].map((t) => k(m[3], t, DS1, E)),
			k(m[4], 5, DS1, E),
			k(m[4], 10, DS1, E),
			k(m[4], 15, E, DS1, WL),
			...[20, 25, 30, 35, 40, 45].map((t) => k(m[4], t, DS2, E)),
			k(m[5], 5, DS2, E),
			k(m[5], 10, DS2, E),
			k(m[5], 15, E, DS2, WL),
			// HX 1 in each of M4-M7; HW 2 in M5, 1 and 1 in M6; J 1 in each of M5-M7
			...[4, 5, 6, 7].map((i) => k(m[i], 50, HX, E)),
			k(m[5], 20, HW, E),
			k(m[5], 25, HW, E),
			k(m[6], 35, HW, E),
			k(m[6], 40, E, HW, WL),
			k(m[5], 35, J, E),
			k(m[6], 52, J, E),
			k(m[7], 40, J, E),
			// M6, M7: DU1 and DU2 6 in their first match, 2 and 1 in their last
			...[5, 10, 15, 20, 25, 30].flatMap((t) => [k(m[6], t, DU1, E), k(m[6], t + 1, DU2, E)]),
			...[DU1, DU2].flatMap((p, i) => [
				k(m[7], 5 + i, p, E),
				k(m[7], 10 + i, p, E),
				k(m[7], 15 + i, E, p, WL)
			]),
			// M7: P 3 and 2 (a team kill and a suicide are not kills); one batch 3 s behind
			k(m[7], 25, P, E),
			k(m[7], 27, P, E, LW, { headshot: true }),
			k(m[7], 29, E, P, WL, { eventTime: 27 * 60 - 3 }),
			k(m[7], 31, P, E, ['Lonestar', 'Lonestar'], { teamKill: true }),
			k(m[7], 33, P, P, ['Lonestar', 'Lonestar'], { suicide: true, cause: null }),
			k(m[7], 35, P, E),
			// M8: P 3 and 2 (one death to the environment); W 2 and 1 on Wagner; Z 2 and 0 on
			// Lonestar, which does not move a row already on a team
			k(m[8], 5, P, E),
			k(m[8], 10, E, P, WL),
			k(m[8], 12, W, E, WL),
			k(m[8], 14, W, E, WL),
			k(m[8], 16, P, W),
			k(m[8], 20, Z, E),
			k(m[8], 22, Z, E),
			k(m[8], 24, null, P, [null, 'Lonestar'], { cause: null }),
			k(m[8], 26, P, E),
			k(m[8], 19, RJ, E),
			k(m[8], 27, RJ, E),
			k(m[8], 40, RJ, E),
			k(m[9], 30, RJ, E),
			// M9: P 2 and 1; T 1 and 1, once on each side
			k(m[9], 5, P, E),
			k(m[9], 10, T, E),
			k(m[9], 15, E, T),
			k(m[9], 20, P, E),
			k(m[9], 25, E, P, WL),
			// M10 (no scores): L 1 and 1 of its 4 and 1; M11: L 2 and 1, DC 3 and 0; M12: DC 2 and
			// 2, L2 1 of its 3; M13: L2 2
			k(m[10], 5, L, E),
			k(m[10], 25, E, L, WL),
			k(m[12], 10, L2, E),
			k(m[13], 10, L2, E),
			k(m[13], 20, L2, E),
			k(m[11], 5, L, E),
			k(m[11], 10, L, E),
			k(m[11], 15, E, L, WL),
			...[20, 25, 30].map((t) => k(m[11], t, DC, E)),
			k(m[12], 35, DC, E),
			k(m[12], 40, DC, E),
			k(m[12], 45, E, DC, WL),
			k(m[12], 50, E, DC, WL),
			k(m[11], 35, XL, E),
			k(m[11], 40, XL, E),
			k(m[12], 55, XL, E),
			k(m[14], 20, XL, E),
			// the other server: fed before o0, and throughout every match
			kb(-2, 0, R, E),
			kb(o[0], 1, R, E),
			kb(o[0], 59, R, E),
			...[1, 2].flatMap((i) => [kb(o[i], 1, V, E), kb(o[i], 59, V, E)])
		]);
		await db
			.insert(playerSessions)
			.values([
				session(A, NS1, -3.5, -2.1, 'Lonestar', 4, 1),
				session(A, NS2, -2.5, -1.2, 'Lonestar', 5, 1),
				session(A, DS1, -0.5, 0.9, 'Lonestar', 2, 1),
				session(A, DS2, 0.5, 1.9, 'Lonestar', 2, 1),
				session(A, HX, 0.2, 3.5, 'Lonestar', 3, 0),
				session(A, HW, 1.5, 2.9, 'White', 3, 1),
				session(A, J, 1.6, 2.6, 'Lonestar', 2, 0),
				session(A, J, 2.7, 3.8, 'Lonestar', 2, 0),
				session(A, DU1, 2.5, 3.9, 'Lonestar', 8, 1),
				session(A, DU2, 2.5, 3.9, 'Lonestar', 8, 1),
				session(A, P, 3.5, 5.9, 'Lonestar', 8, 5),
				session(A, Z, 4.2, 5.8, 'Wagner', 3, 0),
				session(A, W, 4.1, 4.9, 'White', 2, 1),
				session(A, T, 5.1, 5.7, 'White', 1, 1),
				session(A, N, 6.1, 6.4, 'Lonestar', 2, 2),
				session(A, L, 6.5, 7.9, 'Lonestar', 6, 2),
				session(A, DC, 7.5, 8.9, 'Lonestar', 5, 2),
				session(A, U, 8.2, 8.8, 'Lonestar', 5, 2),
				session(A, RJ, 4.3, 4.5, 'Lonestar', 2, 0),
				session(A, RJ, 4.6, 5.5, 'Lonestar', 2, 0),
				session(A, XL, 7.2, 10.5, 'Lonestar', 4, 1),
				session(A, NS3, -1.5, -0.5, 'Lonestar', 1, 0),
				session(A, L2, 8.5, 9.8, 'Lonestar', 5, 0),
				session(A, Q, -3.9, -3.1, 'Lonestar', 4, 2),
				session(A, Y, -1.9, -1.1, 'Lonestar', 5, 1),
				session(B, R, -0.9, -0.1, 'White', 3, 1)
			]);
		await run(db, '0032_match_players_backfill');
		await db
			.insert(matchPlayers)
			.values([
				worker(m[14].id, A, 9, 9, 700),
				worker(m[15].id, A, 1, 0, 0),
				{ ...worker(m[13].id, A, 6, 2, 0), steamId: WK },
				worker(o[1].id, B, 1, 0, 0),
				worker(o[2].id, B, 4, 4, 300)
			]);
		await db.insert(playerSessions).values(session(A, WK, 9.5, 11.5, 'Lonestar', 6, 2));
		await runMigrations(db, 'drizzle');
	}, 60_000);

	afterAll(() => drop?.());

	const line = (i: number, steamId: string) => lineOf(db, m[i].id, steamId);

	test('a summing session over covered matches: each its feed, any remainder on its last', async () => {
		expect([await line(7, P), await line(8, P), await line(9, P)]).toEqual([
			['Lonestar', 3, 2],
			['Lonestar', 3, 2],
			['Lonestar', 2, 1]
		]);
		// Z's counters are one kill above the feed: it goes on Z's own last match
		expect([await line(8, Z), await line(9, Z)]).toEqual([
			['Wagner', 2, 0],
			['Wagner', 1, 0]
		]);
		// the feed's other columns, which 0032 filled, stay
		const p = (await rowsOf(db, m[7].id)).find((r) => r.steamId === P)!;
		expect([p.headshots, p.teamKills, p.suicides]).toEqual([1, 1, 1]);
	});

	test('a sum on a covered last match: what the feed did not see goes to its uncovered match', async () => {
		expect([await line(10, L), await line(11, L)]).toEqual([
			['Lonestar', 4, 1],
			['Lonestar', 2, 1]
		]);
		expect([await line(12, L2), await line(13, L2)]).toEqual([
			['Lonestar', 3, 0],
			['Lonestar', 2, 0]
		]);
	});

	test('a sum on an uncovered last match: it keeps what its covered matches do not hold', async () => {
		expect([await line(11, DC), await line(12, DC)]).toEqual([
			['Lonestar', 3, 0],
			['Lonestar', 2, 2]
		]);
	});

	test('a single match counted: the larger of feed and counters there, the feed before it', async () => {
		// NS1's counters are its covered last match's, two kills above the feed; its first match,
		// the feed's first, is not counted from the feed
		expect([await line(0, NS1), await line(1, NS1)]).toEqual([
			['Lonestar', 0, 0],
			['Lonestar', 4, 1]
		]);
		// nor is the match where the feed stopped early
		expect([await line(2, NS3), await line(3, NS3)]).toEqual([
			['Lonestar', 0, 0],
			['Lonestar', 1, 0]
		]);
		// NS2 ends uncovered: that match keeps its counters, the covered one before gets the feed
		expect([await line(1, NS2), await line(2, NS2)]).toEqual([
			['Lonestar', 3, 2],
			['Lonestar', 5, 1]
		]);
		// the sessions that told the switch
		expect([
			await line(3, DS1),
			await line(4, DS1),
			await line(6, DU1),
			await line(7, DU1)
		]).toEqual([
			['Lonestar', 6, 0],
			['Lonestar', 2, 1],
			['Lonestar', 6, 0],
			['Lonestar', 2, 1]
		]);
	});

	test('sessions the switch leaves unclear, and their rejoins, stay as 0032 wrote them', async () => {
		expect([await line(5, HW), await line(6, HW)]).toEqual([
			['White', 0, 0],
			['White', 3, 1]
		]);
		expect(await Promise.all([4, 5, 6, 7].map((i) => line(i, HX)))).toEqual([
			['Lonestar', 0, 0],
			['Lonestar', 0, 0],
			['Lonestar', 0, 0],
			['Lonestar', 3, 0]
		]);
		expect(await Promise.all([5, 6, 7].map((i) => line(i, J)))).toEqual([
			['Lonestar', 0, 0],
			['Lonestar', 2, 0],
			['Lonestar', 2, 0]
		]);
		// a rejoin where one of the two sums: their parts of the shared match cannot be told apart
		expect([await line(8, RJ), await line(9, RJ)]).toEqual([
			['Lonestar', 2, 0],
			['Lonestar', 2, 0]
		]);
		// a sum whose last match is not 0032's (the worker's may have written it since)
		expect(await Promise.all([11, 12, 13, 14].map((i) => line(i, XL)))).toEqual([
			['Lonestar', 0, 0],
			['Lonestar', 0, 0],
			['Lonestar', 0, 0],
			['Lonestar', 4, 1]
		]);
	});

	test('the holding side takes the one team the feed shows; two teams leave it', async () => {
		expect(await line(8, W)).toEqual(['Wagner', 2, 1]);
		expect(await line(9, T)).toEqual(['White', 1, 1]);
	});

	test('a player the feed saw without a row gets none', async () => {
		const ids = await db
			.select({ id: matchPlayers.steamId })
			.from(matchPlayers)
			.where(and(inArray(matchPlayers.steamId, [E, G]), inArray(matchPlayers.serverId, [A, B])));
		expect(ids).toEqual([]);
	});

	test("matches the feed did not see whole, and the worker's, keep their numbers", async () => {
		expect(await line(0, Q)).toEqual(['Lonestar', 4, 2]);
		expect(await line(2, Y)).toEqual(['Lonestar', 5, 1]);
		expect(await line(10, N)).toEqual(['Lonestar', 2, 2]);
		expect(await line(12, U)).toEqual(['Lonestar', 5, 2]);
		expect(await line(13, WK)).toEqual(['Lonestar', 6, 2]);
		expect(await line(14, V)).toEqual(['Lonestar', 9, 9]);
		expect(await line(15, V)).toEqual(['Lonestar', 1, 0]);
	});

	test("the worker's first end with cash moved bounds 0032's matches on every server", async () => {
		// before it, though this server's own first match with cash moved came later
		expect(await lineOf(db, o[0].id, R)).toEqual(['Lonestar', 3, 1]);
		// after it, though nobody's cash had moved on this server yet
		expect(await lineOf(db, o[1].id, V)).toEqual(['Lonestar', 1, 0]);
		expect(await lineOf(db, o[2].id, V)).toEqual(['Lonestar', 4, 4]);
	});

	test('the totals and the day rows agree with the rows, and the trigger is back on', async () => {
		await exact(db, [A, B]);
		const [p] = (await totalsRows(db, [A], [P])) as { kills: string; deaths: string }[];
		expect([p.kills, p.deaths]).toEqual(['8', '5']);
	});

	test('running it again changes nothing', async () => {
		const ids = [...m, ...o].map((x) => x.id);
		const before = await Promise.all(ids.map((i) => rowsOf(db, i)));
		await run(db, FEED);
		expect(await Promise.all(ids.map((i) => rowsOf(db, i)))).toEqual(before);
	});

	test('with nothing to write it rebuilds nothing', async () => {
		// a total put off by hand stays off: the rebuild would have put it back
		const off = sql`server_id = ${A} AND steam_id = ${P}`;
		await db.execute(sql`UPDATE player_totals SET kills = kills + 1000 WHERE ${off}`);
		await run(db, FEED);
		const [t] = (await db.execute(sql`SELECT kills::text FROM player_totals WHERE ${off}`)) as {
			kills: string;
		}[];
		expect(t.kills).toBe('1008');
		await db.execute(sql`UPDATE player_totals SET kills = kills - 1000 WHERE ${off}`);
	});
});

describe.skipIf(!hasTestDb)(
	'the match rows from the feed, with no session telling the switch',
	() => {
		const S = 'feed-c';
		const [B0, B1, B2] = [id(40), id(41), id(42)];
		let db: Db;
		let drop: () => Promise<void>;
		let k: Match[] = [];

		beforeAll(async () => {
			({ db, drop } = await install());
			// k1 has no scores; k3 the worker's first with cash moved
			k = await addMatches(db, S, [-2, 1, 2, 3], [1]);
			const f = feed(S);
			await db
				.insert(kills)
				.values([
					f(-3, 0, E, G),
					...[0, 1, 2, 3].flatMap((i) => [f(k[i], 1, E, G), f(k[i], 59, E, G)]),
					f(k[0], 5, B0, E),
					f(k[0], 10, B0, E),
					f(k[0], 15, E, B0, WL),
					...[5, 10, 15].map((t) => f(k[1], t, B1, E)),
					f(k[1], 20, E, B1, WL),
					f(k[2], 5, B1, E),
					f(k[2], 10, B1, E),
					f(k[2], 20, B2, E),
					f(k[2], 25, B2, E),
					f(k[2], 30, E, B2, WL)
				]);
			await db
				.insert(playerSessions)
				.values([
					session(S, B0, -1.9, -1.2, 'Lonestar', 1, 0),
					session(S, B1, 1.5, 2.9, 'Lonestar', 5, 1),
					session(S, B2, 2.2, 2.8, 'Lonestar', 1, 0)
				]);
			await run(db, '0032_match_players_backfill');
			await db.insert(matchPlayers).values(worker(k[3].id, S, 3, 3, 200));
			await runMigrations(db, 'drizzle');
		}, 60_000);

		afterAll(() => drop?.());

		test('a session with a drop after 66fa7a6 was written is held; single matches get the feed', async () => {
			expect([await lineOf(db, k[1].id, B1), await lineOf(db, k[2].id, B1)]).toEqual([
				['Lonestar', 0, 0],
				['Lonestar', 5, 1]
			]);
			expect(await lineOf(db, k[0].id, B0)).toEqual(['Lonestar', 2, 1]);
			expect(await lineOf(db, k[2].id, B2)).toEqual(['Lonestar', 2, 1]);
			await exact(db, [S]);
		});
	}
);
