// One observation of one game server, and the worker's memory of every server it watches.
//
// An observation reads status and/or the player list (whichever is due), diffs the players
// against the open sessions, evaluates the server's triggers, and commits all of it in a single
// fenced transaction: session rows, trigger intents (the outbox), the live snapshot and, when
// something changed or the heartbeat is due, an analytics sample. Nothing is sent to the game
// from here; outbox.ts does that afterwards. Then the slower housekeeping runs, each part on its
// own: match bookkeeping, ban-list snapshot, org-list sync, Steam warm-up.
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Env } from './env';
import { publicMessage } from './http';
import type { OrgRow, ServerRow } from './access';
import { ACTIONS } from './actions';
import { WardogsClient } from './rcon';
import { matches, samples } from './db/schema';
import type { DbOrTx } from './db';
import { getProfiles, steamEnabled } from './steam';
import {
	enabledTriggers,
	evaluateTriggers,
	invalidateTriggers,
	needsRiskInputs,
	riskInputs,
	type TickContext
} from './triggers';
import { applyTriggerUpdates, enqueueIntents, wakeDelivery } from './outbox';
import { liveObserved, reconcileServer, writeSnapshot, type Observed } from './lists-sync';
import {
	closeAllSessions,
	diffPresence,
	firstVisits,
	loadPresence,
	newPresence,
	persistPresence,
	type Presence,
	type PresenceDiff
} from './sessions';
import { isOwner, LostOwnership, withOwnedTransaction } from './leadership';
import { settings } from './settings';
import { isWatched } from './interest';
import { emit } from './events';
import { liveView, writeLive } from './live';
import { nextDue } from './poller-schedule';
import { cashByFaction } from '$lib/cash';
import type { LiveView, Player, Status } from '$lib/types';

export type Tier = LiveView['tier'];

/** Consecutive failed observations before a server counts as offline (sessions close, cadence backs off). */
export const OFFLINE_AFTER_FAILURES = 3;
/** The live row is rewritten at least this often while the server is up, even if nothing changed. */
const LIVE_HEARTBEAT_MS = 10_000;

export interface ServerMemory {
	server: ServerRow;
	org: OrgRow;
	tier: Tier;
	/** when the running observation started, or null */
	inFlight: number | null;
	/** observe again as soon as the running observation ends (a command was just sent) */
	again: boolean;
	stuckReported: boolean;
	/** 0 until the scheduler has placed the server on its phase */
	playersDueAt: number;
	statusDueAt: number;
	/** the players cadence in force when the last players observation was launched */
	playersIntervalMs: number;
	failures: number;
	ok: boolean;
	error: string;
	/** last attempt, successful or not */
	observedAt: number;
	status: Status | null;
	statusAt: number;
	players: Player[];
	playersAt: number;
	presence: Presence;
	lastMatchSeconds: number | null;
	lastScores: unknown;
	reserved: Set<string>;
	listsAt: number;
	syncAt: number;
	liveKey: string;
	liveWrittenAt: number;
	sampleKey: string;
	sampleWrittenAt: number;
	/** observations completed */
	count: number;
}

const registry = new Map<string, ServerMemory>();

/** The memory for a server, created on first sight; server and org rows are refreshed each call. */
export function memoryFor(server: ServerRow, org: OrgRow): ServerMemory {
	let m = registry.get(server.id);
	if (!m) {
		m = {
			server,
			org,
			tier: 'idle',
			inFlight: null,
			again: false,
			stuckReported: false,
			playersDueAt: 0,
			statusDueAt: 0,
			playersIntervalMs: 0,
			failures: 0,
			ok: false,
			error: '',
			observedAt: 0,
			status: null,
			statusAt: 0,
			players: [],
			playersAt: 0,
			presence: newPresence(),
			lastMatchSeconds: null,
			lastScores: null,
			reserved: new Set(),
			listsAt: 0,
			syncAt: 0,
			liveKey: '',
			liveWrittenAt: 0,
			sampleKey: '',
			sampleWrittenAt: 0,
			count: 0
		};
		registry.set(server.id, m);
	} else {
		m.server = server;
		m.org = org;
	}
	return m;
}

export const memoryOf = (id: string): ServerMemory | undefined => registry.get(id);

/** Another process may have written since we last owned the worker: forget what we remember. */
export function forgetRemembered(): void {
	for (const m of registry.values()) {
		m.presence = newPresence();
		m.lastMatchSeconds = null;
		m.lastScores = null;
		m.liveKey = '';
		m.sampleKey = '';
		m.listsAt = 0;
		m.syncAt = 0;
	}
	invalidateTriggers();
}
export const allMemory = (): IterableIterator<ServerMemory> => registry.values();
export function forgetMemory(id: string): void {
	registry.delete(id);
}

