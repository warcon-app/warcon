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
import { ACTIONS, readConfig } from './actions';
import { reservedSlotsHeld } from '../reserved-doc';
import { GameError, WardogsClient } from './rcon';
import { matchPlayers, matches, samples, serverLive } from './db/schema';
import type { DbOrTx } from './db';
import { getProfiles, steamEnabled } from './steam';
import {
	enabledTriggers,
	evaluateTriggers,
	invalidateTriggers,
	needsRiskInputs,
	riskInputs,
	matchBoundary,
	seedRule,
	type MatchEnd,
	type MatchLook,
	type TickContext
} from './triggers';
import { applyTriggerUpdates, enqueueIntents, wakeDelivery } from './outbox';
import {
	banOnSight,
	liveObserved,
	reconcileServer,
	writeSnapshot,
	type Observed
} from './lists-sync';
import type { RefusedBan } from './lists-plan';
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
import { observations, observationSeconds } from './metrics';
import { nextDue, withHold } from './poller-schedule';
import { cashByFaction } from '$lib/cash';
import type { Features, LiveView, Player, Status } from '$lib/types';

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
	/** no look before this time: the listener answered 429 with Retry-After (not a failure) */
	holdUntil: number;
	ok: boolean;
	error: string;
	/** last attempt, successful or not */
	observedAt: number;
	status: Status | null;
	statusAt: number;
	players: Player[];
	playersAt: number;
	presence: Presence;
	/** the previous look at the match (map, scores, clock); null until one is remembered */
	lastMatch: MatchLook | null;
	reserved: Set<string>;
	/** bans the lists want here that the game refused (the player was not on): applied on sight */
	refusedBans: Map<string, RefusedBan>;
	listsAt: number;
	syncAt: number;
	liveKey: string;
	liveWrittenAt: number;
	sampleKey: string;
	sampleWrittenAt: number;
	/** what the build says about itself: refreshed hourly and after an outage */
	identity: Identity;
	/**
	 * When the game process started, from uptimeSeconds on GET /v1/health, read with every status
	 * observation; 0 until read. Stored as a start time so the uptime counts up without polling
	 * and a backwards jump says "restarted" even when the outage was too short to be seen.
	 */
	startedAt: number;
	/** the build answered "no such endpoint" to /v1/health; asked again when the identity is re-read */
	healthUnserved: boolean;
	/** observations completed */
	count: number;
}

/** Build string, feature flags and join code, from GET /v1/capabilities and /v1/server-id. */
export interface Identity {
	build: string;
	gameServerId: string;
	/** MaxReservedSlots from the config document; null until read or when the document lacks it */
	reservedSlots: number | null;
	features: Features | null;
	/** when it was last (re)read; 0 asks the next observation to read it */
	checkedAt: number;
	/** seeded from server_live once per process, so a failed first re-read cannot blank the row */
	hydrated: boolean;
}
/** Builds change with patches, not matches: one read per server per hour, and again after an outage. */
const IDENTITY_TTL_MS = 3600_000;

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
			holdUntil: 0,
			ok: false,
			error: '',
			observedAt: 0,
			status: null,
			statusAt: 0,
			players: [],
			playersAt: 0,
			presence: newPresence(),
			lastMatch: null,
			reserved: new Set(),
			refusedBans: new Map(),
			listsAt: 0,
			syncAt: 0,
			liveKey: '',
			liveWrittenAt: 0,
			sampleKey: '',
			sampleWrittenAt: 0,
			identity: {
				build: '',
				gameServerId: '',
				reservedSlots: null,
				features: null,
				checkedAt: 0,
				hydrated: false
			},
			startedAt: 0,
			healthUnserved: false,
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

/** Makes the next observation re-read the build (a connection test asked for a fresh look). */
export function requestIdentityRefresh(id: string): void {
	const m = registry.get(id);
	if (m) m.identity.checkedAt = 0;
}

/** After a failed re-read, try again this soon rather than waiting out the TTL. */
const IDENTITY_RETRY_MS = 5 * 60_000;

