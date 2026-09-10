// The worker's scheduler. A quarter-second beat launches whichever servers are due for a look,
// each on its own phase and its own cadence (observe.ts decides the tier: watched, busy, idle,
// unreachable), through the server's lane in dispatcher.ts so nothing else talks to that server
// at the same time. A global cap bounds how many observations run at once; servers that stopped
// answering can only take a share of it. One process does this: the one holding the worker
// lease (leadership.ts), renewed every few seconds and re-checked inside every write.
import { and, eq, gt, lt } from 'drizzle-orm';
import type { Env } from './env';
import type { OrgRow, ServerRow } from './access';
import { matches, organizations, playerSessions, samples, servers } from './db/schema';
import { expireEntries } from './lists-sync';
import { PRIORITY, dispatcherStats, withServer } from './dispatcher';
import {
	acquireOrRenew,
	isOwner,
	LostOwnership,
	ownershipStats,
	releaseOwnership
} from './leadership';
import { loadSettings, settings, settingsVersion } from './settings';
import { watchedCount } from './interest';
import { deliveryStats, outboxDepth, startDelivery, stopDelivery } from './outbox';
import {
	allMemory,
	cadenceOf,
	forgetMemory,
	forgetRemembered,
	memoryFor,
	memoryOf,
	observeServer,
	OFFLINE_AFTER_FAILURES,
	planNext,
	replan,
	type ServerMemory
} from './observe';
import { phaseOffset, pickDue } from './poller-schedule';
import { applyRetentionPolicy, rollupSamples } from './rollups';
import { liveView } from './live';
import type { LiveView } from '$lib/types';

const BEAT_MS = 250;
const RENEW_MS = 5000;
const ROSTER_MS = 5000;
const SETTINGS_MS = 10_000;
const EXPIRY_MS = 5000;
const PRUNE_MS = 3600_000;
/** Share of the concurrency budget that unreachable servers may hold at once. */
const OFFLINE_SHARE = 0.5;
/** An observation still running after this long is reported once and counted as stuck. */
const STUCK_AFTER_MS = 120_000;

declare global {
	// Survive Vite HMR re-evaluation in dev so we never run two loops or two renewal timers.
	var __warconPoller: ReturnType<typeof setInterval> | undefined;
	var __warconRenew: ReturnType<typeof setInterval> | undefined;
}

interface Scheduler {
	label: string;
	roster: ServerMemory[];
	rosterAt: number;
	renewAt: number;
	settingsAt: number;
	settingsSeen: number;
	expiryAt: number;
	pruneAt: number;
	active: number;
	activeOffline: number;
	beating: boolean;
	lastBeatAt: number;
	launched: number;
	renewTimer: ReturnType<typeof setInterval> | null;
	/** the ownership period we last prepared memory for (ownershipStats().since) */
	epoch: number;
}

let scheduler: Scheduler | null = null;
let envRef: Env | null = null;

export function startPoller(env: Env, label = 'worker'): void {
	envRef = env;
	if (globalThis.__warconPoller) clearInterval(globalThis.__warconPoller);
	if (globalThis.__warconRenew) clearInterval(globalThis.__warconRenew);
	scheduler = {
		label,
		roster: [],
		rosterAt: 0,
		renewAt: 0,
		settingsAt: 0,
		settingsSeen: settingsVersion(),
		expiryAt: 0,
		pruneAt: 0,
		active: 0,
		activeOffline: 0,
		beating: false,
		lastBeatAt: 0,
		launched: 0,
		renewTimer: null,
		epoch: 0
	};
	// Lease renewal runs on its own timer so a slow roster or settings read never delays it.
	scheduler.renewTimer = setInterval(
		() =>
			void acquireOrRenew(env, label).catch((err) => console.error('[warcon] worker lease', err)),
		RENEW_MS
	);
	globalThis.__warconRenew = scheduler.renewTimer;
	startDelivery(env);
	globalThis.__warconPoller = setInterval(() => void beat(env), BEAT_MS);
	console.log('[warcon] worker scheduler started');
}

/** Stops the beat and gives the lease up. Observations in flight finish on their own. */
export async function stopPoller(): Promise<void> {
	if (globalThis.__warconPoller) clearInterval(globalThis.__warconPoller);
	globalThis.__warconPoller = undefined;
	if (globalThis.__warconRenew) clearInterval(globalThis.__warconRenew);
	globalThis.__warconRenew = undefined;
	stopDelivery();
	scheduler = null;
	if (envRef) await releaseOwnership(envRef);
}

/** Look at this server as soon as its lane is free (a command was just sent, a list was edited). */
export function observeSoon(serverId: string): void {
	const m = memoryOf(serverId);
	if (!m) return;
	if (m.inFlight !== null) m.again = true;
	else {
		m.playersDueAt = Date.now();
		m.statusDueAt = Date.now();
	}
}