// ---- tiers and cadence --------------------------------------------------------------------------

export interface ObserveKinds {
	status: boolean;
	players: boolean;
}

export function tierOf(m: ServerMemory, now = Date.now()): Tier {
	if (m.failures >= OFFLINE_AFTER_FAILURES) return 'offline';
	if (isWatched(m.server.id, now)) return 'watched';
	if ((m.status?.playerCount ?? 0) > 0 || m.players.length > 0) return 'hot';
	return 'idle';
}

export function cadenceOf(tier: Tier, failures = 0): { players: number; status: number } {
	const s = settings();
	switch (tier) {
		case 'watched':
			return { players: s.watchedPlayersMs, status: s.watchedStatusMs };
		case 'hot':
			return { players: s.hotPlayersMs, status: s.hotStatusMs };
		case 'idle':
			return { players: s.idleMs, status: s.idleMs };
		case 'offline': {
			const steps = Math.max(0, failures - OFFLINE_AFTER_FAILURES);
			const ms = Math.min(s.offlineMaxMs, s.offlineMs * 2 ** Math.min(steps, 10));
			return { players: ms, status: ms };
		}
	}
}

/** Sets the next due time of each kind being launched (fixed cadence); the other kind keeps its deadline. */
export function planNext(m: ServerMemory, now: number, kinds: ObserveKinds): void {
	m.tier = tierOf(m, now);
	const c = cadenceOf(m.tier, m.failures);
	if (kinds.players) {
		m.playersIntervalMs = c.players;
		m.playersDueAt = nextDue(m.playersDueAt || now, c.players, now);
	}
	if (kinds.status) m.statusDueAt = nextDue(m.statusDueAt || now, c.status, now);
}

/** After an observation the tier may have changed: pull the due times in if it got faster. */
export function replan(m: ServerMemory, now: number): void {
	m.tier = tierOf(m, now);
	const c = cadenceOf(m.tier, m.failures);
	m.playersDueAt = Math.min(Math.max(m.playersDueAt, now), now + c.players);
	m.statusDueAt = Math.min(Math.max(m.statusDueAt, now), now + c.status);
	if (m.again) {
		m.again = false;
		m.playersDueAt = now;
		m.statusDueAt = now;
	}
}

// ---- keys that decide what gets written -----------------------------------------------------------

const idsOf = (players: Player[]) =>
	players
		.map((p) => p.steamId)
		.sort()
		.join(',');

/** Changes that matter to a page load; scores, clock and pings move constantly and are left out. */
const liveKeyOf = (m: ServerMemory) =>
	JSON.stringify([
		m.ok,
		m.error,
		m.tier,
		m.status?.map,
		m.status?.experiences,
		m.status?.lighting,
		m.status?.playerCount,
		m.status?.maxPlayers,
		idsOf(m.players)
	]);

/** Changes that deserve an analytics sample between heartbeats. */
const sampleKeyOf = (m: ServerMemory) =>
	JSON.stringify([
		m.ok,
		m.status?.map,
		m.status?.experiences,
		m.status?.lighting,
		m.status?.playerCount,
		m.status?.maxPlayers
	]);

// ---- the observation ----------------------------------------------------------------------------

