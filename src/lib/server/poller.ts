// Background sampler: every POLL_SECONDS it asks each game server for status and players, stores
// a sample, and turns the player list into sessions and match boundaries. Only one process polls:
// the leader holds a Postgres advisory lock on a reserved connection, so extra replicas stay idle.
import { and, desc, eq, gt, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { Env } from './env';
import { pollSeconds } from './env';
import { publicMessage } from './http';
import type { ServerRow } from './access';
import { ACTIONS } from './actions';
import { WardogsClient } from './rcon';
import { matches, playerSessions, samples, serverBans, servers } from './db/schema';
import { getProfiles, steamEnabled } from './steam';
import { runTriggers } from './triggers';
import type { Ban, Player, Status } from '$lib/types';

export { pollSeconds };

const SAMPLE_RETENTION_DAYS = 90;
const SESSION_RETENTION_DAYS = 365;
/** Close open sessions after this many consecutive failed polls. */
const OFFLINE_AFTER_FAILURES = 3;
/** Any stable 64-bit constant; identifies "the Warcon poller" to pg_try_advisory_lock. */
const LEADER_LOCK_KEY = 7741221;
/** How often each server's ban list and reserved slots are re-read for the trigger engine. */
const LISTS_TTL_MS = 5 * 60_000;

interface Memory {
	inFlight: boolean;
	failures: number;
	lastMatchSeconds: number | null;
	/** Scores from the previous sample: the last known state of a match that just ended. */
	lastScores: unknown;
	/** No successful tick yet in this process: every open session would look like a join. */
	firstTick: boolean;
	/** Ban list and reserved slots, refreshed every LISTS_TTL_MS. */
	listsAt: number;
	reserved: Set<string>;
}

const memory = new Map<string, Memory>();
const mem = (id: string): Memory => {
	let m = memory.get(id);
	if (!m) {
		m = {
			inFlight: false,
			failures: 0,
			lastMatchSeconds: null,
			lastScores: null,
			firstTick: true,
			listsAt: 0,
			reserved: new Set()
		};
		memory.set(id, m);
	}
	return m;
};

declare global {
	// Survives Vite HMR re-evaluation in dev so we never run two loops.
	var __warconPoller: ReturnType<typeof setInterval> | undefined;
}

type Reserved = Awaited<ReturnType<Env['sql']['reserve']>>;
let leaderConn: Reserved | null = null;
let leader = false;

/** Tries (once per tick) to become the poller for this database. The lock lives on a reserved connection. */
async function ensureLeader(env: Env): Promise<boolean> {
	if (leader) return true;
	try {
		leaderConn ??= await env.sql.reserve();
		const [row] = (await leaderConn`SELECT pg_try_advisory_lock(${LEADER_LOCK_KEY}) AS ok`) as {
			ok: boolean;
		}[];
		leader = !!row?.ok;
		if (leader) console.log('[warcon] this instance is the analytics poller');
		return leader;
	} catch (err) {
		console.error('[warcon] leader lock', err);
		leaderConn = null;
		return false;
	}
}

export function startPoller(env: Env): void {
	const seconds = pollSeconds(env);
	if (globalThis.__warconPoller) clearInterval(globalThis.__warconPoller);
	if (!seconds) {
		console.log('[warcon] analytics poller disabled (POLL_SECONDS=0)');
		return;
	}
	let ticks = 0;
	const tick = async () => {
		if (!(await ensureLeader(env))) return;
		await pollAll(env).catch((err) => console.error('[warcon] poll', err));
		if (ticks++ % Math.max(1, Math.floor(3600 / seconds)) === 0)
			await prune(env).catch((err) => console.error('[warcon] prune', err));
	};
	globalThis.__warconPoller = setInterval(() => void tick(), seconds * 1000);
	setTimeout(() => void tick(), 2000);
	console.log(`[warcon] analytics poller every ${seconds}s`);
}

export async function pollAll(env: Env): Promise<void> {
	const all = await env.db.select().from(servers);
	await Promise.all(all.map((s) => pollServer(env, s)));
}

export async function pollServer(env: Env, server: ServerRow): Promise<void> {
	const m = mem(server.id);
	if (m.inFlight) return;
	m.inFlight = true;
	const started = Date.now();
	const ts = new Date();
	try {
		let status: Status;
		let players: Player[];
		let client: WardogsClient;
		try {
			client = await WardogsClient.forServer(env, server);
			status = (await ACTIONS.status.run(client, {})) as Status;
			players = ((await ACTIONS.players.run(client, {})) as { players: Player[] }).players;
		} catch (err) {
			m.failures++;
			await env.db.insert(samples).values({
				serverId: server.id,
				ts,
				ok: false,
				latencyMs: Date.now() - started,
				error: publicMessage(err, 'Poll failed.').slice(0, 300)
			});
			if (m.failures === OFFLINE_AFTER_FAILURES) {
				await env.db
					.update(playerSessions)
					.set({ leftAt: sql`${playerSessions.lastSeen}` })
					.where(and(eq(playerSessions.serverId, server.id), isNull(playerSessions.leftAt)));
				m.lastMatchSeconds = null;
			}
			return;
		}
		// Joins seen on the first tick of a process, or right after an outage closed every session,
		// are reconnects or people who were there all along: no whispers or kicks for those.
		const joinsReliable = !m.firstTick && m.failures === 0;
		m.failures = 0;
		m.firstTick = false;
		const scores = status.scores.map((s) => ({ name: s.name, score: s.score }));
		await env.db.insert(samples).values({
			serverId: server.id,
			ts,
			ok: true,
			playerCount: status.playerCount,
			maxPlayers: status.maxPlayers,
			map: status.map,
			experiences: status.experiences.join('+'),
			lighting: status.lighting,
			matchSeconds: status.matchSeconds,
			scores,
			latencyMs: Date.now() - started
		});
		const { joined, firstVisit } = await reconcileSessions(env, server.id, ts, players);
		await reconcileMatch(env, server.id, ts, status, m, scores);
		await refreshLists(env, server, client, m, ts).catch((err) =>
			console.warn('[warcon] ban list snapshot', publicMessage(err))
		);
		// Warm the Steam cache for newcomers so the players table and dossier have their data.
		if (joined.length && steamEnabled(env))
			await getProfiles(
				env,
				joined.map((p) => p.steamId)
			);
		await runTriggers(env, {
			server,
			client,
			status,
			players,
			joined,
			firstVisit,
			reserved: m.reserved,
			joinsReliable,
			ts
		});
	} finally {
		m.inFlight = false;
	}
}

/** Re-reads the ban list and reserved slots now and then; bans are kept in server_bans for the dossier. */
async function refreshLists(
	env: Env,
	server: ServerRow,
	client: WardogsClient,
	m: Memory,
	ts: Date
): Promise<void> {
	if (ts.getTime() - m.listsAt < LISTS_TTL_MS) return;
	m.listsAt = ts.getTime();
	const [bans, reserved] = await Promise.all([
		ACTIONS.bans.run(client, {}) as Promise<{ bans: Ban[] }>,
		(ACTIONS.reserved.run(client, {}) as Promise<{ reserved: string[] }>).catch(() => ({
			reserved: [...m.reserved]
		}))
	]);
	m.reserved = new Set(reserved.reserved);
	const rows = bans.bans.filter((b) => /^\d{17}$/.test(b.steamId));
	await env.db.transaction(async (tx) => {
		const ids = rows.map((b) => b.steamId);
		await tx
			.delete(serverBans)
			.where(
				ids.length
					? and(eq(serverBans.serverId, server.id), notInArray(serverBans.steamId, ids))
					: eq(serverBans.serverId, server.id)
			);
		if (rows.length)
			await tx
				.insert(serverBans)
				.values(
					rows.map((b) => ({
						serverId: server.id,
						steamId: b.steamId,
						reason: b.reason || '',
						bannedBy: b.bannedBy || '',
						bannedAtUtc: b.bannedAtUtc || '',
						seenAt: ts
					}))
				)
				.onConflictDoUpdate({
					target: [serverBans.serverId, serverBans.steamId],
					set: {
						reason: sql`excluded.reason`,
						bannedBy: sql`excluded.banned_by`,
						bannedAtUtc: sql`excluded.banned_at_utc`,
						seenAt: ts
					}
				});
	});
}

/** Returns who joined this tick (no open session before it) and which of those were never seen on this server. */
async function reconcileSessions(
	env: Env,
	serverId: string,
	ts: Date,
	players: Player[]
): Promise<{ joined: Player[]; firstVisit: Set<string> }> {
	const open = await env.db
		.select({ id: playerSessions.id, steamId: playerSessions.steamId })
		.from(playerSessions)
		.where(and(eq(playerSessions.serverId, serverId), isNull(playerSessions.leftAt)));
	const byId = new Map(open.map((s) => [s.steamId, s.id]));
	const seen = new Set<string>();
	const joined: Player[] = [];
	const firstVisit = new Set<string>();
	await env.db.transaction(async (tx) => {
		const joins: (typeof playerSessions.$inferInsert)[] = [];
		for (const p of players) {
			if (!p.steamId || seen.has(p.steamId)) continue;
			seen.add(p.steamId);
			const id = byId.get(p.steamId);
			if (id !== undefined) {
				await tx
					.update(playerSessions)
					.set({
						name: p.name,
						faction: p.faction,
						lastSeen: ts,
						kills: p.kills,
						deaths: p.deaths,
						cash: p.cash
					})
					.where(eq(playerSessions.id, id));
			} else {
				joined.push(p);
				joins.push({
					serverId,
					steamId: p.steamId,
					name: p.name,
					faction: p.faction,
					joinedAt: ts,
					lastSeen: ts,
					kills: p.kills,
					deaths: p.deaths,
					cash: p.cash
				});
			}
		}
		if (joins.length) {
			const known = await tx
				.selectDistinct({ steamId: playerSessions.steamId })
				.from(playerSessions)
				.where(
					and(
						eq(playerSessions.serverId, serverId),
						inArray(
							playerSessions.steamId,
							joins.map((j) => j.steamId)
						)
					)
				);
			const knownIds = new Set(known.map((k) => k.steamId));
			for (const j of joins) if (!knownIds.has(j.steamId)) firstVisit.add(j.steamId);
			await tx.insert(playerSessions).values(joins);
		}
		const gone = open.filter((s) => !seen.has(s.steamId)).map((s) => s.id);
		for (const id of gone)
			await tx
				.update(playerSessions)
				.set({ leftAt: sql`${playerSessions.lastSeen}` })
				.where(eq(playerSessions.id, id));
	});
	return { joined, firstVisit };
}

async function reconcileMatch(
	env: Env,
	serverId: string,
	ts: Date,
	status: Status,
	m: Memory,
	scores: { name: string; score: number }[]
): Promise<void> {
	const [current] = await env.db
		.select({ id: matches.id, map: matches.map, peakPlayers: matches.peakPlayers })
		.from(matches)
		.where(and(eq(matches.serverId, serverId), isNull(matches.endedAt)))
		.orderBy(desc(matches.id))
		.limit(1);
	const secs = status.matchSeconds ?? null;
	// A new match: the map changed, or the clock went backwards (restart / rotation advance).
	const restarted = secs !== null && m.lastMatchSeconds !== null && secs < m.lastMatchSeconds - 30;
	const mapChanged = !!current && current.map !== status.map;
	m.lastMatchSeconds = secs;
	if (current && (restarted || mapChanged)) {
		const last = (m.lastScores as { name: string; score: number }[] | null) ?? scores;
		const winner = [...last].sort((a, b) => b.score - a.score)[0]?.name ?? null;
		await env.db
			.update(matches)
			.set({ endedAt: ts, finalScores: last, winner })
			.where(eq(matches.id, current.id));
	}
	if (!current || restarted || mapChanged) {
		const startedAt = secs !== null ? new Date(ts.getTime() - secs * 1000) : ts;
		await env.db.insert(matches).values({
			serverId,
			startedAt,
			map: status.map,
			experiences: status.experiences.join('+'),
			lighting: status.lighting,
			peakPlayers: status.playerCount
		});
	} else if (status.playerCount > current.peakPlayers) {
		await env.db
			.update(matches)
			.set({ peakPlayers: status.playerCount })
			.where(eq(matches.id, current.id));
	}
	m.lastScores = scores;
}

async function prune(env: Env): Promise<void> {
	const cutSessions = new Date(Date.now() - SESSION_RETENTION_DAYS * 86400000);
	// TimescaleDB's retention policy drops old sample chunks; plain Postgres needs this delete.
	if (!env.timescale)
		await env.db
			.delete(samples)
			.where(lt(samples.ts, new Date(Date.now() - SAMPLE_RETENTION_DAYS * 86400000)));
	await env.db
		.delete(playerSessions)
		.where(and(lt(playerSessions.leftAt, cutSessions), gt(playerSessions.id, 0)));
	await env.db.delete(matches).where(lt(matches.endedAt, cutSessions));
}