/**
 * Observes one server right now (through its lane, ahead of background work) and returns the
 * view: for a server that was just added, or a read that cannot wait for the schedule. Without
 * the lease this returns whatever is in memory.
 */
export async function observeNow(env: Env, serverId: string): Promise<LiveView | null> {
	let m = memoryOf(serverId);
	if (!m) {
		const [row] = await env.db
			.select({ server: servers, org: organizations })
			.from(servers)
			.innerJoin(organizations, eq(organizations.id, servers.orgId))
			.where(eq(servers.id, serverId))
			.limit(1);
		if (!row) return null;
		m = memoryFor(row.server, row.org);
		if (scheduler) scheduler.rosterAt = 0;
	}
	if (!isOwner()) return m.observedAt ? liveView(m) : null;
	const mem = m;
	await withServer(serverId, PRIORITY.command, () =>
		observeServer(env, mem, { status: true, players: true })
	).catch((err) => {
		if (!(err instanceof LostOwnership)) console.error(`[warcon] observe ${mem.server.name}`, err);
	});
	return mem.observedAt ? liveView(mem) : null;
}

async function beat(env: Env): Promise<void> {
	const s = scheduler;
	if (!s || s.beating) return;
	s.beating = true;
	try {
		const now = Date.now();
		s.lastBeatAt = now;
		if (!s.renewAt) {
			// The first acquisition; renewals then run on their own timer.
			s.renewAt = now;
			await acquireOrRenew(env, s.label).catch((err) =>
				console.error('[warcon] worker lease', err)
			);
		}
		if (!isOwner()) return;
		const period = ownershipStats().since;
		if (period !== s.epoch) {
			// A new ownership period: anything remembered may be stale against another worker's writes.
			s.epoch = period;
			forgetRemembered();
		}
		if (now - s.settingsAt >= SETTINGS_MS) {
			s.settingsAt = now;
			await loadSettings(env).catch((err) => console.error('[warcon] settings', err));
			if (settingsVersion() !== s.settingsSeen) {
				s.settingsSeen = settingsVersion();
				for (const m of allMemory()) if (m.inFlight === null) replan(m, now);
				console.log('[warcon] settings changed; cadences re-planned');
				void housekeep(env);
			}
		}
		if (now - s.rosterAt >= ROSTER_MS) await refreshRoster(env, s, now);
		launchDue(env, s, now);
	} catch (err) {
		console.error('[warcon] scheduler beat', err);
	} finally {
		s.beating = false;
	}
}

async function refreshRoster(env: Env, s: Scheduler, now: number): Promise<void> {
	s.rosterAt = now;
	let rows: { server: ServerRow; org: OrgRow }[];
	try {
		rows = await env.db
			.select({ server: servers, org: organizations })
			.from(servers)
			.innerJoin(organizations, eq(organizations.id, servers.orgId));
	} catch (err) {
		console.error('[warcon] roster', err);
		return;
	}
	const present = new Set<string>();
	s.roster = rows.map(({ server, org }) => {
		present.add(server.id);
		const m = memoryFor(server, org);
		if (!m.playersDueAt) {
			// New to us: spread first looks across the idle cadence so a restart is not a burst.
			const offset = phaseOffset(server.id, Math.min(settings().idleMs, 30_000));
			m.playersDueAt = now + offset;
			m.statusDueAt = now + offset;
		}
		return m;
	});
	for (const m of allMemory())
		if (!present.has(m.server.id) && m.inFlight === null) forgetMemory(m.server.id);
	if (now - s.expiryAt >= EXPIRY_MS) {
		s.expiryAt = now;
		const expired = await expireEntries(env).catch((err) => {
			console.error('[warcon] list expiry', err);
			return { lifted: 0, orgIds: [] as string[] };
		});
		// A lifted ban comes off the servers on their next look, not at the next scheduled sync.
		if (expired.lifted)
			for (const m of s.roster)
				if (expired.orgIds.includes(m.org.id)) {
					m.syncAt = 0;
					observeSoon(m.server.id);
				}
	}
	if (now - s.pruneAt >= PRUNE_MS) {
		s.pruneAt = now;
		void housekeep(env);
	}
}

