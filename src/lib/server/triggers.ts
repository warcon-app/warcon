// Automation: per-server triggers the worker evaluates on every observation, all
// built on what the worker already sees (joins, player counts, empty stretches) plus the Steam cache:
//   welcome      whisper a message to players as they join (or once they have picked a faction)
//   faction_change  whisper a message to players who switch from one faction to another
//   broadcast    rotate through messages every N minutes while the player count is in its band
//   empty_reset  send an empty server back to a chosen map after N minutes
//   risk_kick    kick joiners who match Steam / ban-list rules (see risk.ts)
//   ping_kick    kick players whose ping stays above a limit
//   team_kill    whisper or kick a player over team kills the kill feed reports (feed-events.ts)
//   kill_rate    flag a player whose kills in a short window are too many or too many headshots
//                (kill-rate.ts, acted on in feed-events.ts)
//   seed_reward  hand players who stay through a low population a reserved slot, on this server
//                or across the org
// The worker evaluates them on every observation and writes the actions they want to the outbox
// (outbox.ts delivers, and every delivery lands in the audit trail as category "trigger"). A dry
// run replays the last 24 hours from the samples and sessions tables so a rule can be checked
// before it touches anyone.
import { and, asc, desc, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, int, newId, str } from './http';
import { writeAudit } from './audit';
import {
	kills,
	playerSessions,
	samples,
	serverLive,
	servers,
	triggers,
	type ServerRow,
	type SteamProfileRow,
	type TriggerRow
} from './db/schema';
import { getProfiles, steamEnabled } from './steam';
import { localSignals, orgServers, type LocalSignals } from './players';
import { gateway } from './gateway';
import type { SessionUser } from './access';
import type { ServerAccess } from './access-resolve';
import { CAPABILITY_INFO, type Capability } from '$lib/capabilities';
import type { DryRunResult, Player, Status, TriggerKind, TriggerView } from '$lib/types';
import {
	broadcastWanted,
	factionChangeTargets,
	isTriggerKind,
	onTarget,
	renderTemplate,
	restartNoticeStage,
	riskKickVerdict,
	pingKickStep,
	teamKillStage,
	TRIGGER_LABELS,
	validateConfig,
	welcomeTargets,
	type BroadcastConfig,
	type EmptyResetConfig,
	type FactionChangeConfig,
	type FactionPick,
	type RestartNoticeConfig,
	type RestartNoticeState,
	fullMoments,
	lowStretches,
	matchBroadcastMessages,
	matchBroadcastStep,
	type HeldMatchEnd,
	type MatchLineVars,
	matchReplay,
	seedReplay,
	type MatchBroadcastConfig,
	type MatchEnd,
	riskKickScore,
	type RiskKickConfig,
	type PingKickConfig,
	type PingKickState,
	type SeedRewardConfig,
	type TeamKillConfig,
	type WelcomeConfig
} from './trigger-rules';
import { NAME_FLAG, nameFilterTargets, nameVerdict, type NameFilterConfig } from './name-filter';
import {
	countsForRate,
	killRateReplay,
	killTimes,
	type KillRateConfig,
	type RateKill
} from './kill-rate';
import { fmtUptime, RESTART_AFTER_HOURS, restartWindow } from '$lib/uptime';
import { DEFAULT_SCORE_CAP, scoreCapOf } from '$lib/match';
import { settings } from './settings';
import { riskPerformanceFor } from './leaderboards';
import type { RiskPerformance } from './risk';
import { seedProgress } from './seed-progress';

export * from './trigger-rules';

const WINDOW_MS = 24 * 3600_000;
/** The most kills one Kill rate dry run reads, whatever the server did that day. */
const KILL_RATE_REPLAY_MAX = 200_000;

// ---- records ------------------------------------------------------------------------------------

const shape = (t: TriggerRow): TriggerView => ({
	id: t.id,
	kind: t.kind,
	name: t.name,
	enabled: t.enabled,
	config: t.config as Record<string, unknown>,
	lastFiredAt: t.lastFiredAt ? t.lastFiredAt.toISOString() : null,
	lastResult: t.lastResult,
	fireCount: t.fireCount,
	createdAt: t.createdAt ? t.createdAt.toISOString() : null
});

export async function listTriggers(env: Env, serverId: string): Promise<TriggerView[]> {
	const rows = await env.db
		.select()
		.from(triggers)
		.where(eq(triggers.serverId, serverId))
		.orderBy(asc(triggers.createdAt));
	return rows.map(shape);
}

async function triggerOf(env: Env, serverId: string, id: string): Promise<TriggerRow> {
	const [row] = await env.db
		.select()
		.from(triggers)
		.where(and(eq(triggers.id, id), eq(triggers.serverId, serverId)))
		.limit(1);
	if (!row) throw new ApiError(404, 'Trigger not found.');
	return row;
}

/**
 * A rule acts without anyone at the controls, so saving it needs the capability its author would
 * need to do the same by hand: a rule that kicks needs Kick players, not only Automation.
 */
const RULE_NEEDS: Record<Exclude<TriggerKind, 'seed_reward'>, [Capability, string]> = {
	welcome: ['chat.send', 'messages players'],
	faction_change: ['chat.send', 'messages players'],
	broadcast: ['chat.send', 'messages players'],
	restart_notice: ['chat.send', 'messages players'],
	match_broadcast: ['chat.send', 'messages players'],
	empty_reset: ['match.control', 'changes the map'],
	risk_kick: ['players.moderate', 'kicks players'],
	name_filter: ['players.moderate', 'kicks players'],
	ping_kick: ['players.moderate', 'kicks players'],
	team_kill: ['players.moderate', 'kicks players'],
	kill_rate: ['players.moderate', 'flags players']
};

/** What one rule needs of whoever saves it. The Seeding reward reserves slots: here, or on the organisation's list. */
export function ruleNeeds(kind: TriggerKind, config: unknown): [Capability, string] {
	if (kind !== 'seed_reward') return RULE_NEEDS[kind];
	return (config as Partial<SeedRewardConfig> | null)?.scope !== 'server'
		? ['lists.reserve', "edits the organisation's reserved-slot list"]
		: ['slots.manage', 'reserves slots on this server'];
}

export function requireRuleCaps(
	kind: TriggerKind,
	config: unknown,
	server: ServerRow,
	access: ServerAccess
): void {
	const [cap, does] = ruleNeeds(kind, config);
	if (access.caps.has(cap)) return;
	throw new ApiError(
		403,
		`A ${TRIGGER_LABELS[kind]} rule ${does}, which needs '${CAPABILITY_INFO[cap].label}' on ${server.name}; your role '${access.roleName}' does not include it.`,
		'forbidden'
	);
}

export async function createTrigger(
	env: Env,
	req: Request,
	user: SessionUser,
	server: ServerRow,
	access: ServerAccess,
	body: Record<string, unknown>
): Promise<TriggerView> {
	if (!isTriggerKind(body.kind)) throw new ApiError(400, 'Unknown trigger kind.');
	const kind = body.kind;
	const config = validateConfig(kind, body.config);
	requireRuleCaps(kind, config, server, access);
	const name = str(body.name, 60) || TRIGGER_LABELS[kind];
	// Seed time is one count per server, taken against one threshold, so one rule holds it.
	if (kind === 'seed_reward') {
		const [other] = await env.db
			.select({ name: triggers.name })
			.from(triggers)
			.where(and(eq(triggers.serverId, server.id), eq(triggers.kind, 'seed_reward')))
			.limit(1);
		if (other)
			throw new ApiError(
				409,
				`This server already has a ${TRIGGER_LABELS[kind]} rule ("${other.name}"); edit that one instead.`,
				'duplicate'
			);
	}
	const [row] = await env.db
		.insert(triggers)
		.values({
			id: newId(),
			serverId: server.id,
			orgId: server.orgId,
			kind,
			name,
			enabled: !!body.enabled,
			config,
			createdBy: user.id
		})
		.returning();
	gateway().triggersChanged(server.id);
	await writeAudit(env, req, {
		actor: user,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: 'trigger.create',
		target: name,
		outcome: 'ok',
		detail: { triggerId: row.id, kind, enabled: row.enabled, config }
	});
	return shape(row);
}