export async function observeServer(env: Env, m: ServerMemory, kinds: ObserveKinds): Promise<void> {
	const started = Date.now();
	const ts = new Date(started);
	const server = m.server;
	let client: WardogsClient;
	let status: Status | null = null;
	let players: Player[] | null = null;
	try {
		client = await WardogsClient.forServer(env, server);
		if (kinds.status || !m.status) status = (await ACTIONS.status.run(client, {})) as Status;
		if (kinds.players)
			players = ((await ACTIONS.players.run(client, {})) as { players: Player[] }).players;
	} catch (err) {
		await observationFailed(env, m, ts, started, err);
		return;
	}
	const latencyMs = Date.now() - started;
	const wasOffline = m.failures >= OFFLINE_AFTER_FAILURES;
	const prevPlayersAt = m.playersAt;
	m.failures = 0;
	m.ok = true;
	m.error = '';
	m.observedAt = started;
	m.count++;
	if (status) {
		m.status = status;
		m.statusAt = started;
	}
	if (players) {
		m.players = players;
		m.playersAt = started;
	}
	m.tier = tierOf(m, started);
	if (!m.presence.loaded) await loadPresence(env.db, server.id, m.presence);

	// Joins are trusted only when the previous look at the player list is recent enough that
	// nobody could have come and gone between the two. The first look after a start, a tier
	// change or an outage opens sessions quietly: everyone present then is a presence, not a join.
	const gapMs = started - prevPlayersAt;
	const joinsTrusted =
		!!players &&
		prevPlayersAt > 0 &&
		!wasOffline &&
		gapMs <= 2 * Math.max(m.playersIntervalMs, 1000) + 1000;
	const diff: PresenceDiff = players
		? diffPresence(m.presence, players)
		: { joined: [], left: [], stayed: [] };
	const joined = joinsTrusted ? diff.joined : [];
	const rows = m.status ? await enabledTriggers(env, server.id) : [];
	const risk =
		joined.length && needsRiskInputs(rows)
			? await riskInputs(env, server, joined)
			: { signals: new Map(), profiles: new Map() };

	const s = settings();
	const heartbeatDue = started - m.presence.heartbeatAt >= s.sessionHeartbeatMs;
	const liveKey = liveKeyOf(m);
	const liveDue = liveKey !== m.liveKey || started - m.liveWrittenAt >= LIVE_HEARTBEAT_MS;
	const sampleKey = sampleKeyOf(m);
	const sampleDue =
		!!m.status && (sampleKey !== m.sampleKey || started - m.sampleWrittenAt >= s.sampleMs);

	// Evaluate first (reads only), then write everything in one fenced transaction, and only when
	// there is something to write: an observation that changed nothing costs the database nothing.
	const firstVisit = joined.length
		? await firstVisits(
				env.db,
				server.id,
				joined.map((p) => p.steamId)
			)
		: new Set<string>();
	const ev =
		m.status && rows.length
			? await evaluateTriggers(
					env,
					{
						server,
						status: m.status,
						players: m.players,
						joined,
						firstVisit,
						reserved: m.reserved,
						signals: risk.signals,
						profiles: risk.profiles,
						ts
					},
					rows
				)
			: { intents: [], updates: [] };
	// Memory follows every player observation; the database only when something is due.
	for (const { player: p, session: s } of diff.stayed) {
		s.name = p.name;
		s.faction = p.faction;
		s.kills = p.kills;
		s.deaths = p.deaths;
		s.cash = p.cash;
		s.lastSeen = started;
	}
	const presenceDue =
		diff.joined.length > 0 || diff.left.length > 0 || (heartbeatDue && diff.stayed.length > 0);
	const needWrite =
		presenceDue || ev.intents.length > 0 || ev.updates.length > 0 || liveDue || sampleDue;
	let intents = 0;
	try {
		if (needWrite)
			await withOwnedTransaction(env, async (tx) => {
				if (players && presenceDue)
					await persistPresence(tx, server.id, m.presence, diff, ts, heartbeatDue);
				if (ev.intents.length) intents = await enqueueIntents(tx, server.id, ev.intents);
				if (ev.updates.length) await applyTriggerUpdates(tx, ev.updates);
				if (liveDue) await writeLive(tx, m, ts);
				if (sampleDue) await writeSample(tx, m, ts, latencyMs);
			});
		if (liveDue) {
			m.liveKey = liveKey;
			m.liveWrittenAt = started;
		}
		if (sampleDue) {
			m.sampleKey = sampleKey;
			m.sampleWrittenAt = started;
		}
	} catch (err) {
		// Nothing was committed, but the presence map may have moved: reload it next time so the
		// joins are seen (and their triggers evaluated) again.
		m.presence = newPresence();
		if (err instanceof LostOwnership) throw err;
		console.warn(`[warcon] observation of ${server.name} not saved:`, publicMessage(err));
	}
	emit({ type: 'live', live: liveView(m) });
	if (intents) wakeDelivery();

	// Housekeeping, each part on its own, and only while this process still owns the worker.
	if (status)
		await stage('match', m, () =>
			withOwnedTransaction(env, (tx) => reconcileMatch(tx, m, ts, status!))
		);
	if (isOwner()) await stage('lists', m, () => keepLists(env, m, client, started, ts));
	if (diff.joined.length && steamEnabled(env))
		void getProfiles(
			env,
			diff.joined.map((p) => p.steamId)
		).catch(() => {});
}