/** First sight of a server in this process: start from what the last worker wrote. */
async function hydrateIdentity(env: Env, m: ServerMemory): Promise<void> {
	if (m.identity.hydrated) return;
	m.identity.hydrated = true;
	try {
		const [row] = await env.db
			.select({
				build: serverLive.build,
				gameServerId: serverLive.gameServerId,
				reservedSlots: serverLive.reservedSlots,
				startedAt: serverLive.startedAt
			})
			.from(serverLive)
			.where(eq(serverLive.serverId, m.server.id))
			.limit(1);
		if (row) {
			if (!m.identity.build) m.identity.build = row.build;
			if (!m.identity.gameServerId) m.identity.gameServerId = row.gameServerId;
			if (m.identity.reservedSlots === null) m.identity.reservedSlots = row.reservedSlots;
			if (!m.startedAt && row.startedAt) m.startedAt = row.startedAt.getTime();
		}
	} catch (e) {
		console.warn(`[warcon] identity of ${m.server.name} not read:`, publicMessage(e));
	}
}

/** The listener asked us to slow down: hold the next look from now, never shortening a longer hold. */
function holdFor(m: ServerMemory, err: unknown): boolean {
	if (!(err instanceof GameError) || err.code !== 'rate_limited') return false;
	m.holdUntil = Math.max(m.holdUntil, Date.now() + (err.retryAfterMs || 5000));
	return true;
}

/**
 * Re-reads what the build says about itself. A failure keeps the previous answer (a transient
 * error must not blank the id on the status cards), retries in a few minutes rather than an hour,
 * and a 429 becomes a hold like any other; only a build that reports capabilities without the
 * server-id route clears the id.
 */
async function refreshIdentity(client: WardogsClient, m: ServerMemory, now: number): Promise<void> {
	const next: Identity = { ...m.identity, checkedAt: now };
	const retrySoon = () => {
		next.checkedAt = now - IDENTITY_TTL_MS + IDENTITY_RETRY_MS;
	};
	try {
		const caps = (await ACTIONS.capabilities.run(client, {})) as {
			features: Features;
			raw?: { build?: unknown };
		};
		next.features = caps.features;
		next.build = String(caps.raw?.build ?? '');
		if (!caps.features.serverId) next.gameServerId = '';
	} catch (err) {
		// Older builds have no capabilities route; anything else is retried soon.
		retrySoon();
		if (holdFor(m, err)) {
			m.identity = next;
			return;
		}
	}
	if (next.features?.serverId) {
		try {
			const r = (await ACTIONS.serverId.run(client, {})) as { serverId: string };
			next.gameServerId = r.serverId || '';
		} catch (err) {
			retrySoon();
			holdFor(m, err);
		}
	}
	// How many player slots the server holds back for reserved players lives in its config document
	// (MaxReservedSlots), which every build serves; the status route only reports the public cap.
	try {
		next.reservedSlots = reservedSlotsHeld((await readConfig(client)).text);
	} catch (err) {
		retrySoon();
		holdFor(m, err);
	}
	m.identity = next;
	// A new build may serve what the old one did not.
	m.healthUnserved = false;
}

/** uptimeSeconds is whole seconds and the read has latency: a start time this close is the same start. */
const START_DRIFT_MS = 5_000;

/**
 * Reads the process uptime and keeps it as a start time. A failure keeps the previous answer
 * (a transient error must not blank the uptime on the header); a build without the route is not
 * asked again until its identity is re-read; a 429 becomes a hold like any other.
 */
async function refreshUptime(client: WardogsClient, m: ServerMemory, now: number): Promise<void> {
	if (m.healthUnserved) return;
	try {
		const h = (await ACTIONS.health.run(client, {})) as { uptimeSeconds?: unknown };
		const up = Number(h?.uptimeSeconds);
		if (!Number.isFinite(up) || up < 0) return;
		const startedAt = now - Math.floor(up) * 1000;
		if (Math.abs(startedAt - m.startedAt) > START_DRIFT_MS) m.startedAt = startedAt;
	} catch (err) {
		if (err instanceof GameError && err.code === 'no_route') m.healthUnserved = true;
		else holdFor(m, err);
	}
}