export async function updateTrigger(
	env: Env,
	req: Request,
	user: SessionUser,
	server: ServerRow,
	access: ServerAccess,
	id: string,
	body: Record<string, unknown>
): Promise<TriggerView> {
	const row = await triggerOf(env, server.id, id);
	const set: Partial<typeof triggers.$inferInsert> = {};
	if (body.name !== undefined) set.name = str(body.name, 60) || row.name;
	if (body.enabled !== undefined) set.enabled = !!body.enabled;
	if (body.config !== undefined) set.config = validateConfig(row.kind, body.config);
	if (row.kind === 'ping_kick' && (body.config !== undefined || body.enabled !== undefined))
		set.state = null;
	requireRuleCaps(row.kind, set.config ?? row.config, server, access);
	if (!Object.keys(set).length) throw new ApiError(400, 'Nothing to update.');
	set.updatedAt = new Date();
	const [updated] = await env.db
		.update(triggers)
		.set(set)
		.where(eq(triggers.id, row.id))
		.returning();
	gateway().triggersChanged(server.id);
	await writeAudit(env, req, {
		actor: user,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: 'trigger.update',
		target: updated.name,
		outcome: 'ok',
		detail: { triggerId: row.id, kind: row.kind, ...set }
	});
	return shape(updated);
}

export async function deleteTrigger(
	env: Env,
	req: Request,
	user: SessionUser,
	server: ServerRow,
	id: string
): Promise<void> {
	const row = await triggerOf(env, server.id, id);
	await env.db.delete(triggers).where(eq(triggers.id, row.id));
	gateway().triggersChanged(server.id);
	await writeAudit(env, req, {
		actor: user,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'server',
		action: 'trigger.delete',
		target: row.name,
		outcome: 'ok',
		detail: { triggerId: row.id, kind: row.kind }
	});
}

// ---- evaluation -----------------------------------------------------------------------------------
// The worker evaluates every enabled trigger against each observation and gets back *intents*:
// actions to take, written to the outbox in the same transaction as the observation (outbox.ts
// delivers them). Evaluation itself makes no game request.

export interface TickContext {
	server: ServerRow;
	status: Status;
	players: Player[];
	/** true only when this observation fetched a fresh player list */
	playersObserved: boolean;
	playersIntervalMs: number;
	/** players with no open session before this observation (empty when joins are not trusted) */
	joined: Player[];
	/** players still on under a name their session did not hold at the last look */
	renamed: Player[];
	/** players back on the list after missing the previous look, inside the leave grace (their
	 *  session goes on, but it may be a reconnect) */
	returned: Player[];
	/** the players a risk kick rule judges at this look: joiners, returned players, and everyone
	 *  on when the sweep is due (empty when no risk rule is on) */
	riskCheck: Player[];
	/** players whose faction is new since the last look (joiners arriving with one included;
	 *  empty when joins are not trusted) */
	factioned: FactionPick<Player>[];
	/** joiners and factioned players never seen on this server before */
	firstVisit: Set<string>;
	/** SteamIDs with a reserved slot */
	reserved: Set<string>;
	/** false until the worker has read the server's reserved list since it started */
	reservedLoaded: boolean;
	/** seed time so far of the open sessions, by SteamID (empty while no seeding rule is on) */
	seedMs: Map<string, number>;
	/** pre-fetched for risk rules: the panel's own signals and Steam profiles of riskCheck */
	signals: Map<string, LocalSignals>;
	profiles: Map<string, SteamProfileRow>;
	performance: Map<string, RiskPerformance>;
	/** when the game process started (ms), from GET /v1/health; 0 while unknown */
	startedAt: number;
	/** the match that ended between the previous look and this one, or null */
	matchEnd: MatchEnd | null;
	/** at a boundary, every player's line of the match that ended, from the worker's tallies */
	matchLines: MatchLineVars[];
	ts: Date;
}

/** One action a rule wants taken; becomes an outbox row. */
export interface Intent {
	trigger: TriggerRow;
	/** a registry action, or "empty_reset" (rotation-aware map reset, resolved at delivery) */
	action: string;
	params: Record<string, unknown>;
	target: string;
	okMessage: string;
	detail: Record<string, unknown>;
	/** only meaningful while this player is on; delivery skips it otherwise */
	steamId: string | null;
	dedupeKey: string;
}

export interface TriggerUpdate {
	id: string;
	lastFiredAt?: Date;
	lastResult?: string;
	state?: unknown;
}

export interface Evaluation {
	intents: Intent[];
	updates: TriggerUpdate[];
	/** worker memory a rule moves on only once the intents and updates are committed */
	afterCommit?: (() => void)[];
}

const vars = (ctx: TickContext, p?: Player, previous = '') => ({
	name: p?.name ?? '',
	faction: p?.faction ?? '',
	previous,
	server: ctx.status.serverName || ctx.server.name,
	map: ctx.status.map,
	players: ctx.status.playerCount,
	max: ctx.status.maxPlayers,
	cap: scoreCapOf(ctx.status)
});

// Enabled triggers per server, cached briefly: the worker asks on every observation.
const ENABLED_TTL_MS = 10_000;
const enabledCache = new Map<string, { until: number; rows: TriggerRow[] }>();

export function invalidateTriggers(serverId?: string): void {
	if (serverId) enabledCache.delete(serverId);
	else enabledCache.clear();
}

export async function enabledTriggers(env: Env, serverId: string): Promise<TriggerRow[]> {
	const hit = enabledCache.get(serverId);
	const now = Date.now();
	if (hit && hit.until > now) return hit.rows;
	const rows = await env.db
		.select()
		.from(triggers)
		.where(and(eq(triggers.serverId, serverId), eq(triggers.enabled, true)));
	enabledCache.set(serverId, { until: now + ENABLED_TTL_MS, rows });
	if (enabledCache.size > 5000)
		for (const [k, v] of enabledCache) if (v.until <= now) enabledCache.delete(k);
	return rows;
}

/** How often everyone on the server is judged again by the risk kick rules. */
export const RISK_RECHECK_MS = 60_000;
/** A player a risk kick was asked for and who is still on is judged again by a sweep only after
 *  this long (a kick that did not land is not repeated, audited and posted every minute). */
export const RISK_REKICK_MS = 5 * 60_000;

/** True when an enabled risk kick rule spares reserved slots. */
export const riskSparesReserved = (rows: TriggerRow[]): boolean =>
	rows.some((r) => r.kind === 'risk_kick' && (r.config as RiskKickConfig).spareReserved);

/**
 * Who a risk kick rule judges at this look: every joiner, every player back after missing a
 * look (a reconnect inside the leave grace keeps its session), and, when a sweep is due (every
 * RISK_RECHECK_MS, in one batch), everyone else still on.
 */
