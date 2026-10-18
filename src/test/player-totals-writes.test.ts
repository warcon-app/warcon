// The totals' triggers (migrations 0038 and 0039) under the writes the random histories do not
// reach, each checked against the all-time reads and the ranged ones (the day rows, from every
// midnight of the history and a millisecond either side): one statement that closes a session and
// edits a closed one of the same player, or ends a match and edits an ended one; a transaction that
// ends a match and then changes its lines and its winner; an upsert of an ended match's lines; a
// statement that fails after a close; a purge; a session over two midnights closed, moved and
// deleted, and one closed exactly at a midnight; a match end moved to another day; the closed-
// session rule; a negative streak; writes and reads in other time zones, microseconds either side
// of a midnight. Then two transactions on one server, the worker's (a close, a match end, an
// abandoned match, leavers' lines, the offline transition) and a purge, each holding the server's
// totals lock while the other waits for it, in both orders: no deadlock, and the totals exact
// after. Taking the lock first is what makes that so: without it, an abandoned match against a
// purge deadlocks; and taken before the lease row, a purge holding it does not hold up the lease
// renewal. A transaction that is not READ COMMITTED is refused. Last, migrations 0038 and 0039 run
// over a database that already has history build the totals and day rows the reads expect.
import { beforeAll, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { SQL } from 'bun';
import { randomBytes } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, sql, type SQL as Query } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { connect, runMigrations, type DbOrTx } from '$lib/server/db';
import { matches, matchPlayers, playerSessions } from '$lib/server/db/schema';
import {
	acquireOrRenew,
	isOwner,
	ownershipPeriod,
	StaleOwnership,
	withOwnedTransaction
} from '$lib/server/leadership';
import { writeMatchPlayers } from '$lib/server/match-players';
import { purgeServerStats } from '$lib/server/stats';
import { lockTotals } from '$lib/server/totals';
import { hasTestDb, insertEarlyLines, testEnv } from './db';
import { seedWorld, type World } from './world';
import { oracleBase, oracleRangeBase, rangeRows, totalsRows } from './totals-oracle';

// Every test holds the rows against the reads from fifty-odd range starts: more than bun's 5 s on a
// loaded machine.
setDefaultTimeout(30_000);

const P = '76561198000032001';
const Q = '76561198000032002';
const R = '76561198000032003';
const S = '76561198000032004';
const HOUR = 3_600_000;
const DAY = 86_400_000;
const scores = [
	{ name: 'Valkyra', score: 100 },
	{ name: 'Lonestar', score: 60 }
];

function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => (open = resolve));
	return { open, opened };
}