/** Another process may have written since we last owned the worker: forget what we remember. */
export function forgetRemembered(): void {
	for (const m of registry.values()) {
		m.presence = newPresence();
		m.lastMatch = null;
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
	m.playersDueAt = withHold(m.playersDueAt, m.holdUntil, now);
	m.statusDueAt = withHold(m.statusDueAt, m.holdUntil, now);
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
	m.playersDueAt = withHold(m.playersDueAt, m.holdUntil, now);
	m.statusDueAt = withHold(m.statusDueAt, m.holdUntil, now);
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
		m.holdUntil,
		m.identity.build,
		m.identity.gameServerId,
		m.identity.reservedSlots,
		m.startedAt,
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
	await hydrateIdentity(env, m);
	try {
		client = await WardogsClient.forServer(env, server);
		if (kinds.status || !m.status) status = (await ACTIONS.status.run(client, {})) as Status;
		if (kinds.players)
			players = ((await ACTIONS.players.run(client, {})) as { players: Player[] }).players;
	} catch (err) {
		await observationFailed(env, m, ts, started, err);
		observations.inc({ outcome: 'failed' });
		observationSeconds.observe((Date.now() - started) / 1000);
		return;
	}
	const latencyMs = Date.now() - started;
	observations.inc({ outcome: 'ok' });
	observationSeconds.observe(latencyMs / 1000);
	const wasOffline = m.failures >= OFFLINE_AFTER_FAILURES;
	// Any failure may have been a restart onto a new build: re-read the identity on recovery.
	const hadFailed = m.failures > 0;
	const prevPlayersAt = m.playersAt;
	m.failures = 0;
	m.holdUntil = 0;
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
	// The match boundary is read from memory before anything is written, so the rules and the
	// match bookkeeping below see the same answer; memory then follows the observation.
	const look: MatchLook | null = status
		? {
				map: status.map,
				scores: status.scores.map((f) => ({ name: f.name, score: f.score })),
				matchSeconds: status.matchSeconds ?? null
			}
		: null;
	const matchEnd = look && !wasOffline ? matchBoundary(m.lastMatch, look) : null;
	if (look) m.lastMatch = look;
	if (hadFailed || started - m.identity.checkedAt >= IDENTITY_TTL_MS)
		await refreshIdentity(client, m, started);
	if (status) await refreshUptime(client, m, started);
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
		? diffPresence(m.presence, players, started)
		: { joined: [], left: [], stayed: [], factioned: [] };
	const joined = joinsTrusted ? diff.joined : [];
	// Players pick a faction after joining; rules that wait for it see the change here. A joiner
	// who arrives with one (a reconnect) counts as a first pick on the spot.
	const factioned = joinsTrusted
		? [
				...joined.filter((p) => p.faction).map((player) => ({ player, from: null })),
				...diff.factioned
			]
		: [];
	const rows = m.status ? await enabledTriggers(env, server.id) : [];
	const risk =
		joined.length && needsRiskInputs(rows)
			? await riskInputs(env, server, joined)
			: { signals: new Map(), profiles: new Map() };

	// Seed time: while a seeding rule is on and the server is at or under its threshold, everyone
	// still on earns the time since the previous look at the list (on the same terms as a join is
	// trusted: a recent look, so they were on throughout), held as pending. It banks the moment
	// the server is filled (the rule's line, else the limit the server reports) with the player
	// still on; leaving first forfeits it, so sitting on an empty server that never fills earns
	// nothing. In between, pending waits. A server that reports no limit never fills on its own.
	const seed = seedRule(rows);
	if (players && seed) {
		const fullAt = seed.fullAt ?? (m.status?.maxPlayers || Infinity);
		if (players.length >= fullAt)
			for (const { session } of diff.stayed) {
				session.seedMs += session.pendingSeedMs;
				session.pendingSeedMs = 0;
			}
		else if (players.length <= seed.lowAt && joinsTrusted)
			for (const { session } of diff.stayed)
				if (seed.untilFull) session.pendingSeedMs += gapMs;
				else session.seedMs += gapMs;
	}

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
	// Someone picking a faction already has a session row, so their first-visit answer is the one
	// remembered from when they joined.
	for (const { player: p } of diff.factioned)
		if (m.presence.open.get(p.steamId)?.firstVisit) firstVisit.add(p.steamId);
	const ev =
		m.status && rows.length
			? await evaluateTriggers(
					env,
					{
						server,
						status: m.status,
						players: m.players,
						joined,
						factioned,
						firstVisit,
						reserved: m.reserved,
						reservedLoaded: m.listsAt > 0,
						seedMs:
							seed === null
								? new Map()
								: new Map([...m.presence.open.values()].map((s) => [s.steamId, s.seedMs])),
						signals: risk.signals,
						profiles: risk.profiles,
						startedAt: m.startedAt,
						matchEnd,
						ts
					},
					rows
				)
			: { intents: [], updates: [] };
	// Memory follows every player observation; the database only when something is due.
	for (const { player: p, session: s } of diff.stayed) {
		s.name = p.name;
		s.faction = p.faction;
		if (p.faction) s.lastFaction = p.faction;
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
					await persistPresence(tx, server.id, m.presence, diff, ts, heartbeatDue, firstVisit);
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

	// Housekeeping, each part on its own, and only while this process still owns the worker. A
	// player the lists want banned here, seen on the list: banned now, not at the sync's retry.
	const seen = players?.map((p) => p.steamId) ?? [];
	if (isOwner() && seen.length && m.refusedBans.size)
		await stage('bans', m, () => banOnSight(env, server, m.org, client, seen, m.refusedBans));
	if (look)
		await stage('match', m, () =>
			withOwnedTransaction(env, (tx) => reconcileMatch(tx, m, ts, look, matchEnd))
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
	if (err instanceof GameError && err.code === 'rate_limited') {
		// Not an outage: the listener asked the panel to slow down. Hold the next look for as long
		// as it said, keep the tier and the failure count, show the message, and write only the
		// live row (no sample, no session closing).
		holdFor(m, err);
		m.error = publicMessage(err, 'Rate limited.').slice(0, 300);
		m.observedAt = started;
		try {
			await withOwnedTransaction(env, (tx) => writeLive(tx, m, ts));
			m.liveKey = liveKeyOf(m);
			m.liveWrittenAt = started;
		} catch (e) {
			if (e instanceof LostOwnership) throw e;
			console.warn(`[warcon] hold on ${m.server.name} not saved:`, publicMessage(e));
		}
		emit({ type: 'live', live: liveView(m) });
		return;
	}
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
				m.lastMatch = null;
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
			features: m.identity.features,
			reason: 'poll',
			waitMs: 0,
			client,
			observed,
			lane: 'held'
		});
		if (synced.observed) m.reserved = new Set(synced.observed.reserved);
		if (synced.refusedBans) m.refusedBans = new Map(synced.refusedBans.map((r) => [r.steamId, r]));
	}
}