export function riskCheckTargets<P extends { steamId: string }>(
	joined: P[],
	returned: P[],
	stayed: P[],
	sweep: boolean
): P[] {
	const out = new Map<string, P>();
	for (const p of [...joined, ...returned, ...(sweep ? stayed : [])])
		if (!out.has(p.steamId)) out.set(p.steamId, p);
	return [...out.values()];
}

/** True when any enabled rule needs the risk inputs (so the worker only fetches them then). */
export const needsRiskInputs = (rows: TriggerRow[]): boolean =>
	rows.some((r) => r.kind === 'risk_kick');

/** True when a rule kicks at a risk score, the only thing the recorded games feed. */
export const needsRiskPerformance = (rows: TriggerRow[]): boolean =>
	rows.some((r) => r.kind === 'risk_kick' && !!riskKickScore(r.config as RiskKickConfig));

/** Evaluates the rules against one observation. Never throws; a broken rule records its error. */
export async function evaluateTriggers(
	env: Env,
	ctx: TickContext,
	rows: TriggerRow[]
): Promise<Evaluation> {
	const out: Evaluation = { intents: [], updates: [] };
	for (const row of rows) {
		try {
			switch (row.kind) {
				case 'welcome':
					evalWelcome(ctx, row, row.config as WelcomeConfig, out);
					break;
				case 'faction_change':
					evalFactionChange(ctx, row, row.config as FactionChangeConfig, out);
					break;
				case 'broadcast':
					evalBroadcast(ctx, row, row.config as BroadcastConfig, out);
					break;
				case 'empty_reset':
					await evalEmptyReset(env, ctx, row, row.config as EmptyResetConfig, out);
					break;
				case 'risk_kick':
					evalRiskKick(env, ctx, row, row.config as RiskKickConfig, out);
					break;
				case 'ping_kick':
					evalPingKick(ctx, row, row.config as PingKickConfig, out);
					break;
				case 'restart_notice':
					evalRestartNotice(ctx, row, row.config as RestartNoticeConfig, out);
					break;
				case 'team_kill':
				case 'kill_rate':
					// Acted on as kills arrive (feed-events.ts), not per observation.
					break;
				case 'seed_reward':
					await evalSeedReward(env, ctx, row, row.config as SeedRewardConfig, out);
					break;
				case 'match_broadcast':
					evalMatchBroadcast(ctx, row, row.config as MatchBroadcastConfig, out);
					break;
				case 'name_filter':
					evalNameFilter(ctx, row, row.config as NameFilterConfig, out);
					break;
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.error(`[warcon] trigger ${row.name}`, message);
			out.updates.push({ id: row.id, lastResult: `Error: ${message}`.slice(0, 300) });
		}
	}
	return out;
}

const key = (row: TriggerRow, ...parts: (string | number)[]) => [row.id, ...parts].join(':');

function evalWelcome(ctx: TickContext, row: TriggerRow, cfg: WelcomeConfig, out: Evaluation) {
	let n = 0;
	let last = '';
	for (const p of welcomeTargets(cfg, ctx)) {
		const message = renderTemplate(cfg.message, vars(ctx, p));
		out.intents.push({
			trigger: row,
			action: 'whisper',
			params: { steamId: p.steamId, message },
			target: p.steamId,
			okMessage: `Whispered ${p.name}.`,
			detail: { name: p.name },
			steamId: p.steamId,
			dedupeKey: key(row, p.steamId, ctx.ts.getTime())
		});
		n++;
		last = p.name;
	}
	if (n)
		out.updates.push({
			id: row.id,
			lastFiredAt: ctx.ts,
			lastResult: `Whispering ${n === 1 ? last : `${n} players`}`
		});
}

function evalFactionChange(
	ctx: TickContext,
	row: TriggerRow,
	cfg: FactionChangeConfig,
	out: Evaluation
) {
	let n = 0;
	let last = '';
	for (const { player: p, from } of factionChangeTargets(ctx)) {
		const message = renderTemplate(cfg.message, vars(ctx, p, from ?? ''));
		out.intents.push({
			trigger: row,
			action: 'whisper',
			params: { steamId: p.steamId, message },
			target: p.steamId,
			okMessage: `Whispered ${p.name} (${from} → ${p.faction}).`,
			detail: { name: p.name, from, to: p.faction },
			steamId: p.steamId,
			dedupeKey: key(row, p.steamId, ctx.ts.getTime())
		});
		n++;
		last = p.name;
	}
	if (n)
		out.updates.push({
			id: row.id,
			lastFiredAt: ctx.ts,
			lastResult: `Whispering ${n === 1 ? last : `${n} players`}`
		});
}

function evalBroadcast(ctx: TickContext, row: TriggerRow, cfg: BroadcastConfig, out: Evaluation) {
	if (!broadcastWanted(cfg, ctx.status.playerCount)) return;
	const due =
		!row.lastFiredAt || ctx.ts.getTime() - row.lastFiredAt.getTime() >= cfg.everyMinutes * 60_000;
	if (!due) return;
	const state = (row.state as { index?: number } | null) ?? {};
	const index = (state.index ?? 0) % cfg.messages.length;
	const message = renderTemplate(cfg.messages[index], vars(ctx));
	out.intents.push({
		trigger: row,
		action: 'broadcast',
		params: { message },
		target: message,
		okMessage: 'Broadcast sent.',
		detail: { index },
		steamId: null,
		dedupeKey: key(row, ctx.ts.getTime())
	});
	// The row moves on now so the cadence holds even if delivery lags; the result lands later.
	row.lastFiredAt = ctx.ts;
	row.state = { index: index + 1 };
	out.updates.push({
		id: row.id,
		lastFiredAt: ctx.ts,
		lastResult: `Sending: ${message}`,
		state: { index: index + 1 }
	});
}

async function evalEmptyReset(
	env: Env,
	ctx: TickContext,
	row: TriggerRow,
	cfg: EmptyResetConfig,
	out: Evaluation
) {
	if (ctx.status.playerCount > 0 || ctx.players.length > 0) return;
	if (onTarget(cfg, ctx.status)) return;
	if (
		row.lastFiredAt &&
		ctx.ts.getTime() - row.lastFiredAt.getTime() < cfg.cooldownMinutes * 60_000
	)
		return;
	// Empty since the last sample that was unreachable or had someone on.
	const [busy] = await env.db
		.select({ ts: samples.ts })
		.from(samples)
		.where(
			and(
				eq(samples.serverId, ctx.server.id),
				or(eq(samples.ok, false), sql`${samples.playerCount} > 0`)
			)
		)
		.orderBy(desc(samples.ts))
		.limit(1);
	const [oldest] = busy
		? []
		: await env.db
				.select({ ts: samples.ts })
				.from(samples)
				.where(eq(samples.serverId, ctx.server.id))
				.orderBy(asc(samples.ts))
				.limit(1);
	const since = busy?.ts ?? oldest?.ts;
	if (!since || ctx.ts.getTime() - since.getTime() < cfg.afterMinutes * 60_000) return;
	out.intents.push({
		trigger: row,
		action: 'empty_reset',
		params: {
			map: cfg.map,
			experiences: cfg.experiences,
			lighting: cfg.lighting || undefined,
			zoneAlternator: cfg.zoneAlternator || undefined
		},
		target: cfg.map,
		okMessage: `Reset to ${cfg.map}.`,
		detail: { emptyMinutes: Math.round((ctx.ts.getTime() - since.getTime()) / 60_000) },
		steamId: null,
		dedupeKey: key(row, ctx.ts.getTime())
	});
	row.lastFiredAt = ctx.ts;
	out.updates.push({ id: row.id, lastFiredAt: ctx.ts, lastResult: `Resetting to ${cfg.map}` });
}

function evalRiskKick(
	env: Env,
	ctx: TickContext,
	row: TriggerRow,
	cfg: RiskKickConfig,
	out: Evaluation
) {
	if (!ctx.riskCheck.length) return;
	let n = 0;
	let last = '';
	for (const p of ctx.riskCheck) {
		const l = ctx.signals.get(p.steamId);
		const verdict = riskKickVerdict(cfg, {
			profile: ctx.profiles.get(p.steamId) ?? null,
			steamEnabled: steamEnabled(env),
			bannedOn: l?.bannedOn ?? [],
			watched: l?.watched ?? null,
			resembles: l?.resembles ?? [],
			reserved: ctx.reserved.has(p.steamId),
			performance: ctx.performance.get(p.steamId),
			now: ctx.ts
		});
		if (!verdict) continue;
		out.intents.push({
			trigger: row,
			action: 'kick',
			params: { steamId: p.steamId, reason: cfg.reason },
			target: p.steamId,
			okMessage: `Kicked ${p.name}: ${verdict}`,
			detail: { name: p.name, verdict },
			steamId: p.steamId,
			dedupeKey: key(row, p.steamId, ctx.ts.getTime())
		});
		n++;
		last = `${p.name}: ${verdict}`;
	}
	if (n)
		out.updates.push({
			id: row.id,
			lastFiredAt: ctx.ts,
			lastResult: n === 1 ? `Kicking ${last}` : `Kicking ${n} players`
		});
}

function evalNameFilter(ctx: TickContext, row: TriggerRow, cfg: NameFilterConfig, out: Evaluation) {
	// A name is judged when it is first seen, at the join or later: the clan tag is part of the
	// name, and the game may only show it once the player is in. A kick rule also judges a player
	// back after missing a look: a kicked player reconnecting inside the leave grace is no join.
	// A flag rule does not (the whole server is back after every map change: no new alerts).
	const back = cfg.action === 'kick' ? ctx.returned : [];
	if (!ctx.joined.length && !ctx.renamed.length && !back.length) return;
	const named = [
		...new Map([...ctx.joined, ...ctx.renamed, ...back].map((p) => [p.steamId, p])).values()
	];
	let n = 0;
	let last = '';
	for (const { player: p, verdict: v } of nameFilterTargets(cfg, named, ctx.reserved)) {
		const kick = cfg.action === 'kick';
		out.intents.push({
			trigger: row,
			action: kick ? 'kick' : NAME_FLAG,
			params: kick
				? {
						steamId: p.steamId,
						reason: renderTemplate(cfg.reason, { ...vars(ctx, p), why: v.why })
					}
				: {},
			target: p.steamId,
			okMessage: `${kick ? 'Kicked' : 'Flagged'} ${p.name}: ${v.verdict}`,
			detail: { name: p.name, verdict: v.verdict },
			steamId: p.steamId,
			dedupeKey: key(row, p.steamId, ctx.ts.getTime())
		});
		n++;
		last = `${p.name}: ${v.verdict}`;
	}
	if (n) {
		const doing = cfg.action === 'kick' ? 'Kicking' : 'Flagging';
		out.updates.push({
			id: row.id,
			lastFiredAt: ctx.ts,
			lastResult: n === 1 ? `${doing} ${last}` : `${doing} ${n} players`
		});
	}
}

function evalPingKick(ctx: TickContext, row: TriggerRow, cfg: PingKickConfig, out: Evaluation) {
	if (!ctx.playersObserved) return;
	const previous = row.state as PingKickState | null;
	const { state, kicks } = pingKickStep(
		cfg,
		previous,
		ctx.players,
		ctx.ts.getTime(),
		2 * Math.max(ctx.playersIntervalMs, 1000) + 1000
	);
	// The state is written with any intents, and kept in the cached row for the next poll.
	row.state = state;
	if (
		Object.keys(state.players).length ||
		Object.keys(previous?.players ?? {}).length ||
		kicks.length
	)
		out.updates.push({ id: row.id, state });
	const kicked = new Set(kicks);
	for (const p of ctx.players) {
		if (!kicked.has(p.steamId)) continue;
		const steamId = p.steamId;
		const verdict = `ping ${p.ping} ms above ${cfg.maxPingMs} ms for ${cfg.durationSeconds} s`;
		out.intents.push({
			trigger: row,
			action: 'kick',
			params: { steamId, reason: cfg.reason },
			target: steamId,
			okMessage: `Kicked ${p.name}: ${verdict}`,
			detail: { name: p.name, pingMs: p.ping, verdict },
			steamId,
			dedupeKey: key(row, steamId, state.players[steamId].since)
		});
	}
	if (kicks.length)
		out.updates[out.updates.length - 1] = {
			id: row.id,
			state,
			lastFiredAt: ctx.ts,
			lastResult:
				kicks.length === 1
					? `Kicking ${ctx.players.find((p) => p.steamId === kicks[0])?.name}: high ping`
					: `Kicking ${kicks.length} players: high ping`
		};
}

function evalRestartNotice(
	ctx: TickContext,
	row: TriggerRow,
	cfg: RestartNoticeConfig,
	out: Evaluation
) {
	const hit = restartNoticeStage(cfg, row.state as RestartNoticeState | null, {
		startedAt: ctx.startedAt,
		playerCount: ctx.status.playerCount,
		now: ctx.ts.getTime()
	});
	if (!hit) return;
	const message = renderTemplate(hit.stage === 'lead' ? cfg.leadMessage : cfg.message, {
		...vars(ctx),
		minutes: hit.minutes,
		uptime: fmtUptime(ctx.ts.getTime() - ctx.startedAt)
	});
	out.intents.push({
		trigger: row,
		action: 'broadcast',
		params: { message },
		target: message,
		okMessage: 'Broadcast sent.',
		detail: { stage: hit.stage, startedAt: new Date(ctx.startedAt).toISOString() },
		steamId: null,
		dedupeKey: key(row, hit.stage, hit.state.startedAt, hit.stage === 'due' ? ctx.ts.getTime() : 0)
	});
	// The stage is marked now so a slow delivery cannot send it twice.
	row.lastFiredAt = ctx.ts;
	row.state = hit.state;
	out.updates.push({
		id: row.id,
		lastFiredAt: ctx.ts,
		lastResult: `Sending: ${message}`,
		state: hit.state
	});
}

// A match boundary is one tick, so the rule keeps no state: the end message then the start
// message, each an outbox row keyed on the tick.
// A match end the rule is holding until the server has its players on again, per rule (in memory
// only: a worker start in the three minutes loses it).
const matchHeld = new Map<string, HeldMatchEnd>();

/** Forgets what the rules keep in worker memory: another process may have acted meanwhile. */
export function forgetRuleMemory(): void {
	matchHeld.clear();
	seedState.clear();
}

function evalMatchBroadcast(
	ctx: TickContext,
	row: TriggerRow,
	cfg: MatchBroadcastConfig,
	out: Evaluation
) {
	const step = matchBroadcastStep(
		matchHeld.get(row.id) ?? null,
		ctx.matchEnd,
		ctx.matchLines,
		ctx.status.playerCount,
		ctx.ts.getTime(),
		cfg.minPlayers
	);
	// Holding an end sends nothing, so it is kept at once (a failed write on the boundary look
	// must not lose it); letting go waits for the commit, so a failed write announces it again.
	if (step.held) matchHeld.set(row.id, step.held);
	else (out.afterCommit ??= []).push(() => matchHeld.delete(row.id));
	if (!step.fire) return;
	const end = step.fire.end;
	const sends = matchBroadcastMessages(
		cfg,
		end,
		ctx.status.playerCount,
		vars(ctx),
		step.fire.lines
	);
	if (!sends.length) return;
	for (const { stage, message } of sends)
		out.intents.push({
			trigger: row,
			action: 'broadcast',
			params: { message },
			target: message,
			okMessage: 'Broadcast sent.',
			detail: {
				stage,
				map: end.map,
				winner: end.winner,
				scores: end.scores
			},
			steamId: null,
			dedupeKey: key(row, stage, ctx.ts.getTime())
		});
	row.lastFiredAt = ctx.ts;
	out.updates.push({
		id: row.id,
		lastFiredAt: ctx.ts,
		lastResult: `Sending: ${sends.map((s) => s.message).join(' / ')}`.slice(0, 300)
	});
}

// A seeding rule adds up seed time once a minute per server while the server is low, not per
// observation. Historical session totals stay intact; the trigger state keeps each player's
// unspent reward balance and resets that balance when it queues a grant.
const SEED_CHECK_MS = 60_000;
const seedState = new Map<string, { checkedAt: number; low: boolean; full: boolean }>();

const dateOf = (d: Date) => d.toISOString().slice(0, 10);

async function evalSeedReward(
	env: Env,
	ctx: TickContext,
	row: TriggerRow,
	cfg: SeedRewardConfig,
	out: Evaluation
) {
	// Not before the reserved list is known: a player reserved on this server alone must not be
	// handed an org-wide entry because the worker has not read the list yet.
	if (!ctx.reservedLoaded) return;
	const now = ctx.ts.getTime();
	const state = seedState.get(row.id) ?? { checkedAt: 0, low: false, full: false };
	const low = ctx.players.length <= cfg.lowAt;
	const full = ctx.players.length >= (cfg.fullAt ?? (ctx.status.maxPlayers || Infinity));
	// Every minute while low (returning players may already hold enough banked time); once when
	// the seed time banks, which is the moment the server fills, or, when every low minute
	// counts, as the count climbs out of the band; and not at all otherwise.
	const due = low
		? now - state.checkedAt >= SEED_CHECK_MS
		: cfg.untilFull
			? full && !state.full
			: state.low;
	state.checkedAt = due ? now : state.checkedAt;
	state.low = low;
	state.full = full;
	seedState.set(row.id, state);
	if (!due) return;
	const from = new Date(now - cfg.windowDays * 86400_000);
	const progress = seedProgress(row.state);
	for (const [steamId, p] of Object.entries(progress.players))
		if (p.seenAt < from.getTime()) delete progress.players[steamId];
	if (!ctx.players.length) {
		row.state = progress;
		out.updates.push({ id: row.id, state: progress });
		return;
	}
	const closed = await env.db
		.select({
			steamId: playerSessions.steamId,
			windowSeconds: sql<number>`COALESCE(SUM(${playerSessions.seedSeconds}) FILTER (WHERE ${playerSessions.lastSeen} >= ${from}), 0)::int`,
			totalSeconds: sql<number>`COALESCE(SUM(${playerSessions.seedSeconds}), 0)::bigint`
		})
		.from(playerSessions)
		.where(
			and(
				eq(playerSessions.serverId, ctx.server.id),
				inArray(
					playerSessions.steamId,
					ctx.players.map((p) => p.steamId)
				),
				isNotNull(playerSessions.leftAt)
			)
		)
		.groupBy(playerSessions.steamId);
	const history = new Map(closed.map((r) => [r.steamId, r]));
	// The whisper names this date; the entry's own expiry is set when the grant is delivered.
	const expiresAt = new Date(now + cfg.slotDays * 86400_000);
	let n = 0;
	let last = '';
	for (const p of ctx.players) {
		const openSeconds = Math.floor((ctx.seedMs.get(p.steamId) ?? 0) / 1000);
		const historyRow = history.get(p.steamId);
		const total = Number(historyRow?.totalSeconds ?? 0) + openSeconds;
		const previous = progress.players[p.steamId];
		const balance = previous
			? previous.balance + Math.max(0, total - previous.observed)
			: Number(historyRow?.windowSeconds ?? 0) + openSeconds;
		const earned = balance >= cfg.minutes * 60;
		const eligible = !ctx.reserved.has(p.steamId) || cfg.replaceExisting;
		progress.players[p.steamId] = {
			observed: total,
			balance: earned && eligible ? 0 : balance,
			seenAt: now
		};
		if (!earned || !eligible) continue;
		const minutes = Math.floor(balance / 60);
		const reason = `Seeded ${ctx.server.name}: ${minutes} min with ${cfg.lowAt} or fewer on`;
		out.intents.push({
			trigger: row,
			action: 'seed_reward',
			params: {
				steamId: p.steamId,
				name: p.name,
				reason,
				slotDays: cfg.slotDays,
				scope: cfg.scope === 'server' ? 'server' : 'org',
				replaceExisting: cfg.replaceExisting
			},
			target: p.steamId,
			okMessage: `Reserved a slot for ${p.name}.`,
			detail: { name: p.name, minutes, slotDays: cfg.slotDays },
			// The slot was earned; it is granted even if the player leaves before delivery.
			steamId: null,
			dedupeKey: key(row, p.steamId, now)
		});
		if (cfg.message) {
			const message = renderTemplate(cfg.message, {
				...vars(ctx, p),
				minutes,
				until: dateOf(expiresAt),
				days: cfg.slotDays
			});
			out.intents.push({
				trigger: row,
				action: 'whisper',
				params: { steamId: p.steamId, message },
				target: p.steamId,
				okMessage: `Whispered ${p.name}.`,
				detail: { name: p.name },
				steamId: p.steamId,
				dedupeKey: key(row, p.steamId, 'whisper', now)
			});
		}
		n++;
		last = p.name;
	}
	row.state = progress;
	out.updates.push({
		id: row.id,
		state: progress,
		lastFiredAt: n ? ctx.ts : undefined,
		lastResult: n ? `Reserving a slot for ${n === 1 ? last : `${n} players`}` : undefined
	});
}

/**
 * The risk inputs a risk_kick rule needs for these joiners (DB and Steam; call before the
 * transaction). The recorded games are read only when a rule kicks at a risk score.
 */
export async function riskInputs(
	env: Env,
	server: ServerRow,
	joined: Player[],
	withPerformance: boolean
): Promise<{
	signals: Map<string, LocalSignals>;
	profiles: Map<string, SteamProfileRow>;
	performance: Map<string, RiskPerformance>;
}> {
	if (!joined.length) return { signals: new Map(), profiles: new Map(), performance: new Map() };
	const org = await orgServers(env, server.orgId);
	const [signals, profiles, performance] = await Promise.all([
		localSignals(
			env,
			server.orgId,
			org.map((s) => s.id),
			server.id,
			joined,
			// lookalike names only count toward a risk score
			withPerformance
		),
		steamEnabled(env)
			? getProfiles(
					env,
					joined.map((p) => p.steamId)
				)
			: new Map<string, SteamProfileRow>(),
		withPerformance
			? riskPerformanceFor(
					env,
					org.map((s) => s.id),
					joined.map((p) => p.steamId)
				)
			: new Map<string, RiskPerformance>()
	]);
	return { signals, profiles, performance };
}

/** Records a delivery outcome on the trigger row and in the audit trail. */
export async function recordDelivery(
	env: Env,
	row: { triggerId: string | null; triggerName: string; triggerKind: string; serverId: string },
	server: { id: string; name: string; orgId: string },
	target: string,
	outcome: 'ok' | 'error',
	message: string,
	detail: Record<string, unknown>
): Promise<void> {
	await writeAudit(env, null, {
		actorName: `trigger: ${row.triggerName}`,
		server: { id: server.id, name: server.name },
		orgId: server.orgId,
		category: 'trigger',
		action: `trigger.${row.triggerKind}`,
		target,
		outcome,
		status: outcome === 'ok' ? 200 : 502,
		message,
		detail: { triggerId: row.triggerId, ...detail }
	});
	if (row.triggerId)
		await env.db
			.update(triggers)
			.set({
				lastResult: message.slice(0, 300),
				fireCount: outcome === 'ok' ? sql`${triggers.fireCount} + 1` : undefined
			})
			.where(eq(triggers.id, row.triggerId));
}

// ---- dry run ------------------------------------------------------------------------------------

const NAME_REPLAY_MAX = 5000;
/** The welcome and team kill dry runs replay at most this many rows, and say so when they stop. */
const REPLAY_ROWS_MAX = 5000;
/** The risk dry run judges at most this many players (the latest on), for its Steam lookups. */
const RISK_REPLAY_MAX = 2000;

/** Replays the last 24 hours of this server's history against a rule. Touches nobody. */
export async function dryRun(
	env: Env,
	server: ServerRow,
	kind: TriggerKind,
	rawConfig: unknown,
	readReserved?: () => Promise<string[]>
): Promise<DryRunResult> {
	const cfg = validateConfig(kind, rawConfig);
	const to = new Date();
	const from = new Date(to.getTime() - WINDOW_MS);
	const result: DryRunResult = {
		kind,
		from: from.toISOString(),
		to: to.toISOString(),
		fires: 0,
		items: [],
		notes: []
	};
	const push = (at: Date, text: string) => {
		result.fires++;
		if (result.items.length < 50) result.items.push({ at: at.toISOString(), text });
	};
	const joins = (withFaction = false) =>
		env.db.execute<{
			steamId: string;
			name: string;
			joinedAt: Date;
			first: boolean;
		}>(sql`
			SELECT s.steam_id AS "steamId", s.name, s.joined_at AS "joinedAt",
			       NOT EXISTS (SELECT 1 FROM player_sessions e WHERE e.server_id = s.server_id AND e.steam_id = s.steam_id AND e.joined_at < s.joined_at) AS first
			  FROM player_sessions s
			 WHERE s.server_id = ${server.id} AND s.joined_at >= ${from}
			   ${withFaction ? sql`AND s.faction IS NOT NULL AND s.faction <> ''` : sql``}
			 ORDER BY s.joined_at ASC LIMIT ${REPLAY_ROWS_MAX}`);

	if (kind === 'welcome') {
		const c = cfg as WelcomeConfig;
		const rows = await joins(c.afterFaction);
		for (const j of rows) {
			if (c.onlyFirstVisit && !j.first) continue;
			push(
				new Date(j.joinedAt),
				`whisper ${j.name}: ${renderTemplate(c.message, { name: j.name, server: server.name, map: '…', players: '…', max: '…' })}`
			);
		}
		result.notes.push(
			c.onlyFirstVisit
				? 'Only joiners never seen on this server before count.'
				: 'Every join counts, including people who reconnect.'
		);
		if (rows.length === REPLAY_ROWS_MAX)
			result.notes.push(`Only the first ${REPLAY_ROWS_MAX} joins of the window were replayed.`);
		if (c.afterFaction)
			result.notes.push(
				'Only sessions that ended up in a faction count; times shown are the join, the whisper would go out when they picked a side.'
			);
		return result;
	}
	if (kind === 'faction_change') {
		result.notes.push(
			'Faction switches are not kept in the session history, so there is nothing to replay; the rule fires live when a player moves from one faction to another.'
		);
		return result;
	}
	if (kind === 'ping_kick') {
		result.notes.push(
			'Ping is not stored in historical samples, so past high-ping streaks cannot be replayed. The live rule checks each fresh player-list sample and resets a streak when ping recovers, becomes unavailable, or sampling is interrupted.'
		);
		return result;
	}
	if (kind === 'risk_kick') {
		const c = cfg as RiskKickConfig;
		// Everyone on the server at any time in the window, not only the joins: the live rule
		// judges whoever is on. Each player once, at the first time they were on in the window.
		const rows = await env.db.execute<{ steamId: string; name: string; onAt: Date }>(sql`
			SELECT s.steam_id AS "steamId", (ARRAY_AGG(s.name ORDER BY s.joined_at))[1] AS name,
			       GREATEST(MIN(s.joined_at), ${from}) AS "onAt"
			  FROM player_sessions s
			 WHERE s.server_id = ${server.id} AND s.last_seen >= ${from}
			 GROUP BY s.steam_id
			 ORDER BY MAX(s.last_seen) DESC LIMIT ${RISK_REPLAY_MAX}`);
		const seen = new Map<string, { name: string; joinedAt: Date }>();
		for (const j of [...rows].sort((a, b) => +new Date(a.onAt) - +new Date(b.onAt)))
			seen.set(j.steamId, { name: j.name, joinedAt: new Date(j.onAt) });
		const players = [...seen.entries()].map(([steamId, v]) => ({ steamId, name: v.name }));
		const org = await orgServers(env, server.orgId);
		let reserved = new Set<string>();
		if (readReserved) {
			try {
				reserved = new Set(await readReserved());
			} catch {
				result.notes.push('Could not read the reserved slots; nobody was spared for one.');
			}
		}
		const [signals, profiles, performance] = await Promise.all([
			localSignals(
				env,
				server.orgId,
				org.map((s) => s.id),
				server.id,
				players,
				!!riskKickScore(c)
			),
			steamEnabled(env)
				? getProfiles(
						env,
						players.map((p) => p.steamId)
					)
				: new Map(),
			riskKickScore(c)
				? riskPerformanceFor(
						env,
						org.map((s) => s.id),
						players.map((p) => p.steamId)
					)
				: new Map<string, RiskPerformance>()
		]);
		for (const p of players) {
			const l = signals.get(p.steamId);
			const verdict = riskKickVerdict(c, {
				profile: profiles.get(p.steamId) ?? null,
				steamEnabled: steamEnabled(env),
				bannedOn: l?.bannedOn ?? [],
				watched: l?.watched ?? null,
				resembles: l?.resembles ?? [],
				reserved: reserved.has(p.steamId),
				performance: performance.get(p.steamId),
				now: to
			});
			if (verdict) push(seen.get(p.steamId)!.joinedAt, `kick ${p.name} (${p.steamId}): ${verdict}`);
		}
		if (!steamEnabled(env))
			result.notes.push(
				'Steam lookup is off (STEAM_API_KEY): the VAC, game-ban and account-age rules were skipped.'
			);
		result.notes.push(
			`${players.length} distinct player${players.length === 1 ? '' : 's'} on the server in the window${players.length === RISK_REPLAY_MAX ? `, the latest ${RISK_REPLAY_MAX}` : ''}, each judged once.`
		);
		return result;
	}
	if (kind === 'team_kill') {
		const c = cfg as TeamKillConfig;
		// Each team kill in the window, with the killer's running count since their session began
		// (the session open at the time, else the hour before).
		const rows = await env.db.execute<{
			ts: Date;
			killerName: string;
			killerSteamId: string;
			victimName: string;
			n: string;
		}>(sql`
			SELECT k.ts, k.killer_name AS "killerName", k.killer_steam_id AS "killerSteamId",
			       k.victim_name AS "victimName",
			       (SELECT COUNT(*) FROM kills k2
			         WHERE k2.event_type = 'killed' AND k2.parsed_kill
			           AND k2.server_id = k.server_id AND k2.killer_steam_id = k.killer_steam_id
			           AND k2.team_kill AND k2.ts <= k.ts
			           AND k2.ts >= COALESCE((SELECT MAX(s.joined_at) FROM player_sessions s
			                                    WHERE s.server_id = k.server_id AND s.steam_id = k.killer_steam_id
			                                      AND s.joined_at <= k.ts), k.ts - interval '1 hour')) AS n
			  FROM kills k
			 WHERE k.event_type = 'killed' AND k.parsed_kill
			   AND k.server_id = ${server.id} AND k.team_kill AND k.killer_steam_id IS NOT NULL
			   AND k.ts >= ${from}
			 ORDER BY k.ts ASC LIMIT ${REPLAY_ROWS_MAX}`);
		for (const r of rows) {
			const stage = teamKillStage(c, Number(r.n));
			if (!stage) continue;
			const v = {
				name: r.killerName,
				victim: r.victimName,
				count: Number(r.n),
				server: server.name
			};
			push(
				new Date(r.ts),
				stage === 'kick'
					? `kick ${r.killerName} (${r.killerSteamId}): ${renderTemplate(c.kickReason, v)}`
					: `whisper ${r.killerName}: ${renderTemplate(c.warnMessage, v)}`
			);
		}
		const [feed] = await env.db
			.select({ configured: sql<boolean>`feed_token_hash IS NOT NULL` })
			.from(servers)
			.where(eq(servers.id, server.id));
		if (!feed?.configured)
			result.notes.push(
				'This server has no kill feed set up (Config tab), so the rule cannot see any team kills.'
			);
		result.notes.push(
			`${rows.length} team kill${rows.length === 1 ? '' : 's'} in the window${rows.length === REPLAY_ROWS_MAX ? ` (the first ${REPLAY_ROWS_MAX} only)` : ''}, counted per killer within their session.`
		);
		return result;
	}
	if (kind === 'kill_rate') {
		const c = cfg as KillRateConfig;
		// Every kill of the window through the live rule's own step, in the order they arrived.
		const rows = await env.db.execute<{
			ts: Date;
			eventTime: number;
			steamId: string | null;
			name: string | null;
			cause: string | null;
			headshot: boolean;
			suicide: boolean;
		}>(sql`
			SELECT ts, event_time AS "eventTime", killer_steam_id AS "steamId", killer_name AS name,
			       cause, headshot, suicide
			  FROM kills
			 WHERE event_type = 'killed' AND parsed_kill
			   AND server_id = ${server.id} AND ts >= ${from}
			 ORDER BY ts ASC LIMIT ${KILL_RATE_REPLAY_MAX}`);
		// The kills of one ingest batch share its receipt time: each batch is spaced out by the match
		// clock as the live rule does it, then the counted ones replayed.
		const counted: RateKill[] = [];
		for (let i = 0; i < rows.length;) {
			const received = new Date(rows[i].ts).getTime();
			let j = i;
			while (j < rows.length && new Date(rows[j].ts).getTime() === received) j++;
			const batch = rows.slice(i, j);
			const times = killTimes(
				received,
				batch.map((r) => Number(r.eventTime))
			);
			batch.forEach((r, n) => {
				if (!countsForRate({ killer: r.steamId, suicide: !!r.suicide, cause: r.cause })) return;
				counted.push({
					at: times[n],
					steamId: r.steamId!,
					name: r.name || r.steamId!,
					headshot: !!r.headshot
				});
			});
			i = j;
		}
		for (const f of killRateReplay(c, counted))
			push(new Date(f.at), `flag ${f.name} (${f.steamId}): ${f.verdict}`);
		const [feed] = await env.db
			.select({ configured: sql<boolean>`feed_token_hash IS NOT NULL` })
			.from(servers)
			.where(eq(servers.id, server.id));
		if (!feed?.configured)
			result.notes.push(
				'This server has no kill feed set up (Config tab), so the rule cannot see any kills.'
			);
		result.notes.push(
			`${counted.length} kill${counted.length === 1 ? '' : 's'} with hand-held weapons in the window; vehicles, their guns and buildables are not counted.`
		);
		if (rows.length >= KILL_RATE_REPLAY_MAX)
			result.notes.push(
				`Replayed the first ${KILL_RATE_REPLAY_MAX.toLocaleString('en')} kills of the window only.`
			);
		return result;
	}
	if (kind === 'restart_notice') {
		const c = cfg as RestartNoticeConfig;
		const [live] = await env.db
			.select({ startedAt: serverLive.startedAt, players: serverLive.playerCount })
			.from(serverLive)
			.where(eq(serverLive.serverId, server.id))
			.limit(1);
		const w = live?.startedAt
			? restartWindow(live.startedAt.toISOString(), RESTART_AFTER_HOURS, to.getTime())
			: null;
		if (!w || !live?.startedAt) {
			result.notes.push(
				'The worker has not read this server’s uptime yet (GET /v1/health), so there is nothing to project.'
			);
			return result;
		}
		const dueAt = new Date(live.startedAt.getTime() + RESTART_AFTER_HOURS * 3600_000);
		const v = {
			server: server.name,
			map: '…',
			players: live.players,
			max: '…',
			uptime: fmtUptime(w.upMs)
		};
		if (c.leadMinutes) {
			const leadAt = new Date(dueAt.getTime() - c.leadMinutes * 60_000);
			push(
				leadAt,
				`${leadAt < to ? 'already ' : ''}broadcast: ${renderTemplate(c.leadMessage, { ...v, minutes: c.leadMinutes })}`
			);
		}
		push(
			dueAt,
			`${w.due ? 'already ' : ''}broadcast: ${renderTemplate(c.message, { ...v, minutes: 0 })}`
		);
		result.notes.push(
			`Up ${fmtUptime(w.upMs)}; the restart window ${w.due ? 'is open: the game restarts when this round ends' : `opens in ${fmtUptime(w.untilDueMs ?? 0)}`}. Times shown are the coming cycle, not a replay; each stage goes once per game start${c.repeatMinutes ? `, the main message again every ${c.repeatMinutes} min while the window stays open` : ''}, and only with at least ${c.minPlayers} on.`
		);
		return result;
	}
	const rows = await env.db
		.select({
			ts: samples.ts,
			ok: samples.ok,
			count: samples.playerCount,
			max: samples.maxPlayers,
			map: samples.map,
			experiences: samples.experiences,
			scores: samples.scores
		})
		.from(samples)
		.where(and(eq(samples.serverId, server.id), gte(samples.ts, from)))
		.orderBy(asc(samples.ts));
	if (!rows.length) {
		result.notes.push('No samples in the last 24 hours; the poller may be off or the server new.');
		return result;
	}
	if (kind === 'seed_reward') {
		const c = cfg as SeedRewardConfig;
		// A sample is written at least every sampleMs while the worker is up; a longer gap is
		// time nobody was watching, and the live rule would not have credited it either.
		const stretches = lowStretches(
			rows.map((r) => ({ ts: r.ts.getTime(), ok: r.ok, count: r.count ?? 0 })),
			c.lowAt,
			to.getTime(),
			2 * settings().sampleMs + 1000
		);
		const sessions = await env.db
			.select({
				steamId: playerSessions.steamId,
				name: playerSessions.name,
				joinedAt: playerSessions.joinedAt,
				leftAt: playerSessions.leftAt
			})
			.from(playerSessions)
			.where(and(eq(playerSessions.serverId, server.id), gte(playerSessions.lastSeen, from)))
			.orderBy(asc(playerSessions.joinedAt))
			.limit(5000);
		if (sessions.length === 5000)
			result.notes.push(
				'Only the first 5000 sessions of the window were replayed; later ones are not shown.'
			);
		const fulls = fullMoments(
			rows.map((r) => ({ ts: r.ts.getTime(), ok: r.ok, count: r.count ?? 0, max: r.max ?? 0 })),
			c.fullAt
		);
		const totals = seedReplay(
			stretches,
			fulls,
			sessions.map((s) => ({
				steamId: s.steamId,
				joinedAt: s.joinedAt.getTime(),
				leftAt: s.leftAt ? s.leftAt.getTime() : null
			})),
			c.minutes * 60,
			to.getTime(),
			c.untilFull
		);
		let reserved = new Set<string>();
		if (readReserved) {
			try {
				reserved = new Set(await readReserved());
			} catch {
				result.notes.push('Could not read the reserved slots; nobody was skipped for one.');
			}
		}
		const names = new Map(sessions.map((s) => [s.steamId, s.name]));
		const crossed = [...totals]
			.filter(([, t]) => t.crossedAt !== null)
			.sort((a, b) => a[1].crossedAt! - b[1].crossedAt!);
		let held = 0;
		for (const [steamId, t] of crossed) {
			if (reserved.has(steamId) && !c.replaceExisting) {
				held++;
				continue;
			}
			const at = new Date(t.crossedAt!);
			push(
				at,
				`${reserved.has(steamId) ? 'replace reservation for' : 'reserve'} ${names.get(steamId)} (${steamId}) ${c.scope === 'server' ? 'here' : 'across the organisation'} until ${dateOf(new Date(at.getTime() + c.slotDays * 86400_000))}: ${Math.floor(t.seconds / 60)} min with ${c.lowAt} or fewer on`
			);
		}
		const lowMinutes = Math.round(stretches.reduce((n, l) => n + (l.to - l.from), 0) / 60_000);
		result.notes.push(
			`The server was at or under ${c.lowAt} players for ${lowMinutes} min of the window; ${totals.size} player${totals.size === 1 ? '' : 's'} earned seed time${held ? `, ${held} of those who reached ${c.minutes} min already hold a reserved slot and would be skipped` : ''}.`
		);
		result.notes.push(
			`Replayed over the last 24 hours only; the live rule adds up seed time over ${c.windowDays} day${c.windowDays === 1 ? '' : 's'}, so it can also fire for players this replay does not show.`
		);
		result.notes.push(
			'The replay shows raw seed time and cannot subtract time already consumed by a live reward; live progress resets whenever a reward is queued.'
		);
		return result;
	}
	if (kind === 'name_filter') {
		const c = cfg as NameFilterConfig;
		// A name is a name whenever it was used: everyone who has played here, not only the last day.
		const rows = await env.db.execute<{ steamId: string; name: string; joinedAt: Date }>(sql`
			SELECT steam_id AS "steamId", name, MAX(joined_at) AS "joinedAt"
			  FROM player_sessions
			 WHERE server_id = ${server.id}
			 GROUP BY steam_id, name
			 ORDER BY MAX(joined_at) DESC LIMIT ${NAME_REPLAY_MAX}`);
		let reserved = new Set<string>();
		if (c.spareReserved && readReserved) {
			try {
				reserved = new Set(await readReserved());
			} catch {
				result.notes.push('Could not read the reserved slots; nobody was spared for one.');
			}
		}
		let spared = 0;
		for (const r of rows) {
			const v = nameVerdict(c, r.name);
			if (!v) continue;
			if (reserved.has(r.steamId)) spared++;
			else push(new Date(r.joinedAt), `${c.action} ${r.name} (${r.steamId}): ${v.verdict}`);
		}
		if (rows.length) result.from = new Date(rows[rows.length - 1].joinedAt).toISOString();
		result.notes.push(
			`${rows.length} name${rows.length === 1 ? '' : 's'} checked: everyone who has played here${rows.length === NAME_REPLAY_MAX ? `, the latest ${NAME_REPLAY_MAX}` : ''}, under each name they used.`
		);
		if (spared)
			result.notes.push(
				`${spared} more would match but hold${spared === 1 ? 's' : ''} a reserved slot.`
			);
		return result;
	}
	if (kind === 'match_broadcast') {
		const c = cfg as MatchBroadcastConfig;
		const samples = rows.map((r) => ({
			ts: r.ts.getTime(),
			ok: r.ok,
			map: r.map || '',
			scores: Array.isArray(r.scores) ? (r.scores as { name: string; score: number }[]) : [],
			count: r.count ?? 0
		}));
		const ends = matchReplay(samples, 2 * settings().sampleMs + 1000);
		// As live: each end is held until a sample has the rule's players on, for MATCH_HOLD_MS.
		let next = 0;
		let held: HeldMatchEnd | null = null;
		for (const r of samples) {
			if (!r.ok) continue;
			const end = ends[next]?.ts === r.ts ? ends[next++].end : null;
			const step = matchBroadcastStep(held, end, [], r.count, r.ts, c.minPlayers);
			held = step.held;
			if (!step.fire) continue;
			// The samples hold no player lines, so the dry run cannot name anyone.
			for (const { message } of matchBroadcastMessages(c, step.fire.end, r.count, {
				server: server.name,
				map: r.map,
				players: r.count,
				max: '…',
				cap: DEFAULT_SCORE_CAP,
				mvp: '…',
				top: '…'
			}))
				push(new Date(r.ts), `broadcast (${r.count} on): ${message}`);
		}
		result.notes.push(
			ends.length
				? `${ends.length} match${ends.length === 1 ? '' : 'es'} ended in the window. Times shown are the sample that first saw the reset; live, the rule fires one poll after the round ends.`
				: 'No match ended in the window: the map never changed and the scores never fell back.'
		);
		return result;
	}
	if (kind === 'broadcast') {
		const c = cfg as BroadcastConfig;
		let last: Date | null = null;
		let index = 0;
		for (const r of rows) {
			if (!r.ok || !broadcastWanted(c, r.count ?? 0)) continue;
			if (last && r.ts.getTime() - last.getTime() < c.everyMinutes * 60_000) continue;
			last = r.ts;
			push(r.ts, `broadcast (${r.count} on): ${c.messages[index++ % c.messages.length]}`);
		}
		return result;
	}
	const c = cfg as EmptyResetConfig;
	let emptySince: Date | null = null;
	let last: Date | null = null;
	for (const r of rows) {
		const empty = r.ok && (r.count ?? 0) === 0;
		if (!empty) {
			emptySince = null;
			continue;
		}
		emptySince ??= r.ts;
		const there = onTarget(c, {
			map: r.map || '',
			experiences: r.experiences ? r.experiences.split('+') : []
		});
		if (there) continue;
		if (r.ts.getTime() - emptySince.getTime() < c.afterMinutes * 60_000) continue;
		if (last && r.ts.getTime() - last.getTime() < c.cooldownMinutes * 60_000) continue;
		last = r.ts;
		push(
			r.ts,
			`reset ${r.map || '?'} → ${c.map} after ${Math.round((r.ts.getTime() - emptySince.getTime()) / 60_000)} min empty`
		);
	}
	result.notes.push(
		'A real reset changes the map, so later fires in the same empty stretch would not happen.'
	);
	return result;
}