describe.skipIf(!hasTestDb)('player totals under every kind of write', () => {
	let env: Env;

	// Hour 0 is 22:00 UTC two days back: hour 2 and hour 26 are midnights.
	const t0 = Math.floor(Date.now() / DAY) * DAY - 2 * DAY - 2 * HOUR;
	const at = (h: number) => new Date(t0 + h * HOUR);
	/** Range starts around everything these tests write: the midnights and a millisecond either side. */
	const SINCE = [-30, -1, 0, 0.5, 1, 1.5, 2, 2.5, 3, 4, 25, 26, 27, 30, 49, 50, 51, 80].flatMap(
		(h) => {
			const t = t0 + h * HOUR;
			return [t - 1, t, t + 1].map((v) => new Date(v));
		}
	);
	/** The totals and the day rows of these servers equal what today's reads compute, in one snapshot. */
	const exact = async (ids: string[]) => {
		await env.db.transaction(async (tx) => {
			expect(await totalsRows(tx, ids)).toEqual(await oracleBase(tx, ids));
			for (const from of SINCE)
				expect({ since: from.toISOString(), rows: await rangeRows(tx, ids, from) }).toEqual({
					since: from.toISOString(),
					rows: await oracleRangeBase(tx, ids, from)
				});
		});
	};
	const session = async (
		serverId: string,
		steamId: string,
		from: number,
		to: number | null,
		cash = 100
	) =>
		(
			await env.db
				.insert(playerSessions)
				.values({
					serverId,
					steamId,
					name: `n${steamId.slice(-2)}`,
					faction: 'Valkyra',
					joinedAt: at(from),
					lastSeen: at(to ?? from + 0.5),
					leftAt: to === null ? null : at(to),
					kills: 3,
					deaths: 2,
					cash,
					seedSeconds: 60
				})
				.returning({ id: playerSessions.id })
		)[0].id;
	const match = async (
		serverId: string,
		from: number,
		ended: boolean,
		winner: string | null = 'Valkyra'
	) =>
		(
			await env.db
				.insert(matches)
				.values({
					serverId,
					startedAt: at(from),
					endedAt: ended ? at(from + 1) : null,
					map: 'Kavkazi',
					finalScores: ended ? scores : null,
					winner: ended ? winner : null
				})
				.returning({ id: matches.id })
		)[0].id;
	const line = (
		matchId: number,
		serverId: string,
		steamId: string,
		faction: string | null,
		kills = 4
	) =>
		env.db.insert(matchPlayers).values({
			matchId,
			serverId,
			steamId,
			name: 'l',
			faction,
			seconds: 600,
			kills,
			deaths: 2,
			headshots: 1,
			killStreak: kills
		});
	/** Someone waits for a server's totals lock (another transaction holds it). */
	const untilWaiting = async () => {
		const end = Date.now() + 10_000;
		for (;;) {
			const [row] = (await env.db.execute(sql`
				SELECT COUNT(*)::int AS n FROM pg_locks
				 WHERE locktype = 'advisory' AND NOT granted
				   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)) as {
				n: number;
			}[];
			if (row.n > 0) return;
			if (Date.now() > end) throw new Error('nobody waited for the lock');
			await Bun.sleep(20);
		}
	};

	beforeAll(async () => {
		env = await testEnv();
	});

	test('a statement that closes a session and edits a closed one of the same player counts each once', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		for (const openFirst of [false, true]) {
			const steamId = openFirst ? Q : P;
			const a = openFirst ? await session(A, steamId, 3, null) : await session(A, steamId, 1, 2);
			const b = openFirst ? await session(A, steamId, 1, 2) : await session(A, steamId, 3, null);
			const [open, closed] = openFirst ? [a, b] : [b, a];
			// left_at in the SET list: the open row's close adds (BEFORE), the closed row's edit
			// recounts the pair from the statement's end state (AFTER)
			await env.db.execute(sql`
				UPDATE player_sessions SET left_at = CASE WHEN id = ${open} THEN last_seen ELSE left_at END,
				       cash = cash + 7
				 WHERE id IN (${open}, ${closed})`);
			await exact([A]);
		}
		// two closes of one pair in one statement add twice, once each
		const c = await session(A, R, 4, null);
		const d = await session(A, R, 5, null);
		await env.db.execute(
			sql`UPDATE player_sessions SET left_at = last_seen WHERE id IN (${c}, ${d})`
		);
		await exact([A]);
		const [row] = (await env.db.execute(sql`
			SELECT sessions FROM player_totals WHERE server_id = ${A} AND steam_id = ${R}`)) as {
			sessions: number;
		}[];
		expect(row.sessions).toBe(2);
	});

	test('a statement that fails after a close adds nothing', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		const a = await session(A, P, 1, null);
		const b = await session(A, P, 2, null);
		await expect(
			(async () =>
				env.db.execute(sql`
					UPDATE player_sessions SET left_at = last_seen,
					       kills = CASE WHEN id = ${b} THEN kills / 0 ELSE kills END
					 WHERE id IN (${a}, ${b})`))()
		).rejects.toThrow();
		await exact([A]);
		expect(
			await env.db.execute(sql`SELECT 1 FROM player_totals WHERE server_id = ${A}`)
		).toHaveLength(0);
	});

	test('a match ended, then its lines and its winner changed, in one transaction; and in one statement with an ended match', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		await session(A, P, 0, 4);
		const m = await match(A, 1, false);
		await line(m, A, P, 'Valkyra');
		await line(m, A, Q, 'Lonestar');
		await env.db.transaction(async (tx) => {
			await tx
				.update(matches)
				.set({ endedAt: at(2), finalScores: scores, winner: 'Valkyra' })
				.where(eq(matches.id, m));
			await tx.execute(sql`UPDATE match_players SET kills = kills + 5 WHERE match_id = ${m}`);
			await tx.update(matches).set({ winner: 'Lonestar' }).where(eq(matches.id, m));
		});
		await exact([A]);
		// one statement ending an open match and editing an ended one, both with P
		const open = await match(A, 3, false);
		await line(open, A, P, 'Lonestar', 9);
		await env.db.execute(sql`
			UPDATE matches SET ended_at = COALESCE(ended_at, ${at(4)}), final_scores = ${JSON.stringify(scores)}::jsonb,
			       winner = 'Lonestar'
			 WHERE id IN (${m}, ${open})`);
		await exact([A]);
		// an upsert of an ended match's lines fires both statement triggers
		await writeMatchPlayers(env.db, A, m, [
			{
				steamId: P,
				name: 'p',
				faction: 'Valkyra',
				seconds: 1,
				idleSeconds: 0,
				kills: 1,
				deaths: 1,
				cashDelta: 0
			},
			{
				steamId: R,
				name: 'r',
				faction: 'White',
				seconds: 1,
				idleSeconds: 0,
				kills: 2,
				deaths: 0,
				cashDelta: 0
			}
		]);
		await exact([A]);
		// a line moved to another player, a match moved to another server, a line deleted
		await env.db.execute(
			sql`UPDATE match_players SET steam_id = ${R} WHERE match_id = ${open} AND steam_id = ${P}`
		);
		await exact([A]);
		await env.db.update(matches).set({ serverId: w.otherServer.id }).where(eq(matches.id, open));
		await exact([A]);
		await exact([w.otherServer.id]);
		await env.db.execute(sql`DELETE FROM match_players WHERE match_id = ${m} AND steam_id = ${Q}`);
		await exact([A]);
	});

	test('a purge leaves the totals as its sources: sessions kept, lines gone, lines-only players gone', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		await session(A, P, 0, 3);
		const m = await match(A, 1, true);
		await line(m, A, P, 'Valkyra');
		await line(m, A, Q, 'Lonestar');
		await exact([A]);
		await purgeServerStats(env, new Request('http://localhost/'), w.users.owner!, {
			...(await env.db.query.servers.findFirst({ where: (s, { eq }) => eq(s.id, A) }))!
		});
		await exact([A]);
		const rows = (await env.db.execute(sql`
			SELECT steam_id, sessions, matches FROM player_totals WHERE server_id = ${A}`)) as {
			steam_id: string;
			sessions: number;
			matches: number;
		}[];
		expect(rows).toEqual([{ steam_id: P, sessions: 1, matches: 0 }]);
		// the day rows too: P's two days, their session's; Q's only day held nothing but the line
		const days = (await env.db.execute(sql`
			SELECT steam_id, sessions, matches FROM player_days WHERE server_id = ${A} ORDER BY steam_id, day`)) as {
			steam_id: string;
			sessions: number;
			matches: number;
		}[];
		expect(days.map((d) => [d.steam_id, d.sessions, d.matches])).toEqual([
			[P, 0, 0],
			[P, 1, 0]
		]);
	});

	test('a day row holding nothing (no writer leaves one; a hand insert) is nobody on a board', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		await session(A, P, 0, 3);
		await env.db.execute(sql`
			INSERT INTO player_days (server_id, day, steam_id)
			VALUES (${A}, (${at(30)}::timestamptz AT TIME ZONE 'UTC')::date, ${R})`);
		await exact([A]);
	});

	test('day rows: a session over two midnights closes, moves across a midnight by hand and goes; another closes at a midnight', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		const long = await session(A, P, 1, null);
		await env.db.execute(
			sql`UPDATE player_sessions SET last_seen = ${at(27.5)} WHERE id = ${long}`
		);
		await env.db.execute(sql`UPDATE player_sessions SET left_at = last_seen WHERE id = ${long}`);
		await exact([A]);
		// an hour on the first day, the whole second, an hour and a half on the third; crossings on
		// the last two, the close on the last
		const days = async () =>
			(
				(await env.db.execute(sql`
					SELECT seconds::text AS seconds, COALESCE(cardinality(crossings), 0) AS crossings, sessions
					  FROM player_days WHERE server_id = ${A} AND steam_id = ${P} ORDER BY day`)) as {
					seconds: string;
					crossings: number;
					sessions: number;
				}[]
			).map((d) => [Number(d.seconds), d.crossings, d.sessions]);
		expect(await days()).toEqual([
			[3600, 0, 0],
			[86400, 1, 0],
			[5400, 1, 1]
		]);
		// moved three hours back by hand: it now closes on the second day
		await env.db
			.update(playerSessions)
			.set({ joinedAt: at(-2), leftAt: at(24.5), lastSeen: at(24.5) })
			.where(eq(playerSessions.id, long));
		await exact([A]);
		expect(await days()).toEqual([
			[4 * 3600, 0, 0],
			[22.5 * 3600, 1, 1]
		]);
		// one closed exactly at a midnight: no time on that day, but its close and its crossing are
		const edge = await session(A, Q, 1, null);
		await env.db.execute(
			sql`UPDATE player_sessions SET last_seen = ${at(2)}, left_at = ${at(2)} WHERE id = ${edge}`
		);
		await exact([A]);
		await env.db.delete(playerSessions).where(eq(playerSessions.id, long));
		await exact([A]);
		expect(await days()).toEqual([]);
	});

	test('day rows: a match whose end moves to another day, a line added after, then the match reopened', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		await session(A, P, 0, 30);
		const m = await match(A, 0.5, true);
		await line(m, A, P, 'Valkyra');
		await line(m, A, Q, 'Lonestar');
		await exact([A]);
		await env.db
			.update(matches)
			.set({ endedAt: at(2.5) })
			.where(eq(matches.id, m));
		await exact([A]);
		await line(m, A, R, 'Valkyra', 6);
		await exact([A]);
		await env.db.update(matches).set({ endedAt: null }).where(eq(matches.id, m));
		await exact([A]);
		const [{ n }] = (await env.db.execute(sql`
			SELECT COUNT(*)::int AS n FROM player_days WHERE server_id = ${A} AND matches > 0`)) as {
			n: number;
		}[];
		expect(n).toBe(0);
	});

	test('a closed session must have last_seen equal to left_at: an edit or a close that breaks it is refused, and a rebuild over one', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		const closed = await session(A, P, 0, 3);
		const open = await session(A, Q, 1, null);
		const refused = (q: Query) =>
			env.db.execute(q).then(
				() => 'accepted',
				(err: { cause?: { message?: string } }) => String(err?.cause?.message ?? err)
			);
		expect(
			await refused(sql`UPDATE player_sessions SET last_seen = ${at(2)} WHERE id = ${closed}`)
		).toMatch(/last_seen equal to left_at/);
		expect(
			await refused(sql`UPDATE player_sessions SET left_at = ${at(2.5)} WHERE id = ${open}`)
		).toMatch(/last_seen equal to left_at/);
		expect(
			await refused(sql`
				INSERT INTO player_sessions (server_id, steam_id, name, joined_at, last_seen, left_at)
				VALUES (${A}, ${R}, 'r', ${at(0)}, ${at(1)}, ${at(2)})`)
		).toMatch(/last_seen equal to left_at/);
		await exact([A]);
		// a row that breaks it with the triggers off (a bulk load gone wrong) stops the rebuild
		const rebuilt = await env.db
			.transaction(async (tx) => {
				await tx.execute(
					sql`ALTER TABLE player_sessions DISABLE TRIGGER player_totals_session_updated`
				);
				await tx.execute(sql`UPDATE player_sessions SET last_seen = ${at(2)} WHERE id = ${closed}`);
				await tx.execute(sql`SELECT player_totals_rebuild()`);
			})
			.then(
				() => 'rebuilt',
				(err: { cause?: { message?: string } }) => String(err?.cause?.message ?? err)
			);
		expect(rebuilt).toMatch(/player_days not built/);
		await exact([A]);
	});

	test('a streak goes into a row with no match yet as it is, below zero too', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		// the session makes P's rows first (streaks 0); the match ends on a day it covers
		await session(A, P, 0, 3);
		const m = await match(A, 1, false);
		await env.db.insert(matchPlayers).values({
			matchId: m,
			serverId: A,
			steamId: P,
			name: 'p',
			faction: 'Valkyra',
			deaths: 3,
			killStreak: -1,
			deathStreak: -2
		});
		await env.db
			.update(matches)
			.set({ endedAt: at(2), finalScores: scores, winner: 'Valkyra' })
			.where(eq(matches.id, m));
		await exact([A]);
	});

	test('day rows follow UTC, not the connection, and split microseconds either side of a midnight', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		const midnight = at(2).toISOString();
		await env.db.transaction(async (tx) => {
			await tx.execute(sql`SET LOCAL TIME ZONE 'Pacific/Chatham'`);
			// over two midnights, closed in a +13:45 session
			const [{ id }] = await tx
				.insert(playerSessions)
				.values({ serverId: A, steamId: P, name: 'p', joinedAt: at(1), lastSeen: at(1.5) })
				.returning({ id: playerSessions.id });
			await tx.execute(
				sql`UPDATE player_sessions SET last_seen = ${at(27)}, left_at = ${at(27)} WHERE id = ${id}`
			);
			// a microsecond before a midnight to a microsecond after it
			await tx.execute(sql`
				INSERT INTO player_sessions (server_id, steam_id, name, joined_at, last_seen, left_at)
				VALUES (${A}, ${Q}, 'q', ${midnight}::timestamptz - interval '1 microsecond',
				        ${midnight}::timestamptz + interval '1 microsecond', ${midnight}::timestamptz + interval '1 microsecond')`);
			const m = await match(A, 25, false);
			await line(m, A, P, 'Valkyra');
			await tx.execute(sql`
				UPDATE matches SET ended_at = ${midnight}::timestamptz + interval '1 day' - interval '1 microsecond',
				       final_scores = ${JSON.stringify(scores)}::jsonb, winner = 'Lonestar'
				 WHERE id = ${m}`);
		});
		// read in a -2:30 session and in UTC
		await env.db.transaction(async (tx) => {
			await tx.execute(sql`SET LOCAL TIME ZONE 'America/St_Johns'`);
			for (const from of SINCE)
				expect({ since: from.toISOString(), rows: await rangeRows(tx, [A], from) }).toEqual({
					since: from.toISOString(),
					rows: await oracleRangeBase(tx, [A], from)
				});
		});
		await exact([A]);
		const parts = (await env.db.execute(sql`
			SELECT day::text, seconds::text FROM player_days WHERE server_id = ${A} AND steam_id = ${Q} ORDER BY day`)) as {
			day: string;
			seconds: string;
		}[];
		expect(parts.map((d) => d.seconds)).toEqual(['0.000001', '0.000001']);
	});

	test('a transaction that is not READ COMMITTED is refused', async () => {
		const w = await seedWorld(env);
		const A = w.server.id;
		const id = await session(A, P, 0, 1);
		const refused = await env.db
			.transaction(
				async (tx) => {
					await tx.update(playerSessions).set({ cash: 1 }).where(eq(playerSessions.id, id));
				},
				{ isolationLevel: 'repeatable read' }
			)
			.then(
				() => null,
				(err: { cause?: { message?: string } }) => err
			);
		expect(String(refused?.cause?.message)).toMatch(/READ COMMITTED only/);
		await exact([A]);
	});

	describe('the worker and a purge on one server', () => {
		/** History on a server: a closed and an open session, an ended match, an open one with lines. */
		const history = async () => {
			const w = await seedWorld(env);
			const A = w.server.id;
			await session(A, P, 0, 2);
			const open = await session(A, Q, 3, null);
			const ended = await match(A, 0, true);
			await line(ended, A, P, 'Valkyra');
			const current = await match(A, 2, false);
			await line(current, A, Q, 'Lonestar');
			return { w, A, open, current };
		};
		/** The purge's statements, the lock first, pausing after the lines when told to. */
		const purge = (A: string, pause?: Promise<void>, paused?: () => void) =>
			env.db.transaction(async (tx) => {
				await lockTotals(tx, A);
				await tx.execute(sql`DELETE FROM kills WHERE server_id = ${A}`);
				await tx.execute(sql`DELETE FROM match_players WHERE server_id = ${A}`);
				paused?.();
				if (pause) await pause;
				await tx.execute(sql`DELETE FROM matches WHERE server_id = ${A}`);
			});
		const kinds: Record<
			string,
			(tx: DbOrTx, h: Awaited<ReturnType<typeof history>>) => Promise<unknown>
		> = {
			'a session closing': (tx, h) =>
				tx.execute(
					sql`UPDATE player_sessions SET left_at = last_seen WHERE id = ${h.open} AND left_at IS NULL`
				),
			"leavers' lines": (tx, h) =>
				writeMatchPlayers(tx, h.A, h.current, [
					{
						steamId: Q,
						name: 'q',
						faction: 'Lonestar',
						seconds: 9,
						idleSeconds: 0,
						kills: 7,
						deaths: 1,
						cashDelta: 5
					}
				]),
			'a match ending': async (tx, h) => {
				await writeMatchPlayers(tx, h.A, h.current, [
					{
						steamId: Q,
						name: 'q',
						faction: 'Lonestar',
						seconds: 9,
						idleSeconds: 0,
						kills: 7,
						deaths: 1,
						cashDelta: 5
					},
					{
						steamId: R,
						name: 'r',
						faction: 'Valkyra',
						seconds: 9,
						idleSeconds: 0,
						kills: 1,
						deaths: 4,
						cashDelta: 0
					}
				]);
				await tx
					.update(matches)
					.set({ endedAt: new Date(), finalScores: scores, winner: 'Valkyra' })
					.where(eq(matches.id, h.current));
			},
			'an abandoned match': (tx, h) =>
				tx.update(matches).set({ endedAt: new Date() }).where(eq(matches.id, h.current)),
			'the offline transition': async (tx, h) => {
				await tx.execute(
					sql`UPDATE player_sessions SET left_at = last_seen WHERE server_id = ${h.A} AND left_at IS NULL`
				);
				await writeMatchPlayers(tx, h.A, h.current, [
					{
						steamId: Q,
						name: 'q',
						faction: 'Lonestar',
						seconds: 9,
						idleSeconds: 0,
						kills: 7,
						deaths: 1,
						cashDelta: 5
					}
				]);
			}
		};

		for (const [kind, write] of Object.entries(kinds)) {
			test(`${kind}, the purge holding the lock: the worker waits, both commit, exact`, async () => {
				const h = await history();
				const deleted = gate();
				const go = gate();
				const purging = purge(h.A, go.opened, deleted.open);
				await deleted.opened;
				const writing = env.db.transaction(async (tx) => {
					await lockTotals(tx, h.A);
					await write(tx, h);
				});
				await untilWaiting();
				go.open();
				await Promise.all([purging, writing]);
				await exact([h.A]);
			});
			test(`${kind}, the worker holding the lock: the purge waits, both commit, exact`, async () => {
				const h = await history();
				const written = gate();
				const go = gate();
				const writing = env.db.transaction(async (tx) => {
					await lockTotals(tx, h.A);
					await write(tx, h);
					written.open();
					await go.opened;
				});
				await written.opened;
				const purging = purge(h.A);
				await untilWaiting();
				go.open();
				await Promise.all([purging, writing]);
				await exact([h.A]);
			});
		}

		test('a purge holding the totals lock does not hold up the lease: the worker waits for the lock before the lease row', async () => {
			const h = await history();
			expect(await acquireOrRenew(env, 'totals-lease')).toBe(true);
			const deleted = gate();
			const go = gate();
			const purging = purge(h.A, go.opened, deleted.open);
			await deleted.opened;
			const writing = withOwnedTransaction(env, (tx) => tx.execute(sql`SELECT 1`), {
				totalsOf: h.A
			});
			// with the lease row held FOR SHARE by the waiting write, the renewal would queue
			// behind it until the purge let go
			let renewed: boolean | string = 'not tried';
			try {
				await untilWaiting();
				renewed = await Promise.race([
					acquireOrRenew(env, 'totals-lease'),
					Bun.sleep(3_000).then(() => 'stalled')
				]);
			} finally {
				go.open();
				await Promise.allSettled([purging, writing]);
			}
			expect(renewed).toBe(true);
			await exact([h.A]);
		});

		test('a write that waited for the totals lock while the lease changed hands and came back is dropped, not written', async () => {
			const h = await history();
			expect(await acquireOrRenew(env, 'totals-lease')).toBe(true);
			const period = ownershipPeriod();
			const deleted = gate();
			const go = gate();
			const purging = purge(h.A, go.opened, deleted.open);
			await deleted.opened;
			let ran = false;
			const writing = withOwnedTransaction(
				env,
				async () => {
					ran = true;
				},
				{ totalsOf: h.A, period }
			);
			let outcome: unknown = 'not settled';
			try {
				await untilWaiting();
				// another process takes the lease and lets it lapse; this one takes it back
				await env.db.execute(sql`
					UPDATE worker_ownership SET token = 'another process', acquired_at = now(),
					       lease_until = now() - interval '1 second'`);
				expect(await acquireOrRenew(env, 'totals-lease')).toBe(true);
				expect(ownershipPeriod()).not.toBe(period);
			} finally {
				go.open();
				const [w] = await Promise.allSettled([writing, purging]);
				outcome = w.status === 'rejected' ? w.reason : 'written';
			}
			expect(ran).toBe(false);
			expect(outcome).toBeInstanceOf(StaleOwnership);
			expect(isOwner()).toBe(true);
		});

		test('without the lock first, an abandoned match against a purge deadlocks', async () => {
			const h = await history();
			const deleted = gate();
			const go = gate();
			const purging = purge(h.A, go.opened, deleted.open);
			await deleted.opened;
			// the match row is locked by the update, then its trigger waits for the purge's lock;
			// the purge then wants that row
			const abandoning = env.db.transaction(async (tx) => {
				await tx.update(matches).set({ endedAt: new Date() }).where(eq(matches.id, h.current));
			});
			await untilWaiting();
			go.open();
			const settled = await Promise.allSettled([purging, abandoning]);
			const failed = settled.filter((s) => s.status === 'rejected') as PromiseRejectedResult[];
			expect(failed).toHaveLength(1);
			expect(String(failed[0].reason?.cause?.message ?? failed[0].reason)).toMatch(/deadlock/);
			await exact([h.A]);
		});
	});

	// The two ways the day rows arrive on a database with history: 0038 and 0039 in one migration
	// run (Drizzle runs every pending migration in one transaction), or 0039 over 0038's totals;
	// either way with the migrations after them in the same run.
	for (const [label, after] of [
		[
			'0038 and 0039 in one run over a database at 0037',
			['0038_player_totals', '0039_player_days']
		],
		['0039 over a database at 0038', ['0039_player_days']]
	] as const)
		test(`migrations: ${label} build the totals and day rows the reads expect`, async () => {
			const base = process.env.TEST_DATABASE_URL!;
			const name = `warcon_test_totals_${randomBytes(4).toString('hex')}`;
			const admin = new SQL(base, { max: 1 });
			await admin.unsafe(`CREATE DATABASE "${name}"`);
			const url = new URL(base);
			url.pathname = `/${name}`;
			const { client, db } = connect(url.href);
			const dir = await mkdtemp(join(tmpdir(), 'warcon-migrate-'));
			try {
				// every migration before these, and none after them: Drizzle takes the newest one
				// applied for the point the database is at, so a later one run first would leave
				// these out
				await cp('drizzle', dir, { recursive: true });
				const journal = JSON.parse(await readFile(join(dir, 'meta', '_journal.json'), 'utf8'));
				const first = journal.entries.findIndex((e: { tag: string }) => e.tag === after[0]);
				expect(first).toBeGreaterThan(0);
				for (const { tag } of journal.entries.slice(first) as { tag: string }[]) {
					await rm(join(dir, `${tag}.sql`));
					await rm(join(dir, 'meta', `${tag.slice(0, 4)}_snapshot.json`), { force: true });
				}
				journal.entries = journal.entries.slice(0, first);
				await writeFile(join(dir, 'meta', '_journal.json'), JSON.stringify(journal));
				await runMigrations(db, dir);
				// history as the worker leaves it: closed and open sessions, one over two midnights,
				// one closed and one opened exactly at a midnight; ended, drawn, abandoned and open
				// matches with lines, one ended exactly at a midnight, one on the holding side; a
				// player with lines only
				const s = (
					server: string,
					steamId: string,
					from: number,
					to: number | null,
					cash: number
				) => ({
					serverId: server,
					steamId,
					name: `n${steamId.slice(-1)}`,
					faction: 'Valkyra',
					joinedAt: at(from),
					lastSeen: at(to ?? from + 0.25),
					leftAt: to === null ? null : at(to),
					kills: 1,
					deaths: 1,
					cash,
					seedSeconds: from * 10
				});
				await db
					.insert(playerSessions)
					.values([
						s('a', P, 0, 1.5, 500),
						s('a', P, 2, 3.25, 700),
						s('a', Q, 1, 2, 50),
						s('a', Q, 4, null, 20),
						s('a', R, 1, 27, 300),
						s('b', P, 1, 1.75, 900),
						s('b', R, 3, null, 0)
					]);
				const [won, drawn, abandoned, open] = await db
					.insert(matches)
					.values([
						{
							serverId: 'a',
							startedAt: at(0),
							endedAt: at(1),
							map: 'Kavkazi',
							finalScores: scores,
							winner: 'Valkyra'
						},
						{
							serverId: 'a',
							startedAt: at(1),
							endedAt: at(2),
							map: 'Europe',
							finalScores: [
								{ name: 'Valkyra', score: 50 },
								{ name: 'Lonestar', score: 50 }
							],
							winner: null
						},
						{ serverId: 'b', startedAt: at(1), endedAt: at(26.5), map: 'Detroit' },
						{ serverId: 'a', startedAt: at(4), map: 'Kavkazi' }
					])
					.returning({ id: matches.id });
				const l = (
					matchId: number,
					server: string,
					steamId: string,
					faction: string | null,
					kills: number
				) => ({
					matchId: matchId,
					serverId: server,
					steamId,
					name: 'l',
					faction,
					seconds: 300,
					kills,
					deaths: 1,
					killStreak: kills
				});
				await insertEarlyLines(db, [
					l(won.id, 'a', P, 'Valkyra', 5),
					l(won.id, 'a', Q, 'White', 2),
					l(drawn.id, 'a', P, 'Lonestar', 3),
					l(drawn.id, 'a', 'lines-only-player', 'Valkyra', 7),
					l(abandoned.id, 'b', P, 'Valkyra', 4),
					l(open.id, 'a', Q, 'Lonestar', 9)
				]);
				// a negative streak merged the 0038 way where 0038 is in: a session closed first (the
				// pair's row has no match yet), then a match ended with the player's line at -1
				const [late] = await db
					.insert(playerSessions)
					.values(s('a', S, 4.5, null, 10))
					.returning({ id: playerSessions.id });
				await db.execute(
					sql`UPDATE player_sessions SET last_seen = ${at(5)}, left_at = ${at(5)} WHERE id = ${late.id}`
				);
				const [negative] = await db
					.insert(matches)
					.values({ serverId: 'a', startedAt: at(4.6), map: 'Europe' })
					.returning({ id: matches.id });
				await insertEarlyLines(db, [
					{ ...l(negative.id, 'a', S, 'Valkyra', 0), killStreak: -1, deathStreak: -2 }
				]);
				await db.execute(sql`
					UPDATE matches SET ended_at = ${at(5.5)}, final_scores = ${JSON.stringify(scores)}::jsonb,
					       winner = 'Valkyra'
					 WHERE id = ${negative.id}`);
				// then the rest
				await runMigrations(db, 'drizzle');
				await db.transaction(async (tx) => {
					for (const ids of [['a'], ['b'], ['a', 'b']]) {
						expect(await totalsRows(tx, ids)).toEqual(await oracleBase(tx, ids));
						for (const from of SINCE)
							expect({
								ids,
								since: from.toISOString(),
								rows: await rangeRows(tx, ids, from)
							}).toEqual({
								ids,
								since: from.toISOString(),
								rows: await oracleRangeBase(tx, ids, from)
							});
					}
				});
				const [{ n, days }] = (await db.execute(sql`
					SELECT (SELECT COUNT(*) FROM player_totals)::int AS n,
					       (SELECT COUNT(*) FROM player_days)::int AS days`)) as { n: number; days: number }[];
				// (a, P), (a, Q), (a, R), (a, S), (b, P) from closed sessions and lines; the lines-only
				// player; not (b, R), whose only session is open
				expect(n).toBe(6);
				// (a, P) on two days, (a, Q) on two, (a, R) on three, (a, S) on one, (b, P) on two (its
				// session, then the abandoned match's line the next day), the lines-only player on one
				expect(days).toBe(11);
			} finally {
				await client.close();
				await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
				await admin.close();
				await rm(dir, { recursive: true, force: true });
			}
		}, 60_000);
});
