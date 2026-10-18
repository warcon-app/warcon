// Each player's totals per server (player_totals, kept by the triggers of migration 0038) and per
// server per UTC day (player_days, migration 0039) against the all-time and ranged reads they
// replace, word for word (totals-oracle.ts). Seeded random histories run through the worker's own
// looks at a scripted game on three servers (two in one organisation, one in another): joins and
// returns, leaves past the grace, renames, side changes and the holding side, counters that start
// again mid-match, cash, scores, match ends with a winner, a draw or no score, abandoned matches
// after an outage, the offline transition and worker restarts; with purges and direct writes in
// between (closed sessions inserted, edited, moved and deleted, lines added to an ended match, a
// winner changed, a match's end moved, an ended match whose scores are not numbers). The clock
// starts an hour before a UTC midnight and now and then moves on by hours or days with players on,
// so sessions and matches cross midnights, some several. After every step the all-time base rows
// of each set of servers are equal column by column, and so are the rows since a spread of
// instants (the boards' own 7, 30 and 90 days back; midnights and a millisecond either side; a
// join, a leave and a match end and a millisecond either side; random ones; before and after all
// the data), and so are the rows of finished seasons between them (neighbouring and random pairs,
// and ends on the start's own day, at its midnight, the day after and later, a millisecond either
// side), all read in one transaction (one now()); every tenth step and at the end the reads
// themselves are equal too (every board metric both ways at two floors for all time, and for each
// range and a few finished seasons, every player's rank, the placeholders' stats, the risk
// record), and a rebuild leaves both tables as they were.
import { afterAll, beforeAll, describe, expect, setSystemTime, spyOn, test } from 'bun:test';
import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { OrgRow, ServerRow } from '$lib/server/access';
import {
	kills,
	matches,
	matchPlayers,
	organizations,
	playerSessions,
	servers,
	triggers
} from '$lib/server/db/schema';
import { acquireOrRenew } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer, type ServerMemory } from '$lib/server/observe';
import { GameError, WardogsClient } from '$lib/server/rcon';
import { purgeServerStats } from '$lib/server/stats';
import { lockTotals } from '$lib/server/totals';
import {
	EXPORT_ROWS,
	exportBoard,
	playerStats,
	rankOf,
	riskPerformanceFor
} from '$lib/server/leaderboards';
import { BOARD_METRICS, type BoardQuery, type FixedRange } from '$lib/leaderboard';
import { fixedWindow, type BoardWindow } from '$lib/server/seasons';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';
import {
	oracleBase,
	oracleBoard,
	oracleRangeBase,
	oracleRank,
	oracleRiskRecord,
	oracleSeasonBase,
	rangeRows,
	seasonRows,
	totalsRows
} from './totals-oracle';

const DEFAULT_SEED = 20261004;
const SEED = Number(process.env.TOTALS_SEED ?? DEFAULT_SEED);
const STEPS = Number(process.env.TOTALS_STEPS ?? 120);
const FACTIONS = ['Valkyra', 'Lonestar', 'White', null] as const;
const MAPS = ['Kavkazi', 'Europe', 'Bakurani', 'Detroit'];
const POOL = Array.from({ length: 24 }, (_, i) => `765611980000${String(31000 + i)}`);
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The UTC midnight at or before t (epoch milliseconds count whole UTC days). */
const midnight = (t: number) => Math.floor(t / DAY) * DAY;
const ms = (v: unknown) => new Date(v as string | Date).getTime();

/** mulberry32: the same history for the same seed. */
function rng(seed: number) {
	let a = seed >>> 0;
	const next = () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		int: (n: number) => Math.floor(next() * n),
		chance: (p: number) => next() < p,
		pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]
	};
}

interface OnServer {
	name: string;
	faction: string | null;
	kills: number;
	deaths: number;
	cash: number;
}
interface Game {
	server: ServerRow;
	org: OrgRow;
	m: ServerMemory;
	map: string;
	scores: [number, number];
	/** looks left until it answers again */
	down: number;
	players: Map<string, OnServer>;
}