async function reconcileMatch(
	db: DbOrTx,
	m: ServerMemory,
	ts: Date,
	look: MatchLook,
	ended: MatchEnd | null
): Promise<void> {
	const serverId = m.server.id;
	const [current] = await db
		.select({ id: matches.id, map: matches.map, peakPlayers: matches.peakPlayers })
		.from(matches)
		.where(and(eq(matches.serverId, serverId), isNull(matches.endedAt)))
		.orderBy(desc(matches.id))
		.limit(1);
	// A boundary seen in memory closes the open row. After a worker start there is no previous
	// look, so a row left open on another map is closed with the scores seen now, as before.
	const end =
		ended ??
		(current && current.map !== look.map
			? matchBoundary({ map: current.map ?? '', scores: look.scores, matchSeconds: null }, look)
			: null);
	if (current && end) {
		await db
			.update(matches)
			.set({ endedAt: ts, finalScores: end.scores, winner: end.winner })
			.where(eq(matches.id, current.id));
		// Freeze each present player's faction now, while it is still the one they played this
		// match with -- player_sessions.faction is overwritten on the very next poll, including
		// with the holding team ("White") once the next pick starts, and by then it is too late
		// to know what this match's result was for them.
		const rows = [...m.presence.open.values()]
			.filter((s) => s.faction)
			.map((s) => ({ matchId: current.id, steamId: s.steamId, faction: s.faction! }));
		if (rows.length) await db.insert(matchPlayers).values(rows).onConflictDoNothing();
	}
	if (!current || end) {
		const secs = look.matchSeconds;
		const startedAt = secs !== null ? new Date(ts.getTime() - secs * 1000) : ts;
		await db.insert(matches).values({
			serverId,
			startedAt,
			map: look.map,
			experiences: m.status!.experiences.join('+'),
			lighting: m.status!.lighting,
			peakPlayers: m.status!.playerCount
		});
	} else if (m.status!.playerCount > current.peakPlayers) {
		await db
			.update(matches)
			.set({ peakPlayers: m.status!.playerCount })
			.where(eq(matches.id, current.id));
	}
}