async function observationFailed(
	env: Env,
	m: ServerMemory,
	ts: Date,
	started: number,
	err: unknown
): Promise<void> {
	m.failures++;
	m.ok = false;
	m.error = publicMessage(err, 'Poll failed.').slice(0, 300);
	m.observedAt = started;
	m.tier = tierOf(m, started);
	const s = settings();
	const liveKey = liveKeyOf(m);
	const liveDue = liveKey !== m.liveKey || started - m.liveWrittenAt >= LIVE_HEARTBEAT_MS;
	const sampleDue = m.failures === 1 || started - m.sampleWrittenAt >= s.sampleMs;
	try {
		await withOwnedTransaction(env, async (tx) => {
			if (m.failures >= OFFLINE_AFTER_FAILURES) {
				// Close every open session once; a rollback below reloads the map so this retries.
				if (!m.presence.loaded) await loadPresence(tx, m.server.id, m.presence);
				if (m.presence.open.size) await closeAllSessions(tx, m.presence);
				m.lastMatchSeconds = null;
			}
			if (sampleDue)
				await tx.insert(samples).values({
					serverId: m.server.id,
					ts,
					ok: false,
					latencyMs: Date.now() - started,
					error: m.error
				});
			if (liveDue) await writeLive(tx, m, ts);
		});
		if (liveDue) {
			m.liveKey = liveKey;
			m.liveWrittenAt = started;
		}
		if (sampleDue) {
			m.sampleKey = 'failed';
			m.sampleWrittenAt = started;
		}
	} catch (e) {
		m.presence = newPresence();
		if (e instanceof LostOwnership) throw e;
		console.warn(`[warcon] failure of ${m.server.name} not saved:`, publicMessage(e));
	}
	emit({ type: 'live', live: liveView(m) });
}

async function stage(name: string, m: ServerMemory, fn: () => Promise<unknown>): Promise<void> {
	try {
		await fn();
	} catch (err) {
		if (err instanceof LostOwnership) throw err;
		console.warn(`[warcon] ${name} ${m.server.name}:`, err instanceof Error ? err.message : err);
	}
}

async function writeSample(
	db: DbOrTx,
	m: ServerMemory,
	ts: Date,
	latencyMs: number
): Promise<void> {
	const status = m.status!;
	await db.insert(samples).values({
		serverId: m.server.id,
		ts,
		ok: true,
		playerCount: status.playerCount,
		maxPlayers: status.maxPlayers,
		map: status.map,
		experiences: status.experiences.join('+'),
		lighting: status.lighting,
		matchSeconds: status.matchSeconds,
		scores: status.scores.map((f) => ({ name: f.name, score: f.score })),
		cash: cashByFaction(status, m.players),
		latencyMs
	});
}

/** Ban list and reserved slots now and then, and the org-list sync when it is due. */
async function keepLists(
	env: Env,
	m: ServerMemory,
	client: WardogsClient,
	started: number,
	ts: Date
): Promise<void> {
	const s = settings();
	let observed: Observed | undefined;
	if (started - m.listsAt >= s.listsSnapshotMs) {
		m.listsAt = started;
		observed = await liveObserved(client);
		m.reserved = new Set(observed.reserved);
		await writeSnapshot(env, m.server.id, observed, ts);
	}
	if (started - m.syncAt >= s.listSyncMs) {
		m.syncAt = started;
		const synced = await reconcileServer(env, m.server, m.org, {
			reason: 'poll',
			waitMs: 0,
			client,
			observed,
			lane: 'held'
		});
		if (synced.observed) m.reserved = new Set(synced.observed.reserved);
	}
}

async function reconcileMatch(
	db: DbOrTx,
	m: ServerMemory,
	ts: Date,
	status: Status
): Promise<void> {
	const serverId = m.server.id;
	const scores = status.scores.map((f) => ({ name: f.name, score: f.score }));
	const [current] = await db
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
		await db
			.update(matches)
			.set({ endedAt: ts, finalScores: last, winner })
			.where(eq(matches.id, current.id));
	}
	if (!current || restarted || mapChanged) {
		const startedAt = secs !== null ? new Date(ts.getTime() - secs * 1000) : ts;
		await db.insert(matches).values({
			serverId,
			startedAt,
			map: status.map,
			experiences: status.experiences.join('+'),
			lighting: status.lighting,
			peakPlayers: status.playerCount
		});
	} else if (status.playerCount > current.peakPlayers) {
		await db
			.update(matches)
			.set({ peakPlayers: status.playerCount })
			.where(eq(matches.id, current.id));
	}
	m.lastScores = scores;
}