describe.skipIf(!hasTestDb)('player totals against the reads they replace', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	// An hour before a UTC midnight twelve days back; the jumps never take the clock past a day ago.
	const start = midnight(Date.now() - 12 * DAY) - HOUR;
	const ceiling = Date.now() - DAY;
	let clock = start;
	const games = new Map<string, Game>();
	const r = rng(SEED);
	// The range starts the comparisons take, drawn on their own so they leave the history alone.
	const pick = rng(SEED ^ 0x5eed);
	let names = 0;

	const json = (body: unknown) => ({
		status: 200,
		statusText: 'OK',
		headers: { 'content-type': 'application/json' },
		text: JSON.stringify(body)
	});
	const tick = async (ms: number) => {
		clock += ms;
		setSystemTime(new Date(clock));
		expect(await acquireOrRenew(env, 'player-totals')).toBe(true);
	};
	/** Hours, now and then days, going by with whoever is on staying on (their sessions span it). */
	const jump = () =>
		Math.max(
			60_000,
			Math.min(
				r.chance(0.15) ? (1 + r.int(2)) * DAY + r.int(DAY) : (1 + r.int(9)) * HOUR,
				ceiling - clock
			)
		);
	const look = async (g: Game) => {
		g.m.playersIntervalMs = 120_000;
		await observeServer(env, g.m, { status: true, players: true });
		if (g.down > 0) g.down--;
	};
	const restart = (g: Game) => {
		forgetMemory(g.server.id);
		g.m = memoryFor(g.server, g.org);
	};
	const newName = (steamId: string) => `P${steamId.slice(-3)}-${++names % 7}`;
	let events = 0;

	/** A few kills from the feed on the server's open match (the feed server only). */
	const feed = async (g: Game) => {
		const on = [...g.players.keys()];
		if (on.length < 2 || g.down) return;
		const [open] = await env.db
			.select({ id: matches.id })
			.from(matches)
			.where(and(eq(matches.serverId, g.server.id), sql`ended_at IS NULL`));
		if (!open) return;
		const n = r.int(4);
		for (let i = 0; i < n; i++) {
			const killer = r.pick(on);
			const victim = r.chance(0.1) ? killer : r.pick(on);
			const kf = g.players.get(killer)!.faction;
			const vf = g.players.get(victim)!.faction;
			await env.db.insert(kills).values({
				ts: new Date(clock - r.int(4000)),
				serverId: g.server.id,
				eventId: `totals-${++events}`,
				instanceId: 'i',
				matchId: 'g',
				matchRow: open.id,
				eventTime: events,
				map: g.map,
				killerSteamId: killer,
				killerName: 'k',
				killerFaction: kf,
				victimSteamId: victim,
				victimName: 'v',
				victimFaction: vf,
				cause: r.pick(['Id.Item.AK74M', 'Id.Item.SVDM', 'Vehicle.Variant.Ground.Btr80']),
				distanceM: r.int(400),
				headshot: r.chance(0.3),
				suicide: killer === victim,
				teamKill: killer !== victim && !!kf && kf === vf,
				tags: []
			});
		}
	};

	/** One step of play on a server: the game changes, then the worker looks at it. */
	const play = (g: Game) => {
		const on = [...g.players.keys()];
		if (on.length < 14 && r.chance(0.5)) {
			const id = r.pick(POOL);
			if (!g.players.has(id))
				g.players.set(id, {
					name: newName(id),
					faction: r.pick(FACTIONS),
					kills: 0,
					deaths: 0,
					cash: r.int(3) * 100
				});
		}
		if (on.length && r.chance(0.3)) g.players.delete(r.pick(on));
		for (const [id, p] of g.players) {
			if (r.chance(0.6)) p.kills += r.int(4);
			if (r.chance(0.5)) p.deaths += r.int(3);
			if (r.chance(0.5)) p.cash = Math.max(0, p.cash + r.int(900) - 150);
			if (r.chance(0.04)) Object.assign(p, { kills: 0, deaths: 0, cash: 0 }); // a reconnect
			if (r.chance(0.05)) p.name = newName(id);
			if (r.chance(0.08)) p.faction = r.pick(FACTIONS);
		}
		if (r.chance(0.5)) g.scores[r.int(2)] += r.int(6);
		if (r.chance(0.07)) {
			// The match ends: the scores start again (sometimes on the next map), and so do the
			// counters, a look later for some (the list can show the next match first).
			if (r.chance(0.2)) g.scores[1] = g.scores[0];
			g.scores = [0, 0];
			if (r.chance(0.3)) g.map = r.pick(MAPS);
			for (const p of g.players.values()) Object.assign(p, { kills: 0, deaths: 0, cash: 0 });
		}
		if (r.chance(0.02)) g.down = 4;
		if (g.down === 1) g.map = r.pick(MAPS.filter((m) => m !== g.map)); // back on another map
	};

	/** A write that is not the worker's: a hand repair, a backfill, a test fixture. */
	const direct = async (g: Game) => {
		const at = new Date(clock - r.int(5) * 86_400_000 - r.int(3_600_000));
		switch (r.int(10)) {
			case 0: {
				const left = new Date(at.getTime() + 60_000 + r.int(7_200_000));
				await env.db.insert(playerSessions).values({
					serverId: g.server.id,
					steamId: r.pick(POOL),
					name: newName(r.pick(POOL)),
					faction: 'Valkyra',
					joinedAt: at,
					lastSeen: left,
					leftAt: left,
					kills: r.int(30),
					deaths: r.int(30),
					cash: r.int(5000),
					seedSeconds: r.int(600)
				});
				return;
			}
			case 1: {
				const [row] = await env.db
					.select({ id: playerSessions.id })
					.from(playerSessions)
					.where(and(eq(playerSessions.serverId, g.server.id), isNotNull(playerSessions.leftAt)))
					.limit(1)
					.offset(r.int(20));
				if (row)
					await env.db
						.update(playerSessions)
						.set({ cash: r.int(9000), seedSeconds: r.int(900) })
						.where(eq(playerSessions.id, row.id));
				return;
			}
			case 2: {
				const [row] = await env.db
					.select({ id: playerSessions.id })
					.from(playerSessions)
					.where(and(eq(playerSessions.serverId, g.server.id), isNotNull(playerSessions.leftAt)))
					.limit(1)
					.offset(r.int(20));
				if (row) await env.db.delete(playerSessions).where(eq(playerSessions.id, row.id));
				return;
			}
			case 3: {
				const [m] = await env.db
					.select({ id: matches.id })
					.from(matches)
					.where(and(eq(matches.serverId, g.server.id), isNotNull(matches.endedAt)))
					.limit(1)
					.offset(r.int(5));
				if (m)
					await env.db
						.insert(matchPlayers)
						.values({
							matchId: m.id,
							serverId: g.server.id,
							steamId: r.pick(POOL),
							name: 'late',
							faction: r.pick(FACTIONS),
							kills: r.int(20),
							deaths: r.int(20),
							killStreak: r.int(6),
							// fixed, not drawn: another draw would change every step after it
							idleSeconds: 420
						})
						.onConflictDoNothing();
				return;
			}
			case 4: {
				const [m] = await env.db
					.select({ id: matches.id })
					.from(matches)
					.where(and(eq(matches.serverId, g.server.id), isNotNull(matches.endedAt)))
					.limit(1)
					.offset(r.int(5));
				if (m)
					await env.db
						.update(matches)
						.set({ winner: r.pick(['Valkyra', 'Lonestar', null]) })
						.where(eq(matches.id, m.id));
				return;
			}
			case 6: {
				// a session closed by hand while the worker still thinks it open (its own close then
				// finds the row closed and changes nothing)
				const [row] = await env.db
					.select({ id: playerSessions.id })
					.from(playerSessions)
					.where(and(eq(playerSessions.serverId, g.server.id), sql`left_at IS NULL`))
					.limit(1);
				if (row)
					await env.db.execute(sql`
						UPDATE player_sessions SET left_at = last_seen, seed_seconds = seed_seconds + ${r.int(500)},
						       cash = cash + ${r.int(700)}
						 WHERE id = ${row.id} AND left_at IS NULL`);
				return;
			}
			case 5: {
				// an ended match whose scoreboard holds a score that is not a number
				const [m] = await env.db
					.insert(matches)
					.values({
						serverId: g.server.id,
						startedAt: at,
						endedAt: new Date(at.getTime() + 1_800_000),
						map: 'Europe',
						finalScores: [
							{ name: 'Valkyra', score: 'lots' },
							{ name: 'Lonestar', score: r.int(3) }
						],
						winner: null
					})
					.returning({ id: matches.id });
				await env.db.insert(matchPlayers).values(
					[r.pick(POOL), r.pick(POOL)]
						.filter((v, i, a) => a.indexOf(v) === i)
						.map((steamId, i) => ({
							matchId: m.id,
							serverId: g.server.id,
							steamId,
							name: 'odd',
							faction: i ? 'Lonestar' : 'White',
							kills: r.int(9),
							deaths: r.int(9),
							idleSeconds: 90
						}))
				);
				return;
			}
			case 7: {
				// a closed session over one or two midnights, written by hand
				const left = new Date(at.getTime() + 20 * HOUR + r.int(30 * HOUR));
				await env.db.insert(playerSessions).values({
					serverId: g.server.id,
					steamId: r.pick(POOL),
					name: newName(r.pick(POOL)),
					faction: 'Lonestar',
					joinedAt: at,
					lastSeen: left,
					leftAt: left,
					kills: r.int(30),
					deaths: r.int(30),
					cash: r.int(5000),
					seedSeconds: r.int(600)
				});
				return;
			}
			case 8: {
				// a closed session moved by hours, often across a midnight (last seen moves with it)
				const [row] = await env.db
					.select({
						id: playerSessions.id,
						joinedAt: playerSessions.joinedAt,
						leftAt: playerSessions.leftAt
					})
					.from(playerSessions)
					.where(and(eq(playerSessions.serverId, g.server.id), isNotNull(playerSessions.leftAt)))
					.limit(1)
					.offset(r.int(20));
				const by = (r.chance(0.5) ? -1 : 1) * (1 + r.int(30)) * HOUR;
				if (row) {
					const left = new Date(row.leftAt!.getTime() + by);
					await env.db
						.update(playerSessions)
						.set({ joinedAt: new Date(row.joinedAt.getTime() + by), leftAt: left, lastSeen: left })
						.where(eq(playerSessions.id, row.id));
				}
				return;
			}
			case 9: {
				// an ended match's end moved by hours, often to another day
				const [m] = await env.db
					.select({ id: matches.id, endedAt: matches.endedAt })
					.from(matches)
					.where(and(eq(matches.serverId, g.server.id), isNotNull(matches.endedAt)))
					.limit(1)
					.offset(r.int(5));
				const by = (r.chance(0.5) ? -1 : 1) * (1 + r.int(30)) * HOUR;
				if (m)
					await env.db
						.update(matches)
						.set({ endedAt: new Date(m.endedAt!.getTime() + by) })
						.where(eq(matches.id, m.id));
				return;
			}
		}
	};

	const sets = () => {
		const a = w.server.id;
		const b = w.otherServer.id;
		const c = w.otherOrgServer.id;
		return [[a], [b], [a, b], [c], [a, b, c]];
	};
	/** The base rows of every set of servers, equal column by column. */
	const compareBase = async (step: string) => {
		await env.db.transaction(async (tx) => {
			for (const ids of sets()) {
				const want = await oracleBase(tx, ids);
				const got = await totalsRows(tx, ids);
				expect({ step, ids, rows: got }).toEqual({ step, ids, rows: want });
			}
		});
	};

	/**
	 * Range starts worth holding the day rows to: the boards' own; a midnight and a millisecond
	 * either side; a join, a leave, a match end and an open session's join, each a millisecond
	 * either side; random instants; before and after all the data.
	 */
	const instants = async (ids: string[], every: boolean): Promise<number[]> => {
		const span = clock - start + 2 * DAY;
		const anywhere = () => start - DAY + Math.floor(pick.next() * span);
		const m = midnight(anywhere());
		const out = [clock - 7 * DAY, clock - 30 * DAY, clock - 90 * DAY, start - 2 * DAY, clock + DAY];
		out.push(m - 1, m, m + 1, midnight(clock));
		for (let i = 0; i < (every ? 6 : 2); i++) out.push(anywhere());
		const one = async (q: SQL) => ((await env.db.execute(q)) as { t: unknown }[])[0]?.t;
		const edges = [
			await one(sql`SELECT joined_at AS t FROM player_sessions WHERE server_id IN ${ids}
			               AND left_at IS NOT NULL ORDER BY id OFFSET ${pick.int(40)} LIMIT 1`),
			await one(sql`SELECT left_at AS t FROM player_sessions WHERE server_id IN ${ids}
			               AND left_at IS NOT NULL ORDER BY id OFFSET ${pick.int(40)} LIMIT 1`),
			await one(sql`SELECT ended_at AS t FROM matches WHERE server_id IN ${ids}
			               AND ended_at IS NOT NULL ORDER BY id OFFSET ${pick.int(20)} LIMIT 1`),
			await one(sql`SELECT joined_at AS t FROM player_sessions WHERE server_id IN ${ids}
			               AND left_at IS NULL ORDER BY id OFFSET ${pick.int(10)} LIMIT 1`)
		];
		for (const e of edges) if (e) out.push(ms(e) - 1, ms(e), ms(e) + 1);
		return out;
	};
	/** The rows since each of those instants, equal column by column, in one transaction. */
	const compareRanges = async (step: string, every: boolean) => {
		const plan: [string[], number[]][] = [];
		for (const ids of sets()) plan.push([ids, await instants(ids, every)]);
		await env.db.transaction(async (tx) => {
			for (const [ids, ts] of plan)
				for (const t of ts) {
					const from = new Date(t);
					const since = from.toISOString();
					expect({ step, ids, since, rows: await rangeRows(tx, ids, from) }).toEqual({
						step,
						ids,
						since,
						rows: await oracleRangeBase(tx, ids, from)
					});
				}
		});
	};

	/**
	 * Finished seasons worth holding the day rows to, from those instants: each one to the next
	 * and (every tenth step) to a random later one; and from one of them, ends on its own day, at
	 * its midnight and a millisecond either side, within the day after, at the midnight after
	 * that and a millisecond either side, and days later.
	 */
	const windows = (ts: number[], every: boolean): [number, number][] => {
		const u = [...new Set(ts)].sort((a, b) => a - b);
		const out: [number, number][] = [];
		for (let i = 0; i + 1 < u.length; i++) {
			out.push([u[i], u[i + 1]]);
			if (every) out.push([u[i], u[i + 1 + pick.int(u.length - i - 1)]]);
		}
		const f = u[pick.int(u.length)];
		const m1 = midnight(f) + DAY;
		for (const t of [f + 1, m1 - 1, m1, m1 + 1, m1 + HOUR, m1 + DAY - 1, m1 + DAY, m1 + DAY + 1])
			out.push([f, t]);
		out.push([f, m1 + 3 * DAY + HOUR]);
		// a season always ends after it starts
		return out.filter(([from, to]) => to > from);
	};
	/** The rows of each of those seasons, equal column by column, in one transaction. */
	const compareSeasons = async (step: string, every: boolean) => {
		const plan: [string[], [number, number][]][] = [];
		for (const ids of sets()) plan.push([ids, windows(await instants(ids, every), every)]);
		await env.db.transaction(async (tx) => {
			for (const [ids, ws] of plan)
				for (const [f, t] of ws) {
					const from = new Date(f);
					const to = new Date(t);
					const season = `${from.toISOString()} to ${to.toISOString()}`;
					expect({ step, ids, season, rows: await seasonRows(tx, ids, from, to) }).toEqual({
						step,
						ids,
						season,
						rows: await oracleSeasonBase(tx, ids, from, to)
					});
				}
		});
	};

	/** The reads themselves: boards, ranks, placeholders' stats and the risk record. */
	const compareReads = async (step: string) => {
		await env.db.transaction(async (tx) => {
			const e = { ...env, db: tx } as unknown as Env;
			for (const ids of sets()) {
				const players = (await oracleBase(tx, ids)).map((b) => b.steam_id as string);
				// all time: every metric both ways at both floors; each range: every metric at the
				// default floor, and one more each way round; two finished seasons: every metric at
				// the default floor
				const boards: { q: BoardQuery; win: BoardWindow }[] = [];
				const board = (
					win: BoardWindow,
					sort: BoardQuery['sort'],
					dir: BoardQuery['dir'],
					minMinutes: number
				) =>
					boards.push({
						q: { scope: 'server', range: win.range, sort, dir, page: 1, minMinutes },
						win
					});
				// the clock is frozen: each range starts where the board's own does
				for (const metric of BOARD_METRICS)
					for (const dir of ['desc', 'asc'] as const)
						for (const minMinutes of [0, 60])
							board(fixedWindow('all'), metric.key, dir, minMinutes);
				for (const range of ['7d', '30d', '90d'] as FixedRange[]) {
					for (const metric of BOARD_METRICS) board(fixedWindow(range), metric.key, 'desc', 60);
					board(fixedWindow(range), BOARD_METRICS[pick.int(BOARD_METRICS.length)].key, 'asc', 60);
					board(fixedWindow(range), BOARD_METRICS[pick.int(BOARD_METRICS.length)].key, 'desc', 0);
				}
				const spans = windows(await instants(ids, true), false);
				for (const [f, t] of [spans[pick.int(spans.length)], [start - DAY, clock - DAY]]) {
					const win: BoardWindow = {
						range: 's:test',
						from: new Date(f),
						to: new Date(t),
						season: null,
						finished: true
					};
					for (const metric of BOARD_METRICS) board(win, metric.key, 'desc', 60);
				}
				for (const { q, win } of boards) {
					const want = (
						await oracleBoard(tx, ids, q, EXPORT_ROWS, 0, win.from ?? undefined, win.to)
					).map((o, i) => ({
						rank: i + 1,
						steamId: o.steamId as string,
						name: ((o.name as string | null) || o.steamId) as string,
						minutes: Math.round(Number(o.minutes)),
						cashMinutes: Math.round(Number(o.cashMinutes)),
						seedMinutes: Math.round(Number(o.seedMinutes)),
						idleMinutes: Math.round(Number(o.idleMinutes)),
						kills: Number(o.kills),
						deaths: Number(o.deaths),
						headshots: Number(o.headshots),
						teamKills: Number(o.teamKills),
						suicides: Number(o.suicides),
						vehicleKills: Number(o.vehicleKills),
						killStreak: Number(o.killStreak),
						deathStreak: Number(o.deathStreak),
						matches: Number(o.matches),
						wins: Number(o.wins),
						losses: Number(o.losses),
						draws: Number(o.draws),
						cash: Number(o.cash),
						lastSeen: o.lastSeen ? new Date(o.lastSeen as string).toISOString() : null
					}));
					expect({ step, ids, q, win, rows: await exportBoard(e, ids, q, win) }).toEqual({
						step,
						ids,
						q,
						win,
						rows: want
					});
				}
				for (const p of players)
					expect({ step, ids, p, rank: await rankOf(e, ids, p) }).toEqual({
						step,
						ids,
						p,
						rank: await oracleRank(tx, ids, p)
					});
				const stats = await playerStats(e, ids, POOL);
				const statsWant = await oracleBase(tx, ids, POOL);
				expect({ step, ids, stats: Object.fromEntries(stats) }).toEqual({
					step,
					ids,
					stats: Object.fromEntries(
						statsWant.map((b) => [
							b.steam_id,
							{
								kills: Number(b.kills),
								deaths: Number(b.deaths),
								minutes: Number(b.minutes),
								seedMinutes: Number(b.seed_minutes),
								matches: Number(b.matches),
								wins: Number(b.wins),
								losses: Number(b.losses),
								draws: Number(b.draws)
							}
						])
					)
				});
				// the record of matches; the kill-feed part (feedKills, headshots) is read as before
				const risk = await riskPerformanceFor(e, ids, POOL);
				const riskWant = new Map(
					(await oracleRiskRecord(tx, ids, POOL)).map((o) => [o.steamId as string, o])
				);
				const played = (steamId: string) => {
					const v = risk.get(steamId);
					return v && [v.matches, v.wins, v.losses, v.draws, v.kills, v.deaths];
				};
				for (const steamId of POOL) {
					const o = riskWant.get(steamId);
					expect({ step, ids, steamId, played: played(steamId) }).toEqual({
						step,
						ids,
						steamId,
						played: o
							? [o.matches, o.wins, o.losses, o.draws, o.kills, o.deaths].map(Number)
							: risk.has(steamId)
								? [0, 0, 0, 0, 0, 0]
								: undefined
					});
				}
			}
		});
	};

	const table = async () =>
		(await env.db.execute(sql`
			SELECT t::text AS row FROM player_totals t
			 WHERE server_id IN ${sets()[4]} ORDER BY server_id, steam_id`)) as { row: string }[];
	/** The day rows, each crossing list in order (the adds append, a rebuild lists them sorted). */
	const dayTable = async () =>
		(await env.db.execute(sql`
			SELECT (d.server_id, d.day, d.steam_id, d.seconds,
			        (SELECT array_agg(c ORDER BY c) FROM unnest(d.crossings) c),
			        d.sessions, d.seed_seconds, d.cash, d.last_seen, d.matches, d.kills, d.deaths, d.headshots,
			        d.team_kills, d.suicides, d.vehicle_kills, d.kill_streak, d.death_streak, d.wins,
			        d.losses, d.draws, d.idle_seconds)::text AS row
			  FROM player_days d WHERE server_id IN ${sets()[4]} ORDER BY server_id, day, steam_id`)) as {
			row: string;
		}[];

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		setSystemTime(new Date(clock));
		expect(await acquireOrRenew(env, 'player-totals')).toBe(true);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`player-totals-${server.id}`
			);
			const raw = client.raw.bind(client);
			client.raw = async (method, path, body, headers) => {
				const g = games.get(server.id);
				if (!g || method !== 'GET' || (path !== '/v1/players' && path !== '/v1/status'))
					return raw(method, path, body, headers);
				if (g.down > 0) throw new GameError(502, 'connect ECONNREFUSED', 'unreachable');
				if (path === '/v1/players')
					return json({
						players: [...g.players].map(([steamId, p]) => ({ steamId, ping: 40, ...p })),
						count: g.players.size
					});
				return json({
					serverName: 'Totals',
					map: g.map,
					experiences: [],
					players: { current: g.players.size, max: 100 },
					factionScores: [
						{ name: 'Valkyra', colorHex: '#D86060', score: g.scores[0] },
						{ name: 'Lonestar', colorHex: '#5B95D8', score: g.scores[1] }
					],
					rotation: { nowIndex: 0, nextIndex: 1 }
				});
			};
			return client;
		});
		// A seeding rule on one server, so the sessions the worker closes carry seed time; it asks
		// for more minutes than anyone plays, so it never grants a slot.
		await env.db.insert(triggers).values({
			id: `seed-${w.server.id}`,
			serverId: w.server.id,
			orgId: w.org.id,
			kind: 'seed_reward',
			name: 'Seed time',
			enabled: true,
			config: {
				scope: 'server',
				lowAt: 8,
				untilFull: false,
				fullAt: null,
				minutes: 1_000_000,
				windowDays: 30,
				slotDays: 1,
				message: ''
			}
		});
		for (const id of [w.server.id, w.otherServer.id, w.otherOrgServer.id]) {
			const [server] = await env.db.select().from(servers).where(eq(servers.id, id));
			const [org] = await env.db
				.select()
				.from(organizations)
				.where(eq(organizations.id, server.orgId));
			if (id === w.otherServer.id) {
				// the feed server: its match ends fill the feed's columns from its kills
				await env.db
					.update(servers)
					.set({ feedTokenHash: `totals-feed-${id}` })
					.where(eq(servers.id, id));
				server.feedTokenHash = `totals-feed-${id}`;
			}
			forgetMemory(id);
			games.set(id, {
				server,
				org,
				m: memoryFor(server, org),
				map: r.pick(MAPS),
				scores: [0, 0],
				down: 0,
				players: new Map()
			});
		}
	});

	afterAll(async () => {
		spy.mockRestore();
		for (const id of games.keys()) forgetMemory(id);
		setSystemTime();
		await acquireOrRenew(env, 'player-totals');
	});

	test(`${STEPS} steps of play, outages, restarts, purges and hand edits (seed ${SEED})`, async () => {
		for (let step = 1; step <= STEPS; step++) {
			const label = `seed ${SEED} step ${step}`;
			await tick(r.chance(0.06) ? jump() : 5_000 + r.int(90_000));
			for (const g of games.values()) {
				play(g);
				if (r.chance(0.02)) restart(g);
				await look(g);
				if (g.server.id === w.otherServer.id) await feed(g);
			}
			if (r.chance(0.12)) await direct(r.pick([...games.values()]));
			if (r.chance(0.015)) {
				const g = r.pick([...games.values()]);
				await purgeServerStats(env, new Request('http://localhost/test'), w.users.owner!, g.server);
			}
			await compareBase(label);
			await compareRanges(label, step % 10 === 0);
			await compareSeasons(label, step % 10 === 0);
			if (step % 10 === 0) await compareReads(label);
		}
		// Everyone leaves; the last sessions close and their matches stay open.
		for (const g of games.values()) g.players.clear();
		await tick(70_000);
		for (const g of games.values()) await look(g);
		await tick(70_000);
		for (const g of games.values()) await look(g);
		await compareBase(`seed ${SEED} end`);
		await compareRanges(`seed ${SEED} end`, true);
		await compareSeasons(`seed ${SEED} end`, true);
		await compareReads(`seed ${SEED} end`);
		const before = await table();
		const beforeDays = await dayTable();
		await env.db.execute(sql`SELECT player_totals_rebuild()`);
		expect(await table()).toEqual(before);
		expect(await dayTable()).toEqual(beforeDays);
		// The default history (the one CI runs) reaches every path the totals have: closes with seed
		// time and cash, match ends with the feed's columns, hand edits, midnights. Other seeds explore.
		if (SEED === DEFAULT_SEED) {
			const [counts] = (await env.db.execute(sql`
				SELECT (SELECT COUNT(*) FROM player_sessions WHERE server_id IN ${sets()[4]} AND left_at IS NOT NULL)::int AS closed,
				       (SELECT COUNT(*) FROM matches WHERE server_id IN ${sets()[4]} AND ended_at IS NOT NULL)::int AS ended,
				       (SELECT COUNT(*) FROM match_players WHERE server_id IN ${sets()[4]})::int AS lines`)) as {
				closed: number;
				ended: number;
				lines: number;
			}[];
			expect(counts.closed).toBeGreaterThan(50);
			expect(counts.ended).toBeGreaterThan(10);
			expect(counts.lines).toBeGreaterThan(50);
			const [seeded] = (await env.db.execute(sql`
				SELECT COUNT(*)::int AS n FROM player_sessions
				 WHERE server_id = ${w.server.id} AND left_at IS NOT NULL AND seed_seconds > 0`)) as {
				n: number;
			}[];
			expect(seeded.n).toBeGreaterThan(5);
			const [fed] = (await env.db.execute(sql`
				SELECT COUNT(*)::int AS n FROM match_players p JOIN matches m ON m.id = p.match_id
				 WHERE p.server_id = ${w.otherServer.id} AND m.ended_at IS NOT NULL AND p.kill_streak > 1`)) as {
				n: number;
			}[];
			expect(fed.n).toBeGreaterThan(5);
			// and crosses midnights: closed sessions over one and over two or more, match ends on
			// several days, day rows holding crossings
			const [days] = (await env.db.execute(sql`
				WITH s AS (
					SELECT (left_at AT TIME ZONE 'UTC')::date - (joined_at AT TIME ZONE 'UTC')::date AS spans
					  FROM player_sessions WHERE server_id IN ${sets()[4]} AND left_at IS NOT NULL)
				SELECT (SELECT COUNT(*) FROM s WHERE spans = 1)::int AS one,
				       (SELECT COUNT(*) FROM s WHERE spans >= 2)::int AS several,
				       (SELECT COUNT(DISTINCT (ended_at AT TIME ZONE 'UTC')::date) FROM matches
				         WHERE server_id IN ${sets()[4]} AND ended_at IS NOT NULL)::int AS end_days,
				       (SELECT COUNT(*) FROM player_days WHERE server_id IN ${sets()[4]}
				         AND crossings IS NOT NULL)::int AS crossing_rows`)) as {
				one: number;
				several: number;
				end_days: number;
				crossing_rows: number;
			}[];
			expect(days.one).toBeGreaterThan(2);
			expect(days.several).toBeGreaterThan(5);
			expect(days.end_days).toBeGreaterThan(2);
			expect(days.crossing_rows).toBeGreaterThan(10);
		}
		// A purge of the server with the most history, then the same checks, and a rebuild that
		// leaves the day rows as the purge did (no row emptied of its lines left behind).
		await purgeServerStats(
			env,
			new Request('http://localhost/test'),
			w.users.owner!,
			games.get(w.server.id)!.server
		);
		await compareBase(`seed ${SEED} after a purge`);
		await compareRanges(`seed ${SEED} after a purge`, true);
		await compareSeasons(`seed ${SEED} after a purge`, true);
		const purged = await dayTable();
		await env.db.execute(sql`SELECT player_totals_rebuild()`);
		expect(await dayTable()).toEqual(purged);
	}, 900_000);

	/** Somebody waits for a server's totals lock. */
	const untilWaiting = async () => {
		for (let i = 0; i < 500; i++) {
			const [row] = (await env.db.execute(sql`
				SELECT COUNT(*)::int AS n FROM pg_locks
				 WHERE locktype = 'advisory' AND NOT granted
				   AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`)) as {
				n: number;
			}[];
			if (row.n > 0) return;
			await Bun.sleep(20);
		}
		throw new Error('nobody waited for the totals lock');
	};
	/** A server of its own with two players on, looked at once. */
	const fresh = async () => {
		const w2 = await seedWorld(env);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w2.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w2.org.id));
		forgetMemory(server.id);
		const g: Game = {
			server,
			org,
			m: memoryFor(server, org),
			map: 'Kavkazi',
			scores: [3, 1],
			down: 0,
			players: new Map(
				POOL.slice(0, 2).map((id) => [
					id,
					{ name: newName(id), faction: 'Valkyra', kills: 2, deaths: 1, cash: 50 }
				])
			)
		};
		games.set(server.id, g);
		await tick(1_000);
		await look(g);
		await tick(20_000);
		await look(g);
		return g;
	};
	/** A purge that holds the lock, deletes the lines and waits before the matches. */
	const purgeHolding = (serverId: string) => {
		let deleted!: () => void;
		let go!: () => void;
		const ready = new Promise<void>((resolve) => (deleted = resolve));
		const released = new Promise<void>((resolve) => (go = resolve));
		const done = env.db.transaction(async (tx) => {
			await lockTotals(tx, serverId);
			await tx.execute(sql`DELETE FROM kills WHERE server_id = ${serverId}`);
			await tx.execute(sql`DELETE FROM match_players WHERE server_id = ${serverId}`);
			deleted();
			await released;
			await tx.execute(sql`DELETE FROM matches WHERE server_id = ${serverId}`);
		});
		return { ready, go, done };
	};
	const openMaps = async (serverId: string) =>
		(
			await env.db
				.select({ map: matches.map })
				.from(matches)
				.where(and(eq(matches.serverId, serverId), sql`ended_at IS NULL`))
		).map((m) => m.map);

	test('the worker takes the totals lock before it touches a row: an abandoned match against a purge', async () => {
		const g = await fresh();
		g.down = 3;
		for (let i = 0; i < 3; i++) {
			await tick(10_000);
			await look(g);
		}
		g.map = 'Europe';
		const purge = purgeHolding(g.server.id);
		await purge.ready;
		await tick(10_000);
		// back on another map: the open match is abandoned, which waits for the purge's lock
		// before it locks the match row the purge is about to delete
		const looking = look(g);
		await untilWaiting();
		purge.go();
		await Promise.all([purge.done, looking]);
		// the match stage finished (a failed one would have opened nothing)
		expect(await openMaps(g.server.id)).toEqual(['Europe']);
		await env.db.transaction(async (tx) => {
			expect(await totalsRows(tx, [g.server.id])).toEqual(await oracleBase(tx, [g.server.id]));
		});
	});

	test('the worker takes the totals lock before it touches a row: a match end against a purge', async () => {
		const g = await fresh();
		const purge = purgeHolding(g.server.id);
		await purge.ready;
		// the scores fall back on the same map: the match ends, which waits for the purge's lock
		// before it reads the match or writes a line the purge has deleted
		g.scores = [0, 0];
		for (const p of g.players.values()) Object.assign(p, { kills: 0, deaths: 0, cash: 0 });
		await tick(10_000);
		const looking = look(g);
		await untilWaiting();
		purge.go();
		await Promise.all([purge.done, looking]);
		expect(await openMaps(g.server.id)).toEqual(['Kavkazi']);
		await env.db.transaction(async (tx) => {
			expect(await totalsRows(tx, [g.server.id])).toEqual(await oracleBase(tx, [g.server.id]));
		});
	});
});