function launchDue(env: Env, s: Scheduler, now: number): void {
	const slots = s.roster.map((m) => {
		if (m.inFlight !== null && now - m.inFlight > STUCK_AFTER_MS && !m.stuckReported) {
			m.stuckReported = true;
			console.warn(
				`[warcon] observation of ${m.server.name} has been running for ${Math.round((now - m.inFlight) / 1000)}s`
			);
		}
		return {
			id: m.server.id,
			m,
			dueAt: Math.min(m.playersDueAt, m.statusDueAt),
			inFlight: m.inFlight !== null,
			offline: m.failures >= OFFLINE_AFTER_FAILURES
		};
	});
	const picked = pickDue(slots, now, {
		total: settings().concurrency,
		active: s.active,
		offlineActive: s.activeOffline,
		offlineShare: OFFLINE_SHARE
	});
	for (const { m, offline } of picked) {
		const kinds = { status: m.statusDueAt <= now, players: m.playersDueAt <= now };
		planNext(m, now, kinds);
		m.inFlight = now;
		m.stuckReported = false;
		s.active++;
		s.launched++;
		if (offline) s.activeOffline++;
		withServer(m.server.id, PRIORITY.observe, () => observeServer(env, m, kinds))
			.catch((err) => {
				if (err instanceof LostOwnership) return;
				console.error(`[warcon] observe ${m.server.name}`, err);
			})
			.finally(() => {
				m.inFlight = null;
				s.active--;
				if (offline) s.activeOffline--;
				replan(m, Date.now());
			});
	}
}

/**
 * Hourly: rollups first, and only if they succeeded the prune and the retention policy, so raw
 * history is never dropped before its rollup exists.
 */
let housekeeping = false;
async function housekeep(env: Env): Promise<void> {
	if (housekeeping) return;
	housekeeping = true;
	try {
		await housekeepOnce(env);
	} finally {
		housekeeping = false;
	}
}

async function housekeepOnce(env: Env): Promise<void> {
	try {
		await rollupSamples(env);
	} catch (err) {
		console.error('[warcon] rollups failed; keeping raw samples until they succeed', err);
		return;
	}
	await prune(env).catch((err) => console.error('[warcon] prune', err));
	await applyRetentionPolicy(env).catch((err) => console.error('[warcon] retention', err));
}

async function prune(env: Env): Promise<void> {
	const s = settings();
	const cutSessions = new Date(Date.now() - s.sessionRetentionDays * 86400000);
	// TimescaleDB's retention policy drops old sample chunks; plain Postgres needs this delete.
	if (!env.timescale)
		await env.db
			.delete(samples)
			.where(lt(samples.ts, new Date(Date.now() - s.rawRetentionDays * 86400000)));
	await env.db
		.delete(playerSessions)
		.where(and(lt(playerSessions.leftAt, cutSessions), gt(playerSessions.id, 0)));
	await env.db.delete(matches).where(lt(matches.endedAt, cutSessions));
}

// ---- stats --------------------------------------------------------------------------------------

export interface PollerStats {
	enabled: boolean;
	owner: boolean;
	servers: number;
	tiers: Record<'watched' | 'hot' | 'idle' | 'offline', number>;
	cadence: Record<'watched' | 'hot' | 'idle', { players: number; status: number }>;
	concurrency: number;
	active: number;
	/** servers overdue by more than their own cadence: the worker is not keeping up */
	behind: number;
	stuck: number;
	launched: number;
	beatAgoMs: number | null;
	lanes: { busy: number; queued: number };
	delivery: ReturnType<typeof deliveryStats> & { pending: number; oldestMs: number | null };
	settingsVersion: number;
	ownership: ReturnType<typeof ownershipStats>;
}

export async function pollerStats(): Promise<PollerStats> {
	const s = scheduler;
	const now = Date.now();
	const tiers = { watched: 0, hot: 0, idle: 0, offline: 0 };
	let behind = 0;
	let stuck = 0;
	if (s)
		for (const m of s.roster) {
			tiers[m.tier]++;
			const due = Math.min(m.playersDueAt, m.statusDueAt);
			const c = cadenceOf(m.tier, m.failures);
			if (m.inFlight === null && due > 0 && now - due > Math.min(c.players, c.status)) behind++;
			if (m.inFlight !== null && now - m.inFlight > STUCK_AFTER_MS) stuck++;
		}
	const set = settings();
	const depth =
		envRef && isOwner()
			? await outboxDepth(envRef).catch(() => ({ pending: 0, oldestMs: null }))
			: { pending: 0, oldestMs: null };
	return {
		enabled: !!s,
		owner: isOwner(),
		servers: s?.roster.length ?? 0,
		tiers,
		cadence: {
			watched: { players: set.watchedPlayersMs, status: set.watchedStatusMs },
			hot: { players: set.hotPlayersMs, status: set.hotStatusMs },
			idle: { players: set.idleMs, status: set.idleMs }
		},
		concurrency: set.concurrency,
		active: s?.active ?? 0,
		behind,
		stuck,
		launched: s?.launched ?? 0,
		beatAgoMs: s?.lastBeatAt ? now - s.lastBeatAt : null,
		lanes: dispatcherStats(),
		delivery: { ...deliveryStats(), ...depth },
		settingsVersion: settingsVersion(),
		ownership: ownershipStats()
	};
}

export const watchedServers = watchedCount;
