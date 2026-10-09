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
//   name_change  flag or kick a player the kill feed shows under a name not the one the server lists
//                them under, or under another listed player's (name-change.ts, acted on in
//                feed-events.ts)
//   seed_reward  hand players who stay through a low population a reserved slot, on this server
//                or across the org
//   two_teams    close one faction and move its players to the smaller of the other two
//                (two-teams.ts)
//   kill_distance  flag, warn, kill, kick or ban a player who kills with a chosen weapon or
//                vehicle, from further than it reaches or from any distance (kill-distance.ts,
//                acted on in feed-events.ts)
//   afk_protection  kill everyone every few minutes while the server seeds, so the game's idle kick
//                spares the seeders (afk-protection.ts)
// The worker evaluates them on every observation and writes the actions they want to the outbox
// (outbox.ts delivers, and every delivery lands in the audit trail as category "trigger"). A dry
// run replays the last 24 hours from the samples and sessions tables so a rule can be checked
// before it touches anyone.
import { randomUUID } from 'node:crypto';
import {
	and,
	asc,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	or,
	sql,
	type SQL
} from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, forLog, int, newId, str } from './http';
import { writeAudit } from './audit';
import { emit } from './events';
import {
	kills,
	outbox,
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
import { ONE_PER_SERVER } from '$lib/rule-kinds';
import type { DryRunResult, Player, Status, TriggerKind, TriggerView } from '$lib/types';
import {
	broadcastWanted,
	factionChangeTargets,
	isTriggerKind,
	MAX_REASON,
	onTarget,
	renderTemplate,
	restartNoticeStage,
	riskKickVerdict,
	pingKickStep,
	teamKillNotCounted,
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
import { MAX_CHAT } from '$lib/chat';
import { notifyBounty, type BountyCard } from './webhook-delivery';
import { NAME_FLAG, nameFilterTargets, nameVerdict, type NameFilterConfig } from './name-filter';
import {
	nameChangeSettingsKey,
	nameChangeStep,
	pruneNameTracks,
	sessionSweep,
	type NameChangeConfig,
	type NameReading,
	type NameTracks
} from './name-change';
import {
	countsForRate,
	killRateReplay,
	killTimes,
	type KillRateConfig,
	type RateKill
} from './kill-rate';
import {
	countsForDistance,
	KILL_DISTANCE_FLAG,
	killDistanceAction,
	killDistanceBanScope,
	killDistanceReplay,
	killDistanceSettingsKey,
	killDistanceVerdict,
	killsAfterDeathReplay,
	matchKey,
	type DistanceKill,
	type KillDistanceConfig
} from './kill-distance';
import { banNeeds, PANEL_BAN, type PanelBanParams } from './rule-ban';
import { RULE_KILL, RULE_KILL_NEEDS, type RuleKillParams } from './rule-kill';
import { causeLabel, isVehicleCrash, notCountedLabel, VEHICLE_CRASH } from '$lib/causes';
import {
	emptyTwoTeamsState,
	teamName,
	TWO_TEAMS_ASK_WINDOW_MS,
	TWO_TEAMS_MAX_ASKS,
	TWO_TEAMS_MAX_MOVES_PER_LOOK,
	TWO_TEAMS_MOVES_PER_SECOND,
	TWO_TEAMS_STAFF_MOVE_MS,
	twoTeamsSettingsKey,
	twoTeamsStep,
	type TwoTeamsConfig,
	type TwoTeamsState
} from './two-teams';
import {
	AFK_REARM_EMPTY_MS,
	AFK_ROUND,
	AFK_ROUND_MAX_PLAYERS,
	afkReplay,
	afkSettingsKey,
	afkState,
	afkStep,
	type AfkProtectionConfig
} from './afk-protection';
import {
	BOUNTY_LAPSE,
	bountyReplay,
	bountyReward,
	bountyScope,
	bountyState,
	bountyTrack,
	forgetBounties,
	lapseWords,
	rewardWords,
	savedBounty,
	bountyVersion,
	type BountyConfig,
	type BountyKill,
	type BountyLapse,
	type BountyReplayEvent,
	type OpenBounty
} from './bounty';
import {
	describeRestartSchedule,
	fmtUptime,
	restartScheduleOf,
	restartWindow,
	type RestartSchedule
} from '$lib/uptime';
import {
	ROTATION_SHUFFLE,
	rotationShuffleState,
	shuffleStep,
	type RotationShuffleConfig,
	type ShuffleWhen
} from './rotation-shuffle';
import { DEFAULT_SCORE_CAP } from '$lib/match';
import { mapName } from '$lib/format';
import { statsIn, usesStats } from '$lib/placeholders';
import { settings } from './settings';
import { playerStats, riskPerformanceFor } from './leaderboards';
import type { RiskPerformance } from './risk';
import {
	dryRunVars,
	keptVars,
	messageVars,
	NO_STATS,
	serverVars,
	UNKNOWN,
	type MessageVars,
	type PlayerStats,
	type StatsBy
} from './message-vars';

export * from './trigger-rules';

const WINDOW_MS = 24 * 3600_000;
/** The most kills one Kill rate dry run reads, whatever the server did that day. */
const KILL_RATE_REPLAY_MAX = 200_000;
/** The most kills one Name change dry run reads names from. */
const NAME_CHANGE_REPLAY_MAX = 200_000;
/** The most sessions it reads the listed names from (a busy server has a couple of thousand a day). */
const NAME_SESSIONS_MAX = 20_000;

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
	createdAt: t.createdAt ? t.createdAt.toISOString() : null,
	...(t.kind === 'afk_protection' ? { phase: afkPhase(t.state) } : {}),
	...(t.kind === 'bounty' ? { bounty: openBounty(t) } : {})
});

/** A Bounty rule's open bounty, as its row shows it: the one its last save holds, if any. */
function openBounty(t: TriggerRow): TriggerView['bounty'] {
	const b = savedBounty(t.state, bountyVersion(t));
	return b
		? { steamId: b.steamId, name: b.name, streak: b.streak, setAt: new Date(b.setAt).toISOString() }
		: null;
}

/** Where an AFK protection rule stands, as its row shows it; null until the worker has looked. */
function afkPhase(state: unknown): TriggerView['phase'] {
	const s = afkState(state);
	if (!s) return null;
	return { on: s.on, since: s.since ? new Date(s.since).toISOString() : null, why: s.why };
}

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
 * need to do the same by hand: a rule that kicks needs Kick, not only Automation.
 */
const RULE_NEEDS: Record<
	Exclude<TriggerKind, 'seed_reward' | 'kill_distance' | 'bounty'>,
	[Capability, string]
> = {
	welcome: ['chat.send', 'messages players'],
	faction_change: ['chat.send', 'messages players'],
	broadcast: ['chat.send', 'messages players'],
	restart_notice: ['chat.send', 'messages players'],
	match_broadcast: ['chat.send', 'messages players'],
	empty_reset: ['match.control', 'changes the map'],
	risk_kick: ['players.kick', 'kicks players'],
	name_filter: ['players.kick', 'kicks players'],
	ping_kick: ['players.kick', 'kicks players'],
	team_kill: ['players.kick', 'kicks players'],
	kill_rate: ['players.kick', 'flags players'],
	two_teams: ['players.move', 'moves players between teams'],
	afk_protection: ['players.kill', 'kills players'],
	name_change: ['players.kick', 'flags or kicks players'],
	rotation_shuffle: ['config.apply', 'rewrites the rotation in the config document']
};

/** What a reserved slot a rule hands out needs: one here, or on the organisation's list. */
const SLOT_NEEDS: Record<'server' | 'org', [Capability, string]> = {
	org: ['lists.reserve', "edits the organisation's reserved-slot list"],
	server: ['slots.manage', 'reserves slots on this server']
};

/**
 * What one rule needs of whoever saves it. The Seeding reward reserves slots: here, or on the
 * organisation's list. A Kill distance rule flags, warns, kills (and whispers), kicks, or bans:
 * here, or on the organisation's ban list. A Bounty broadcasts, and reserves the claimer a slot when
 * it has a reward.
 */
export function ruleNeeds(kind: TriggerKind, config: unknown): [Capability, string] {
	if (kind === 'seed_reward')
		return SLOT_NEEDS[
			(config as Partial<SeedRewardConfig> | null)?.scope !== 'server' ? 'org' : 'server'
		];
	if (kind === 'bounty')
		return bountyReward(config) === 'slot'
			? SLOT_NEEDS[bountyScope(config)]
			: ['chat.send', 'messages players'];
	if (kind === 'kill_distance') {
		const action = killDistanceAction(config);
		if (action === 'ban') return banNeeds(killDistanceBanScope(config));
		if (action === 'warn') return ['chat.send', 'whispers players'];
		if (action === 'kill') return RULE_KILL_NEEDS[0];
		return ['players.kick', action === 'kick' ? 'kicks players' : 'flags players'];
	}
	return RULE_NEEDS[kind];
}

/**
 * What else a rule needs when it also messages players: a Team balance rule with a whisper, an AFK
 * protection rule with a broadcast, a Kill distance rule's kill with its whisper.
 */
function ruleAlsoNeeds(kind: TriggerKind, config: unknown): [Capability, string] | null {
	if (kind === 'kill_distance' && killDistanceAction(config) === 'kill') return RULE_KILL_NEEDS[1];
	if (kind === 'bounty' && bountyReward(config) === 'slot')
		return ['chat.send', 'messages players'];
	if (kind === 'two_teams' && str((config as Partial<TwoTeamsConfig> | null)?.message))
		return ['chat.send', 'whispers players'];
	const afk = config as Partial<AfkProtectionConfig> | null;
	if (kind === 'afk_protection' && (str(afk?.message) || str(afk?.doneMessage)))
		return ['chat.send', 'messages players'];
	return null;
}

export function requireRuleCaps(
	kind: TriggerKind,
	config: unknown,
	server: ServerRow,
	access: ServerAccess
): void {
	for (const need of [ruleNeeds(kind, config), ruleAlsoNeeds(kind, config)]) {
		if (!need || access.caps.has(need[0])) continue;
		const [cap, does] = need;
		throw new ApiError(
			403,
			`A ${TRIGGER_LABELS[kind]} rule ${does}, which needs '${CAPABILITY_INFO[cap].label}' on ${server.name}; your role '${access.roleName}' does not include it.`,
			'forbidden'
		);
	}
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
	const row = await env.db.transaction(async (tx) => {
		// One rule of these kinds per server ($lib/rule-kinds says why). Saves to one server take turns,
		// so two at once cannot both find none.
		if (ONE_PER_SERVER.includes(kind)) {
			await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`triggers:${server.id}`}))`);
			const [other] = await tx
				.select({ name: triggers.name })
				.from(triggers)
				.where(and(eq(triggers.serverId, server.id), eq(triggers.kind, kind)))
				.limit(1);
			if (other)
				throw new ApiError(
					409,
					`This server already has a ${TRIGGER_LABELS[kind]} rule ("${other.name}"); edit that one instead.`,
					'duplicate'
				);
		}
		const [inserted] = await tx
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
		return inserted;
	});
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
	// Any save of a Bounty rule calls off its open bounty: the worker starts it over (bounty.ts).
	if (row.kind === 'bounty') set.state = null;
	// A Rotation shuffle rule's settings saved (its order may have changed): it shuffles once more,
	// as it does when switched on again (below).
	if (row.kind === 'rotation_shuffle' && body.config !== undefined) set.state = null;
	// Switched on again, a Team balance rule starts over in the worker (its memory is keyed on this):
	// who switched sides while it was off is unknown, so whoever is on then counts as placed. Whether
	// it was off is the row's at the write, not the read above, so a switch-off landing between them
	// still gets its switch-on.
	// Switched on again, an AFK protection rule starts from what the server shows then: whether it
	// emptied or restarted while the rule was off is unknown. An edit keeps where it stands, so
	// changing a message while a match is on cannot turn it on.
	const switchOn =
		row.kind === 'two_teams' && set.enabled === true
			? sql`CASE WHEN ${triggers.enabled} THEN ${triggers.state} ELSE (${JSON.stringify({ enabledAt: Date.now() })}::text)::jsonb END`
			: (row.kind === 'afk_protection' ||
						(row.kind === 'rotation_shuffle' && set.state === undefined)) &&
				  set.enabled === true
				? sql`CASE WHEN ${triggers.enabled} THEN ${triggers.state} ELSE NULL END`
				: undefined;
	requireRuleCaps(row.kind, set.config ?? row.config, server, access);
	if (!Object.keys(set).length) throw new ApiError(400, 'Nothing to update.');
	set.updatedAt = new Date();
	const [updated] = await env.db
		.update(triggers)
		.set(switchOn ? { ...set, state: switchOn } : set)
		.where(eq(triggers.id, row.id))
		.returning();
	// Saved again with the same settings (a rename, say), what it queued still holds.
	const settings = SETTINGS_KEYS[row.kind];
	if (
		settings &&
		(set.enabled === false ||
			(set.config !== undefined && settings(set.config) !== settings(row.config)))
	)
		await dropQueued(env, row.id, 'The rule was changed before this was sent.');
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
	if (SETTINGS_KEYS[row.kind])
		await dropQueued(env, row.id, 'The rule was deleted before this was sent.');
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

/**
 * The kinds whose queued actions go only under the settings they were decided under, and each
 * one's key of those settings (every row carries it as `params.rule`; outbox.ts checks it again at
 * delivery): a Team balance move decided under the old closed faction or gap could take a player
 * to the wrong side, and a Kill distance kick or ban decided under settings an admin has just corrected, or by
 * a rule just switched off, is not to be sent; nor is an AFK protection round once the rule is off,
 * which is how it is stopped in a hurry, nor a Name change flag or kick.
 */
export const SETTINGS_KEYS: Partial<Record<string, (config: unknown) => string>> = {
	two_teams: (c) => twoTeamsSettingsKey(c as TwoTeamsConfig),
	kill_distance: (c) => killDistanceSettingsKey(c as KillDistanceConfig),
	afk_protection: (c) => afkSettingsKey(c as AfkProtectionConfig),
	name_change: (c) => nameChangeSettingsKey(c as NameChangeConfig)
};

/**
 * Such a rule's queued actions were decided under settings that no longer hold: they are skipped,
 * kept with the reason. One already being sent is checked again at delivery (outbox.ts).
 */
async function dropQueued(env: Env, triggerId: string, why: string): Promise<void> {
	const dropped = await env.db
		.update(outbox)
		.set({ state: 'skipped', outcome: why, doneAt: new Date() })
		// 'pending' as text: outbox_pending_idx holds only open rows, which a bound value does not prove
		.where(and(eq(outbox.triggerId, triggerId), sql`${outbox.state} = 'pending'`))
		.returning({ id: outbox.id, serverId: outbox.serverId });
	for (const r of dropped)
		emit({ type: 'outbox', serverId: r.serverId, id: r.id, state: 'skipped' });
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
	/** RestartTimeUtc the process started with ("HH:MM", UTC); null or absent when unset */
	restartTimeUtc?: string | null;
	/** the match that ended between the previous look and this one, or null */
	matchEnd: MatchEnd | null;
	/** the first look after the server was out of reach: what happened meanwhile is unknown (a match
	 *  end in it is not seen) */
	recovered?: boolean;
	/** at a boundary, every player's line of the match that ended, from the worker's tallies */
	matchLines: MatchLineVars[];
	/** the players with an open session: on, or gone for less than the leave grace; absent, nobody
	 *  is known to have left */
	present?: { has(steamId: string): boolean };
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
	/** a rule set to watch only: the row is kept as skipped, with this as its outcome, and never sent */
	watchOnly?: string;
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

/**
 * Everything a message on this look fills ($lib/placeholders): the server's, the player's when it
 * is to or about one (with their stats, when read), and what the rule decided (`own`).
 */
const vars = (
	ctx: TickContext,
	p?: Player | null,
	stats: StatsBy = {},
	own: MessageVars = {}
): MessageVars =>
	messageVars(
		serverVars({
			name: ctx.server.name,
			status: ctx.status,
			startedAt: ctx.startedAt,
			now: ctx.ts.getTime()
		}),
		p ? { name: p.name, steamId: p.steamId, faction: p.faction, ping: p.ping } : null,
		stats,
		own
	);

/**
 * Reads players' stats for the messages of one evaluation (or one feed batch): this server's
 * (`here`) or its organisation's (`org`), each player once a side. A player whose read failed has
 * none, so their stats show as `…` and the rule acts all the same.
 */
export type StatsReader = (
	side: 'here' | 'org',
	steamIds: string[]
) => Promise<Map<string, PlayerStats>>;

export function statsReader(env: Env, serverId: string): StatsReader {
	const known = { here: new Map<string, PlayerStats>(), org: new Map<string, PlayerStats>() };
	let org: string[] | null = null;
	return async (side, steamIds) => {
		const seen = known[side];
		const want = [...new Set(steamIds)].filter((id) => !seen.has(id));
		if (want.length)
			try {
				const ids = side === 'here' ? [serverId] : (org ??= await orgServerIds(env, serverId));
				const read = await playerStats(env, ids, want);
				for (const id of want) seen.set(id, read.get(id) ?? NO_STATS);
			} catch (err) {
				console.warn(`[warcon] player stats on ${serverId}:`, forLog(err));
			}
		return seen;
	};
}

/** Every server of this server's organisation, itself included. */
async function orgServerIds(env: Env, serverId: string): Promise<string[]> {
	const rows = await env.db.execute<{ id: string }>(sql`
		SELECT s.id FROM servers s JOIN servers me ON me.org_id = s.org_id WHERE me.id = ${serverId}`);
	return rows.map((r) => r.id);
}

/**
 * The stats of each side that one of these messages uses, read for the players whose text does;
 * `org: false` for a text kept where staff read it, which has no org-wide stats.
 */
export interface StatsRead {
	here: Map<string, PlayerStats> | null;
	org: Map<string, PlayerStats> | null;
}

export async function statsFor(
	read: StatsReader,
	wants: { steamId: string; text: string }[],
	{ org: orgSide = true } = {}
): Promise<StatsRead> {
	const sides = new Map<string, { here: boolean; org: boolean }>();
	const ids = (side: 'here' | 'org') =>
		wants
			.filter((w) => (sides.get(w.text) ?? sides.set(w.text, statsIn(w.text)).get(w.text)!)[side])
			.map((w) => w.steamId);
	const here = ids('here');
	const org = orgSide ? ids('org') : [];
	return {
		here: here.length ? await read('here', here) : null,
		org: org.length ? await read('org', org) : null
	};
}

/** One player's stats from what was read. */
export const statsOf = (s: StatsRead, steamId: string): StatsBy => ({
	here: s.here?.get(steamId),
	org: s.org?.get(steamId)
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
	// Stats are read only for a message that uses them, once per player whichever rules ask.
	const read = statsReader(env, ctx.server.id);
	for (const row of rows) {
		try {
			switch (row.kind) {
				case 'welcome':
					await evalWelcome(ctx, row, row.config as WelcomeConfig, out, read);
					break;
				case 'faction_change':
					await evalFactionChange(ctx, row, row.config as FactionChangeConfig, out, read);
					break;
				case 'broadcast':
					evalBroadcast(ctx, row, row.config as BroadcastConfig, out);
					break;
				case 'empty_reset':
					await evalEmptyReset(env, ctx, row, row.config as EmptyResetConfig, out);
					break;
				case 'risk_kick':
					await evalRiskKick(env, ctx, row, row.config as RiskKickConfig, out, read);
					break;
				case 'ping_kick':
					await evalPingKick(ctx, row, row.config as PingKickConfig, out, read);
					break;
				case 'restart_notice':
					evalRestartNotice(ctx, row, row.config as RestartNoticeConfig, out);
					break;
				case 'team_kill':
				case 'kill_rate':
				case 'kill_distance':
				case 'name_change':
					// Acted on as kills arrive (feed-events.ts), not per observation.
					break;
				case 'seed_reward':
					await evalSeedReward(env, ctx, row, row.config as SeedRewardConfig, out, read);
					break;
				case 'match_broadcast':
					evalMatchBroadcast(ctx, row, row.config as MatchBroadcastConfig, out);
					break;
				case 'name_filter':
					await evalNameFilter(ctx, row, row.config as NameFilterConfig, out, read);
					break;
				case 'two_teams':
					await evalTwoTeams(ctx, row, row.config as TwoTeamsConfig, out, read);
					break;
				case 'afk_protection':
					evalAfkProtection(ctx, row, row.config as AfkProtectionConfig, out);
					break;
				case 'bounty':
					// Kills move it on as they arrive (feed-events.ts); a look ends it.
					evalBounty(env, ctx, row, row.config as BountyConfig, out);
					break;
				case 'rotation_shuffle':
					evalRotationShuffle(ctx, row, row.config as RotationShuffleConfig, out);
					break;
			}
		} catch (err) {
			// The rule shows a fixed phrase unless the panel refused in its own words; the error goes
			// to the log (a failed query's message lists its parameters).
			console.error(`[warcon] trigger ${row.name}`, forLog(err));
			const why = err instanceof ApiError ? err.message : 'the rule could not be checked.';
			out.updates.push({ id: row.id, lastResult: `Error: ${why}`.slice(0, 300) });
		}
	}
	return out;
}

const key = (row: TriggerRow, ...parts: (string | number)[]) => [row.id, ...parts].join(':');

async function evalWelcome(
	ctx: TickContext,
	row: TriggerRow,
	cfg: WelcomeConfig,
	out: Evaluation,
	read: StatsReader
) {
	let n = 0;
	let last = '';
	const targets = welcomeTargets(cfg, ctx);
	const stats = await statsFor(
		read,
		targets.map((p) => ({ steamId: p.steamId, text: cfg.message }))
	);
	for (const p of targets) {
		const message = renderTemplate(cfg.message, vars(ctx, p, statsOf(stats, p.steamId)), MAX_CHAT);
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

async function evalFactionChange(
	ctx: TickContext,
	row: TriggerRow,
	cfg: FactionChangeConfig,
	out: Evaluation,
	read: StatsReader
) {
	let n = 0;
	let last = '';
	const targets = factionChangeTargets(ctx);
	const stats = await statsFor(
		read,
		targets.map((t) => ({ steamId: t.player.steamId, text: cfg.message }))
	);
	for (const { player: p, from } of targets) {
		const message = renderTemplate(
			cfg.message,
			vars(ctx, p, statsOf(stats, p.steamId), { previous: from ?? '' }),
			MAX_CHAT
		);
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
	const message = renderTemplate(cfg.messages[index], vars(ctx), MAX_CHAT);
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
		// NULLS LAST as samples_server_ts_idx is built: back through this server's samples only
		.orderBy(sql`${samples.ts} desc nulls last`)
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

async function evalRiskKick(
	env: Env,
	ctx: TickContext,
	row: TriggerRow,
	cfg: RiskKickConfig,
	out: Evaluation,
	read: StatsReader
) {
	if (!ctx.riskCheck.length) return;
	let n = 0;
	let last = '';
	const kicks: { p: Player; verdict: string }[] = [];
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
		if (verdict) kicks.push({ p, verdict });
	}
	const stats = await statsFor(
		read,
		kicks.map((k) => ({ steamId: k.p.steamId, text: cfg.reason }))
	);
	for (const { p, verdict } of kicks) {
		// The verdict is staff's (it can quote ban reasons and the watchlist): the player is told
		// only the rule's reason.
		const reason = renderTemplate(cfg.reason, vars(ctx, p, statsOf(stats, p.steamId)), MAX_REASON);
		out.intents.push({
			trigger: row,
			action: 'kick',
			params: { steamId: p.steamId, reason },
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

async function evalNameFilter(
	ctx: TickContext,
	row: TriggerRow,
	cfg: NameFilterConfig,
	out: Evaluation,
	read: StatsReader
) {
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
	const kick = cfg.action === 'kick';
	const targets = nameFilterTargets(cfg, named, ctx.reserved);
	const stats = await statsFor(
		read,
		kick ? targets.map((t) => ({ steamId: t.player.steamId, text: cfg.reason })) : []
	);
	for (const { player: p, verdict: v } of targets) {
		out.intents.push({
			trigger: row,
			action: kick ? 'kick' : NAME_FLAG,
			params: kick
				? {
						steamId: p.steamId,
						reason: renderTemplate(
							cfg.reason,
							vars(ctx, p, statsOf(stats, p.steamId), { why: v.why }),
							MAX_REASON
						)
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

async function evalPingKick(
	ctx: TickContext,
	row: TriggerRow,
	cfg: PingKickConfig,
	out: Evaluation,
	read: StatsReader
) {
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
	const stats = await statsFor(
		read,
		kicks.map((steamId) => ({ steamId, text: cfg.reason }))
	);
	for (const p of ctx.players) {
		if (!kicked.has(p.steamId)) continue;
		const steamId = p.steamId;
		const verdict = `ping ${p.ping} ms above ${cfg.maxPingMs} ms for ${cfg.durationSeconds} s`;
		const reason = renderTemplate(cfg.reason, vars(ctx, p, statsOf(stats, steamId)), MAX_REASON);
		out.intents.push({
			trigger: row,
			action: 'kick',
			params: { steamId, reason },
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

/**
 * Each Team balance rule's moves in flight, players told, asks and the sides it placed players on,
 * in this worker's memory: a restart forgets them, which costs at most a move asked for again or a
 * whisper sent again, and takes whoever is on as placed until the next match. The memory starts
 * over (a new `id`) when the rule's settings change, when it is switched on (`key` holds the marker
 * updateTrigger writes then), when the server comes back from being out of reach, and after
 * twoTeamsReseedMs without a look at the player list: who switched meanwhile is unknown. A deleted
 * rule's memory stays until the worker restarts (one small entry). `seq` counts the looks;
 * `committedSeq` is the last look whose moves were written and `boundarySeq` the look that last saw
 * a match end, both for delivery (twoTeamsMoveVerdict). `newMatch` holds a match end until a look
 * that can act on it (a player list, two open sides).
 */
const twoTeamsMemory = new Map<
	string,
	{
		id: string;
		key: string;
		config: string;
		state: TwoTeamsState;
		newMatch: boolean;
		listedAt: number;
		seq: number;
		committedSeq: number;
		boundarySeq: number;
	}
>();
/** Without a look at the player list for this long, a Team balance rule starts over. */
export const TWO_TEAMS_RESEED_MS = 2 * 60_000;
/** The reseed window at a player list cadence: never shorter than three looks. */
export const twoTeamsReseedMs = (playersIntervalMs: number): number =>
	Math.max(TWO_TEAMS_RESEED_MS, 3 * playersIntervalMs);

/**
 * Players a person moved from the panel or the API lately, by server: a Team balance rule takes
 * the side they were moved to as placed, rather than putting them back as a switcher. Noted where
 * the worker runs the action (gateway-local.ts), so the web's separate process needs no channel.
 */
const staffMoves = new Map<string, Map<string, { faction: string; at: number }>>();

export function noteStaffMove(serverId: string, steamId: string, faction: string, at = Date.now()) {
	const moves = staffMoves.get(serverId) ?? new Map<string, { faction: string; at: number }>();
	for (const [id, m] of moves) if (at - m.at >= TWO_TEAMS_STAFF_MOVE_MS) moves.delete(id);
	moves.set(steamId, { faction, at });
	staffMoves.set(serverId, moves);
}

/**
 * Whether a Team balance move may go out now: 'send', 'wait', or why it is dropped. It goes only
 * while the rule's memory that decided it (`mem`) still holds that decision (`seq`, the deciding
 * look): the memory starting over, a match end seen since (even on a look without a player list),
 * a newer decision for the player (a retry), or a person moving them since drops it, so a stale row
 * never moves a player the rule has decided about again. Until the deciding look has been written
 * here, or while this process has no memory of the rule yet, it waits (the stale cut-off ends a
 * wait). Looks are counted, not timed, so a clock step cannot make a fresh row look stale. Rows
 * queued before moves carried their look go as before.
 */
export function twoTeamsMoveVerdict(row: {
	triggerId: string | null;
	serverId: string;
	steamId: string | null;
	params: unknown;
}): 'send' | 'wait' | string {
	const p = row.params as { mem?: unknown; seq?: unknown; at?: unknown } | null;
	if (typeof p?.mem !== 'string' || typeof p.seq !== 'number' || !row.triggerId || !row.steamId)
		return 'send';
	const memory = twoTeamsMemory.get(row.triggerId);
	if (!memory) return 'wait';
	if (memory.id !== p.mem) return 'No longer wanted by the rule.';
	if (memory.committedSeq < p.seq) return 'wait';
	if (p.seq < memory.boundarySeq) return 'A new match began.';
	const staff = staffMoves.get(row.serverId)?.get(row.steamId);
	if (staff && typeof p.at === 'number' && staff.at >= p.at) return 'Moved by hand since.';
	if (memory.state.moving.get(row.steamId)?.seq !== p.seq) return 'No longer wanted by the rule.';
	return 'send';
}

async function evalTwoTeams(
	ctx: TickContext,
	row: TriggerRow,
	cfg: TwoTeamsConfig,
	out: Evaluation,
	read: StatsReader
) {
	const now = ctx.ts.getTime();
	// The same fingerprint rides on every move and whisper, for delivery to check against.
	const config = twoTeamsSettingsKey(cfg);
	// The marker updateTrigger writes when the rule is switched on: it starts over then too.
	const memoryKey = `${config}:${JSON.stringify(row.state ?? null)}`;
	let memory = twoTeamsMemory.get(row.id);
	if (
		memory?.key !== memoryKey ||
		ctx.recovered ||
		(ctx.playersObserved && now - memory.listedAt > twoTeamsReseedMs(ctx.playersIntervalMs))
	)
		twoTeamsMemory.set(
			row.id,
			(memory = {
				id: randomUUID(),
				key: memoryKey,
				config,
				state: emptyTwoTeamsState(),
				newMatch: false,
				listedAt: now,
				seq: 0,
				committedSeq: 0,
				boundarySeq: 0
			})
		);
	const seq = ++memory.seq;
	if (ctx.matchEnd) {
		memory.newMatch = true;
		memory.boundarySeq = seq;
	}
	if (!ctx.playersObserved) return;
	memory.listedAt = now;
	// The match's factions, less the closed one; nothing is placed until two are known.
	const open = (ctx.status.scores ?? [])
		.map((s) => s.name)
		.filter((f) => f && f !== cfg.closedFaction);
	const noted = staffMoves.get(ctx.server.id);
	if (noted) {
		for (const [id, m] of noted) if (now - m.at >= TWO_TEAMS_STAFF_MOVE_MS) noted.delete(id);
		if (!noted.size) staffMoves.delete(ctx.server.id);
	}
	const perLook = Math.min(
		TWO_TEAMS_MAX_MOVES_PER_LOOK,
		Math.max(
			1,
			Math.floor((TWO_TEAMS_MOVES_PER_SECOND * Math.max(ctx.playersIntervalMs, 1000)) / 1000)
		)
	);
	const newMatch = memory.newMatch;
	const step = twoTeamsStep(cfg, memory.state, ctx.players, open, now, perLook, {
		newMatch,
		seq,
		staffMoves: noted
	});
	// The memory moves on only once this look's moves and whispers are queued: a look whose write
	// fails is decided again at the next one, rather than remembered as asked.
	const kept = memory;
	(out.afterCommit ??= []).push(() => {
		kept.state = step.state;
		kept.committedSeq = seq;
		// A match end waits for a look with two open sides to act on.
		if (newMatch && open.length >= 2) kept.newMatch = false;
	});
	for (const m of step.moves) {
		const moved = `${m.name} ${m.why === 'back' ? 'back ' : ''}to ${teamName(cfg, m.to)}`;
		out.intents.push({
			trigger: row,
			action: 'changeTeam',
			params: {
				steamId: m.steamId,
				faction: m.to,
				// the move alone: whether the game needs the kill to respawn them is not settled
				kill: false,
				from: m.from,
				rule: config,
				mem: kept.id,
				seq,
				at: now,
				on: (row.state as { enabledAt?: number } | null)?.enabledAt ?? null
			},
			target: m.steamId,
			okMessage: `Moved ${moved}.`,
			detail: { name: m.name, from: m.from, to: m.to, why: m.why },
			steamId: m.steamId,
			dedupeKey: key(row, m.steamId, kept.id, seq),
			...(cfg.watchOnly ? { watchOnly: `Watch only: would move ${moved}.` } : {})
		});
	}
	const stats = await statsFor(
		read,
		step.whispers.map((w) => ({ steamId: w.steamId, text: cfg.message }))
	);
	for (const w of step.whispers)
		out.intents.push({
			trigger: row,
			action: 'whisper',
			params: {
				steamId: w.steamId,
				rule: config,
				message: renderTemplate(
					cfg.message,
					vars(
						ctx,
						ctx.players.find((p) => p.steamId === w.steamId) ?? {
							name: w.name,
							steamId: w.steamId,
							faction: w.faction,
							kills: 0,
							deaths: 0,
							cash: 0,
							ping: null
						},
						statsOf(stats, w.steamId),
						{ team: teamName(cfg, w.faction) }
					),
					MAX_CHAT
				)
			},
			target: w.steamId,
			okMessage: `Whispered ${w.name}.`,
			detail: { name: w.name, team: teamName(cfg, w.faction) },
			steamId: w.steamId,
			dedupeKey: key(row, w.steamId, 'told', kept.id, seq)
		});
	const n = step.moves.length;
	const verb = cfg.watchOnly ? 'Would move' : 'Moving';
	const moving = n === 1 ? `${verb} ${step.moves[0].name}` : n ? `${verb} ${n} players` : '';
	const left = step.stopped.length
		? `left ${step.stopped.map((p) => `${p.name} on ${p.faction}`).join(', ')}: asked to move ${TWO_TEAMS_MAX_ASKS} times in ${TWO_TEAMS_ASK_WINDOW_MS / 60_000} min`
		: '';
	// A player left alone is said once, on the look that stops them, whatever else it does.
	const result = [moving, left].filter(Boolean).join('; ');
	if (result)
		out.updates.push({
			id: row.id,
			...(n ? { lastFiredAt: ctx.ts } : {}),
			lastResult: result[0].toUpperCase() + result.slice(1)
		});
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
		now: ctx.ts.getTime(),
		schedule: restartScheduleOf(ctx.server.restartSchedule, ctx.restartTimeUtc)
	});
	if (!hit) return;
	const message = renderTemplate(
		hit.stage === 'lead' ? cfg.leadMessage : cfg.message,
		vars(ctx, null, {}, { minutes: hit.minutes }),
		MAX_CHAT
	);
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

const SHUFFLE_WHEN: Record<ShuffleWhen, string> = {
	now: 'now',
	'before-restart': 'for after the restart',
	'after-restart': 'after the restart'
};

/** Once a run, and once when saved: see shuffleStep. The shuffle itself is the delivery's. */
function evalRotationShuffle(
	ctx: TickContext,
	row: TriggerRow,
	cfg: RotationShuffleConfig,
	out: Evaluation
) {
	const now = ctx.ts.getTime();
	const w = ctx.startedAt
		? restartWindow(
				new Date(ctx.startedAt).toISOString(),
				restartScheduleOf(ctx.server.restartSchedule, ctx.restartTimeUtc),
				now
			)
		: null;
	const prev = rotationShuffleState(row.state);
	const step = shuffleStep(prev, { startedAt: ctx.startedAt, restartDue: !!w?.due });
	if (!step) return;
	row.state = step.state;
	if (!step.when) {
		out.updates.push({ id: row.id, state: step.state });
		return;
	}
	out.intents.push({
		trigger: row,
		action: ROTATION_SHUFFLE,
		params: {
			maps: cfg.maps,
			when: step.when,
			playing: ctx.status.map,
			now: ctx.status.rotationNow
		},
		target: 'rotation',
		okMessage: 'Rotation shuffled.',
		detail: { when: step.when, startedAt: new Date(ctx.startedAt).toISOString() },
		steamId: null,
		// once a run before or after a restart; one on saving (no state yet, whenever in the run it
		// comes), every time it is saved
		dedupeKey: key(row, step.when, step.state.boot, prev ? 0 : ctx.ts.getTime())
	});
	// Marked now, with the state, so a slow delivery cannot shuffle twice.
	row.lastFiredAt = ctx.ts;
	out.updates.push({
		id: row.id,
		lastFiredAt: ctx.ts,
		lastResult: `Shuffling ${SHUFFLE_WHEN[step.when]}.`,
		state: step.state
	});
}

/**
 * When each AFK protection rule's server was first seen empty, in worker memory, counted only over
 * looks the rule itself took: a restart, an outage or the rule starting over (switched on again)
 * starts the count afresh, which only turns the rule back on later.
 */
const afkEmpty = new Map<string, number>();

function evalAfkProtection(
	ctx: TickContext,
	row: TriggerRow,
	cfg: AfkProtectionConfig,
	out: Evaluation
) {
	const now = ctx.ts.getTime();
	// The most anyone says is on: a status a few seconds old must not hide a full list.
	const count = Math.max(ctx.status.playerCount || 0, ctx.players.length);
	const prev = afkState(row.state);
	if (count > 0 || ctx.recovered || !prev) afkEmpty.delete(row.id);
	if (count === 0 && !ctx.recovered && !afkEmpty.has(row.id)) afkEmpty.set(row.id, now);
	const emptySince = afkEmpty.get(row.id);
	const goal = cfg.stopAt;
	const step = afkStep(
		cfg,
		prev,
		{
			now,
			count,
			scored: (ctx.status.scores ?? []).some((s) => s.score > 0),
			startedAt: ctx.startedAt,
			listed: ctx.playersObserved,
			recovered: !!ctx.recovered,
			emptyFor: emptySince === undefined ? 0 : now - emptySince
		},
		goal
	);
	if (!step.round && !step.done && JSON.stringify(step.state) === JSON.stringify(prev)) return;
	// Kept on the cached row as well, for the looks before the cache is read again; a failed write
	// reloads the rules (observe.ts), so a round that was not queued is decided again.
	row.state = step.state;
	const update: TriggerUpdate = { id: row.id, state: step.state };
	if (step.off) update.lastResult = `Off until the server empties or restarts: ${step.off}.`;
	else if (step.state.on && (!prev || step.rearmed))
		update.lastResult = `On while fewer than ${goal} are on and no side has scored.`;
	const rule = afkSettingsKey(cfg);
	const say = (text: string) => renderTemplate(text, vars(ctx, null, {}, { goal }), MAX_CHAT);
	if (step.round) {
		const listed = ctx.players
			.filter((p) => /^\d{17}$/.test(p.steamId))
			.slice(0, AFK_ROUND_MAX_PLAYERS);
		const n = listed.length;
		const players = `${n} player${n === 1 ? '' : 's'}`;
		if (n) {
			out.intents.push({
				trigger: row,
				action: AFK_ROUND,
				params: {
					steamIds: listed.map((p) => p.steamId),
					goal,
					rule,
					message: cfg.message ? say(cfg.message) : ''
				},
				target: players,
				okMessage: `Killed ${players}.`,
				detail: { players: n, goal },
				steamId: null,
				dedupeKey: key(row, 'round', now)
			});
			update.lastFiredAt = ctx.ts;
			update.lastResult = `Killing ${players} (${count} on, off at ${goal}).`;
		}
	}
	if (step.done && cfg.doneMessage) {
		const message = say(cfg.doneMessage);
		out.intents.push({
			trigger: row,
			action: 'broadcast',
			params: { message, rule },
			target: message,
			okMessage: 'Broadcast sent.',
			detail: { stage: 'done' },
			steamId: null,
			dedupeKey: key(row, 'done', now)
		});
		update.lastFiredAt = ctx.ts;
	}
	out.updates.push(update);
}

/**
 * A Bounty rule at each look: a match end starts the runs over, and an open bounty lapses when the
 * match ends, when its player's session closes (gone past the leave grace, so a map change's empty
 * list is no leave), or at the first look after the server was out of reach (whatever happened
 * meanwhile, its restart among it, is unknown). Kills set and claim bounties as they arrive
 * (feed-events.ts). The bounty is let go here, before the look is written, so no kill claims it
 * meanwhile; a look whose write fails leaves it open on the rule's row only, where a restart reads
 * it back and the next look or claim lapses it (a claim checks the bounty's match).
 */
function evalBounty(
	env: Env,
	ctx: TickContext,
	row: TriggerRow,
	cfg: BountyConfig,
	out: Evaluation
) {
	const { version, track } = bountyTrack(row);
	if (ctx.matchEnd || ctx.recovered) track.runs.clear();
	const open = track.open;
	if (!open) return;
	const why: BountyLapse | null = ctx.matchEnd
		? 'match'
		: ctx.recovered
			? 'lost'
			: ctx.playersObserved && ctx.present && !ctx.present.has(open.steamId)
				? 'left'
				: null;
	if (!why) return;
	track.open = null;
	const lapse = bountyLapse(
		row,
		cfg,
		version,
		open,
		why,
		ctx.ts,
		ctx.matchEnd?.map ?? ctx.status.map
	);
	out.intents.push(lapse.intent);
	out.updates.push(lapse.update);
	const serverName = ctx.status.serverName || ctx.server.name;
	(out.afterCommit ??= []).push(
		() => void notifyBounty(env, ctx.server.id, serverName, [lapse.card])
	);
}

/**
 * What a bounty lapsing writes: the note in the trail (Recent actions, the Automation mirror), the
 * rule's row with no bounty open, and the card for a Bounties channel, posted once it is written.
 */
export function bountyLapse(
	row: TriggerRow,
	cfg: BountyConfig,
	version: string,
	open: OpenBounty,
	why: BountyLapse,
	at: Date,
	map: string | null
): { intent: Intent; update: TriggerUpdate; card: BountyCard } {
	const state = bountyState(version, null);
	row.state = state;
	const message = lapseWords(open, why);
	return {
		intent: {
			trigger: row,
			action: BOUNTY_LAPSE,
			params: {},
			target: open.steamId,
			okMessage: message,
			detail: { name: open.name, streak: open.streak, run: open.best, why },
			steamId: null,
			dedupeKey: key(row, 'lapse', open.steamId, open.setAt)
		},
		update: { id: row.id, lastFiredAt: at, lastResult: message, state },
		card: {
			kind: 'lapse',
			at: at.toISOString(),
			map: map || null,
			reward: rewardWords(cfg),
			orgWide: cfg.reward === 'slot' && cfg.scope === 'org',
			name: open.name,
			run: open.best,
			why
		}
	};
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
	twoTeamsMemory.clear();
	staffMoves.clear();
	afkEmpty.clear();
	forgetBounties();
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
// observation: the open sessions from memory, the closed ones in the window from the database.
// Above the threshold nobody is earning, so nothing is checked; the fleet's busy servers cost
// nothing here.
const SEED_CHECK_MS = 60_000;
const seedState = new Map<string, { checkedAt: number; low: boolean; full: boolean }>();

const dateOf = (d: Date) => d.toISOString().slice(0, 10);

async function evalSeedReward(
	env: Env,
	ctx: TickContext,
	row: TriggerRow,
	cfg: SeedRewardConfig,
	out: Evaluation,
	read: StatsReader
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
	seedState.set(row.id, { checkedAt: due ? now : state.checkedAt, low, full });
	if (!due) return;
	const candidates = ctx.players.filter((p) => !ctx.reserved.has(p.steamId));
	if (!candidates.length) return;
	const from = new Date(now - cfg.windowDays * 86400_000);
	const closed = await env.db
		.select({ steamId: playerSessions.steamId, seconds: sql<number>`SUM(seed_seconds)::int` })
		.from(playerSessions)
		.where(
			and(
				eq(playerSessions.serverId, ctx.server.id),
				inArray(
					playerSessions.steamId,
					candidates.map((p) => p.steamId)
				),
				isNotNull(playerSessions.leftAt),
				gte(playerSessions.leftAt, from),
				gte(playerSessions.lastSeen, from)
			)
		)
		.groupBy(playerSessions.steamId);
	const earlier = new Map(closed.map((r) => [r.steamId, r.seconds]));
	// The whisper names this date; the entry's own expiry is set when the grant is delivered.
	const expiresAt = new Date(now + cfg.slotDays * 86400_000);
	const earned = candidates
		.map((p) => ({
			p,
			seconds: (earlier.get(p.steamId) ?? 0) + Math.floor((ctx.seedMs.get(p.steamId) ?? 0) / 1000)
		}))
		.filter((e) => e.seconds >= cfg.minutes * 60);
	const stats = await statsFor(
		read,
		cfg.message ? earned.map((e) => ({ steamId: e.p.steamId, text: cfg.message })) : []
	);
	let n = 0;
	let last = '';
	for (const { p, seconds } of earned) {
		const minutes = Math.floor(seconds / 60);
		const reason = `Seeded ${ctx.server.name}: ${minutes} min with ${cfg.lowAt} or fewer on`;
		out.intents.push({
			trigger: row,
			action: 'seed_reward',
			params: {
				steamId: p.steamId,
				name: p.name,
				reason,
				slotDays: cfg.slotDays,
				scope: cfg.scope === 'server' ? 'server' : 'org'
			},
			target: p.steamId,
			okMessage: `Reserved a slot for ${p.name}.`,
			detail: { name: p.name, minutes, slotDays: cfg.slotDays },
			// The slot was earned; it is granted even if the player leaves before delivery.
			steamId: null,
			dedupeKey: key(row, p.steamId, now)
		});
		if (cfg.message) {
			const message = renderTemplate(
				cfg.message,
				vars(ctx, p, statsOf(stats, p.steamId), {
					minutes,
					until: dateOf(expiresAt),
					days: cfg.slotDays
				}),
				MAX_CHAT
			);
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
	if (n)
		out.updates.push({
			id: row.id,
			lastFiredAt: ctx.ts,
			lastResult: `Reserving a slot for ${n === 1 ? last : `${n} players`}`
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
/** A counted kill that caught its killer, as the Kill distance rule acts on it. */
export interface CaughtKill {
	steamId: string;
	name: string;
	cause: string | null;
	/** null when the feed sent none */
	distanceM: number | null;
}

/**
 * What a Kill distance rule does about a player it caught: the outbox row's action and texts, and
 * the line its dry run shows. The live rule (feed-events.ts) and the dry run both build it here,
 * the text the player is told from the placeholders the caller has for the killer (`vars`) and the
 * kill's own; a ban's reason is kept on the ban list where staff read it, so the player's org-wide
 * stats are no placeholders in it, warning, kill, kick or ban alike (keptVars).
 * A ban stands whether or not the player is still on by the time it is delivered; a warning, a kill
 * or a kick does not.
 */
export function killDistanceAct(
	cfg: KillDistanceConfig,
	k: CaughtKill,
	count: number,
	vars: MessageVars
): Omit<Intent, 'trigger' | 'dedupeKey' | 'target'> & { pending: string; line: string } {
	const verdict = killDistanceVerdict(cfg, k.cause, k.distanceM, count);
	const reason = renderTemplate(
		cfg.reason,
		{
			...keptVars(vars),
			weapon: causeLabel(k.cause),
			distance: k.distanceM === null ? UNKNOWN : Math.round(k.distanceM),
			count
		},
		cfg.action === 'warn' || cfg.action === 'kill' ? MAX_CHAT : MAX_REASON
	);
	const detail = { name: k.name, verdict, cause: k.cause, distanceM: k.distanceM, count };
	const who = `${k.name} (${k.steamId})`;
	if (cfg.action === 'warn')
		return {
			action: 'whisper',
			params: { steamId: k.steamId, message: reason },
			okMessage: `Warned ${k.name}: ${verdict}`,
			detail,
			steamId: k.steamId,
			pending: `Warning ${k.name}: ${verdict}`,
			line: `warn ${who}: ${verdict}`
		};
	if (cfg.action === 'kill') {
		const params: RuleKillParams = {
			steamId: k.steamId,
			name: k.name,
			why: verdict,
			message: reason
		};
		return {
			action: RULE_KILL,
			params: { ...params },
			okMessage: `Killed ${k.name}: ${verdict}`,
			detail,
			steamId: k.steamId,
			pending: `Killing ${k.name}: ${verdict}`,
			line: `kill ${who}: ${verdict}`
		};
	}
	if (cfg.action === 'kick')
		return {
			action: 'kick',
			params: { steamId: k.steamId, reason },
			okMessage: `Kicked ${k.name}: ${verdict}`,
			detail,
			steamId: k.steamId,
			pending: `Kicking ${k.name}: ${verdict}`,
			line: `kick ${who}: ${verdict}`
		};
	if (cfg.action === 'ban') {
		const params: PanelBanParams = {
			steamId: k.steamId,
			name: k.name,
			reason,
			days: cfg.banDays,
			scope: cfg.banScope
		};
		const how = `${cfg.banScope === 'org' ? 'on every server' : 'here'} ${cfg.banDays ? `for ${cfg.banDays} day${cfg.banDays === 1 ? '' : 's'}` : 'for good'}`;
		return {
			action: PANEL_BAN,
			params: { ...params },
			okMessage: `Banned ${k.name} ${how}: ${verdict}`,
			detail,
			steamId: null,
			pending: `Banning ${k.name}: ${verdict}`,
			line: `ban ${who} ${how}: ${verdict}`
		};
	}
	return {
		action: KILL_DISTANCE_FLAG,
		params: {},
		okMessage: `Flagged ${k.name}: ${verdict}`,
		detail,
		steamId: k.steamId,
		pending: `Flagging ${k.name}: ${verdict}`,
		line: `flag ${who}: ${verdict}`
	};
}

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

/**
 * Where a replay of a per-match rule starts: the start of the match already running at `from` (two
 * minutes before it, as killsOfMatch reads a match), at most six hours back, else `from`.
 */
async function matchStartBefore(env: Env, serverId: string, from: Date): Promise<Date> {
	const [open] = await env.db.execute<{ startedAt: Date | null }>(sql`
		SELECT MIN(started_at) AS "startedAt" FROM matches
		 WHERE server_id = ${serverId} AND started_at < ${from}
		   AND (ended_at IS NULL OR ended_at >= ${from})`);
	return new Date(
		Math.max(
			Math.min(
				from.getTime(),
				open?.startedAt ? new Date(open.startedAt).getTime() - 120_000 : Infinity
			),
			from.getTime() - 6 * 3600_000
		)
	);
}

/** A dry run's word on a daily restart time ("Restarts daily at 08:00 UTC, …. "); none for 24 hours up. */
const restartsNote = (s: RestartSchedule): string =>
	s.kind === 'daily' ? `Restarts ${describeRestartSchedule(s)}. ` : '';

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
		note(at, text);
	};
	/** a line of the replay that is not a firing of its own (a bounty claimed or lapsed) */
	const note = (at: Date, text: string) => {
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
				`whisper ${j.name}: ${renderTemplate(c.message, dryRunVars(server.name, { name: j.name, steamId: j.steamId }), MAX_CHAT)}`
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
	if (kind === 'two_teams') {
		result.notes.push(
			'Faction moves are not kept in the session history, so there is nothing to replay. Switch on Watch only to see live what the rule would move, under Actions, without moving anyone.'
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
			   AND (s.left_at IS NULL OR s.left_at >= ${from})
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
		// Each team kill in the window, with the killer's running count in the match it arrived in:
		// the rows carrying that match from two minutes before it opened (killsOfMatch), else, for
		// a kill that came in with no match open, the other such kills of the hour before. A kill the
		// rule does not count (by its cause, or a crash) adds to no count and comes back with none.
		const listed = teamKillNotCounted(c).map((x) => x.toLowerCase());
		const notCounted = JSON.stringify(listed);
		const crashes = listed.includes(VEHICLE_CRASH.toLowerCase());
		// countsForTeamKill over the kill row `k`, with isVehicleCrash in SQL: no cause is no crash
		const counts = (k: SQL) =>
			sql`(${k}.cause IS NULL OR lower(${k}.cause) NOT IN (SELECT jsonb_array_elements_text(${notCounted}::text::jsonb)))${
				crashes
					? sql` AND NOT COALESCE(${k}.cause ILIKE 'Vehicle.%' AND ${k}.tags ? ${VEHICLE_CRASH}::text, false)`
					: sql``
			}`;
		const rows = await env.db.execute<{
			ts: Date;
			killerName: string;
			killerSteamId: string;
			victimName: string;
			map: string | null;
			cause: string | null;
			tags: string[];
			n: string | null;
		}>(sql`
			SELECT k.ts, k.killer_name AS "killerName", k.killer_steam_id AS "killerSteamId",
			       k.victim_name AS "victimName", k.map, k.cause, k.tags,
			       CASE WHEN ${counts(sql`k`)} THEN
			       (SELECT COUNT(*) FROM kills k2
			         WHERE k2.server_id = k.server_id AND k2.killer_steam_id = k.killer_steam_id
			           AND k2.team_kill AND ${counts(sql`k2`)} AND k2.ts <= k.ts
			           AND k2.match_row IS NOT DISTINCT FROM k.match_row
			           AND k2.ts >= COALESCE((SELECT m.started_at - interval '2 minutes' FROM matches m
			                                    WHERE m.id = k.match_row AND m.server_id = k.server_id),
			                                 k.ts - interval '1 hour')) END AS n
			  FROM kills k
			 WHERE k.server_id = ${server.id} AND k.team_kill AND k.killer_steam_id IS NOT NULL
			   AND k.ts >= ${from}
			 ORDER BY k.ts ASC LIMIT ${REPLAY_ROWS_MAX}`);
		let counted = 0;
		const left = new Map<string, number>();
		for (const r of rows) {
			if (r.n === null) {
				const label =
					crashes && isVehicleCrash({ cause: r.cause, tags: r.tags })
						? notCountedLabel(VEHICLE_CRASH)
						: causeLabel(r.cause);
				left.set(label, (left.get(label) ?? 0) + 1);
				continue;
			}
			counted++;
			const stage = teamKillStage(c, Number(r.n));
			if (!stage) continue;
			const v = dryRunVars(
				server.name,
				{ name: r.killerName, steamId: r.killerSteamId },
				{ victim: r.victimName, count: Number(r.n), ...(r.map ? { map: mapName(r.map) } : {}) }
			);
			push(
				new Date(r.ts),
				stage === 'kick'
					? `kick ${r.killerName} (${r.killerSteamId}): ${renderTemplate(c.kickReason, v, MAX_REASON)}`
					: `whisper ${r.killerName}: ${renderTemplate(c.warnMessage, v, MAX_CHAT)}`
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
			`${counted} team kill${counted === 1 ? '' : 's'} in the window${rows.length === REPLAY_ROWS_MAX ? ` (the first ${REPLAY_ROWS_MAX} only)` : ''}, counted per killer within each match.`
		);
		if (left.size)
			result.notes.push(
				`Not counted: ${[...left].map(([label, n]) => `${n} by ${label}`).join(', ')}.`
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
			 WHERE server_id = ${server.id} AND ts >= ${from}
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
	if (kind === 'bounty') {
		const c = cfg as BountyConfig;
		// Every kill of the window through the live rule's own step, batch by batch as they came in,
		// from the start of a match already running when the window opens (at most six hours back), so
		// a run at the window's edge is the live one. Each batch is judged against the player count of
		// the server's last sample before it, and a marked player's bounty lapses when their session
		// closed. Only what happened in the window is listed.
		const since = await matchStartBefore(env, server.id, from);
		const rows = await env.db.execute<{
			ts: Date;
			eventId: string;
			matchRow: number | null;
			killer: string | null;
			killerName: string | null;
			killerFaction: string | null;
			victim: string;
			victimName: string;
			victimFaction: string | null;
			suicide: boolean;
			teamKill: boolean;
		}>(sql`
			SELECT ts, event_id AS "eventId", match_row AS "matchRow", killer_steam_id AS killer,
			       killer_name AS "killerName", killer_faction AS "killerFaction",
			       victim_steam_id AS victim, victim_name AS "victimName",
			       victim_faction AS "victimFaction", suicide, team_kill AS "teamKill"
			  FROM kills
			 WHERE server_id = ${server.id} AND ts >= ${since}
			 ORDER BY ts ASC, event_time ASC LIMIT ${KILL_RATE_REPLAY_MAX}`);
		const counts = await env.db.execute<{ ts: Date; n: number | null }>(sql`
			SELECT ts, player_count AS n FROM samples
			 WHERE server_id = ${server.id} AND ok AND ts >= ${new Date(since.getTime() - 10 * 60_000)}
			 ORDER BY ts ASC`);
		const leaves = await env.db.execute<{ steamId: string; leftAt: Date }>(sql`
			SELECT steam_id AS "steamId", left_at AS "leftAt" FROM player_sessions
			 WHERE server_id = ${server.id} AND left_at >= ${since}
			 ORDER BY left_at ASC LIMIT ${NAME_SESSIONS_MAX}`);
		const sampled = counts.map((r) => ({ at: new Date(r.ts).getTime(), n: Number(r.n ?? 0) }));
		let next = 0;
		let on = 0;
		const events: BountyReplayEvent[] = [];
		for (let i = 0; i < rows.length;) {
			const at = new Date(rows[i].ts).getTime();
			let j = i;
			while (j < rows.length && new Date(rows[j].ts).getTime() === at) j++;
			for (; next < sampled.length && sampled[next].at <= at; next++) on = sampled[next].n;
			const batch = rows.slice(i, j);
			events.push({
				kind: 'kills',
				at,
				match: matchKey(batch[0].matchRow === null ? null : Number(batch[0].matchRow), at),
				players: on,
				kills: batch.map((r): BountyKill => ({
					eventId: r.eventId,
					killer: r.killer
						? { steamId: r.killer, name: r.killerName || r.killer, faction: r.killerFaction }
						: null,
					victim: { steamId: r.victim, name: r.victimName, faction: r.victimFaction },
					suicide: !!r.suicide,
					teamKill: !!r.teamKill
				}))
			});
			i = j;
		}
		for (const l of leaves)
			events.push({ kind: 'left', at: new Date(l.leftAt).getTime(), steamId: l.steamId });
		// a leave dated to the same moment as a batch comes after it: a player is seen, then gone
		events.sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === 'kills' ? -1 : 1));
		const { outcomes, open } = bountyReplay(c, events);
		const reward = rewardWords(c);
		const slot = c.reward === 'slot';
		const counted = { set: 0, claim: 0, lapse: 0 };
		for (const o of outcomes) {
			if (o.at < from.getTime()) continue;
			counted[o.kind]++;
			const at = new Date(o.at);
			const b = o.bounty;
			if (o.kind === 'set') {
				const v = keptVars(
					dryRunVars(
						server.name,
						{ name: b.name, steamId: b.steamId },
						{
							target: b.name,
							streak: b.streak,
							reward,
							days: slot ? c.slotDays : '',
							until: slot ? dateOf(new Date(o.at + c.slotDays * 86400_000)) : ''
						}
					)
				);
				push(
					at,
					`bounty on ${b.name} (${b.streak} kills, ${o.players} on): ${renderTemplate(c.setMessage, v, MAX_CHAT)}`
				);
			} else if (o.kind === 'claim')
				note(
					at,
					`claimed by ${o.claimer.name || o.claimer.steamId}: ${b.name} after a run of ${b.best}${slot ? `, ${reward}` : ''}`
				);
			else
				note(
					at,
					o.why === 'left'
						? `lapsed: ${b.name} left (a run of ${b.best})`
						: `lapsed: the match ended, ${b.name} on a run of ${b.best}`
				);
		}
		const [feed] = await env.db
			.select({ configured: sql<boolean>`feed_token_hash IS NOT NULL` })
			.from(servers)
			.where(eq(servers.id, server.id));
		if (!feed?.configured)
			result.notes.push(
				'This server has no kill feed set up (Config tab), so the rule cannot see any kills.'
			);
		const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;
		result.notes.push(
			`${n(counted.set, 'bounty', 'bounties')} set, ${counted.claim} claimed, ${counted.lapse} lapsed${open ? ', one still open' : ''}. Runs start over at each match, and nobody is marked while the server's samples show fewer than ${c.minPlayers} on.`
		);
		if (rows.length >= KILL_RATE_REPLAY_MAX)
			result.notes.push(
				`Replayed the first ${KILL_RATE_REPLAY_MAX.toLocaleString('en')} kills only.`
			);
		return result;
	}
	if (kind === 'kill_distance') {
		const c = cfg as KillDistanceConfig;
		// The kills of the window the rule counts, per match as the live rule counts them, from the
		// start of a match already running when the window opens (at most six hours back), so a count
		// at the window's edge is the live one. Only what happened in the window is listed.
		const since = await matchStartBefore(env, server.id, from);
		// from 0 m a kill without a distance counts too
		const far = c.minDistanceM > 0 ? sql`AND distance_m >= ${c.minDistanceM}` : sql``;
		const rows = await env.db.execute<{
			ts: Date;
			eventId: string;
			eventTime: number;
			steamId: string;
			name: string | null;
			victim: string;
			cause: string | null;
			distanceM: number | null;
			matchRow: number | null;
		}>(sql`
			SELECT ts, event_id AS "eventId", event_time AS "eventTime", killer_steam_id AS "steamId",
			       killer_name AS name, victim_steam_id AS victim, cause, distance_m AS "distanceM",
			       match_row AS "matchRow"
			  FROM kills
			 WHERE server_id = ${server.id} AND ts >= ${since}
			   AND killer_steam_id IS NOT NULL AND NOT suicide ${far}
			   AND lower(cause) IN (SELECT jsonb_array_elements_text(${JSON.stringify(c.causes.map((x) => x.toLowerCase()))}::text::jsonb))
			 ORDER BY ts ASC, event_time ASC LIMIT ${KILL_RATE_REPLAY_MAX}`);
		// Those killers' own deaths from a little before, so a kill just after one is left out as
		// the live rule leaves it out.
		const killers = new Set<string>();
		for (const r of rows) killers.add(r.steamId);
		const deaths = killers.size
			? await env.db.execute<{ ts: Date; eventId: string; eventTime: number; victim: string }>(sql`
				SELECT ts, event_id AS "eventId", event_time AS "eventTime", victim_steam_id AS victim
				  FROM kills
				 WHERE server_id = ${server.id} AND ts >= ${new Date(since.getTime() - 120_000)}
				   AND victim_steam_id IN (SELECT jsonb_array_elements_text(${JSON.stringify([...killers])}::text::jsonb))
				 ORDER BY ts ASC, event_time ASC LIMIT ${KILL_RATE_REPLAY_MAX}`)
			: [];
		const event = (
			ts: Date,
			eventId: string,
			eventTime: number,
			killer: string | null,
			victim: string
		) => ({ eventId, eventTime: Number(eventTime), killer, victim, at: new Date(ts).getTime() });
		const events: ReturnType<typeof event>[] = [];
		for (const r of rows) events.push(event(r.ts, r.eventId, r.eventTime, r.steamId, r.victim));
		for (const d of deaths) events.push(event(d.ts, d.eventId, d.eventTime, null, d.victim));
		const afterDeath = killsAfterDeathReplay(
			events.sort((a, b) => a.at - b.at || a.eventTime - b.eventTime)
		);
		const counted: DistanceKill[] = [];
		let afterDeathInWindow = 0;
		for (const r of rows) {
			const at = new Date(r.ts).getTime();
			const distanceM = r.distanceM === null ? null : Number(r.distanceM);
			const afterOwnDeath = afterDeath.has(r.eventId);
			if (
				!countsForDistance(c, {
					killer: r.steamId,
					suicide: false,
					afterOwnDeath,
					cause: r.cause,
					distanceM
				})
			) {
				if (afterOwnDeath && at >= from.getTime()) afterDeathInWindow++;
				continue;
			}
			counted.push({
				at,
				match: matchKey(r.matchRow === null ? null : Number(r.matchRow), at),
				steamId: r.steamId,
				name: r.name || r.steamId,
				cause: r.cause,
				distanceM
			});
		}
		for (const f of killDistanceReplay(c, counted))
			if (f.at >= from.getTime())
				push(new Date(f.at), killDistanceAct(c, f, f.count, dryRunVars(server.name, f)).line);
		const [feed] = await env.db
			.select({ configured: sql<boolean>`feed_token_hash IS NOT NULL` })
			.from(servers)
			.where(eq(servers.id, server.id));
		if (!feed?.configured)
			result.notes.push(
				'This server has no kill feed set up (Config tab), so the rule cannot see any kills.'
			);
		const inWindow = counted.filter((k) => k.at >= from.getTime()).length;
		result.notes.push(
			`${inWindow} kill${inWindow === 1 ? '' : 's'} with ${c.causes.length === 1 ? causeLabel(c.causes[0]) : 'the chosen weapons'} ${c.minDistanceM > 0 ? `from ${c.minDistanceM} m or more` : 'at any distance'} in the window, counted per match.`
		);
		if (afterDeathInWindow)
			result.notes.push(
				`${afterDeathInWindow} more came within a minute of the killer’s own death and ${afterDeathInWindow === 1 ? 'is' : 'are'} not counted: a vehicle’s shell that lands after the vehicle was destroyed comes credited to the gunner’s own weapon.`
			);
		if (rows.length >= KILL_RATE_REPLAY_MAX)
			result.notes.push(
				`Replayed the first ${KILL_RATE_REPLAY_MAX.toLocaleString('en')} such kills only.`
			);
		return result;
	}
	if (kind === 'name_change') {
		const c = cfg as NameChangeConfig;
		// The live rule holds each kill's names against the player list of that moment; the replay
		// holds the window's kills against the sessions open at each, whose names are the list's (but
		// for a clan tag changed mid-session, which is no change anyway).
		const sessions = await env.db.execute<{
			steamId: string;
			name: string;
			joinedAt: Date;
			leftAt: Date | null;
		}>(sql`
			SELECT steam_id AS "steamId", name, joined_at AS "joinedAt", left_at AS "leftAt"
			  FROM player_sessions
			 WHERE server_id = ${server.id} AND (left_at IS NULL OR left_at >= ${from})
			 ORDER BY joined_at ASC LIMIT ${NAME_SESSIONS_MAX}`);
		const rows = await env.db.execute<{
			ts: Date;
			killer: string | null;
			killerName: string | null;
			victim: string | null;
			victimName: string | null;
		}>(sql`
			SELECT ts, killer_steam_id AS killer, killer_name AS "killerName",
			       victim_steam_id AS victim, victim_name AS "victimName"
			  FROM kills
			 WHERE server_id = ${server.id} AND ts >= ${from}
			 ORDER BY ts ASC, event_time ASC LIMIT ${NAME_CHANGE_REPLAY_MAX}`);
		let reserved = new Set<string>();
		if (c.action === 'kick' && c.spareReserved && readReserved) {
			try {
				reserved = new Set(await readReserved());
			} catch {
				result.notes.push('Could not read the reserved slots; nobody was spared for one.');
			}
		}
		// The list at the kill being replayed, a few seconds' slack for a kill received just after its
		// player left.
		const listedAt = sessionSweep(
			sessions.map((s) => ({
				steamId: s.steamId,
				name: s.name,
				joinedAt: s.joinedAt,
				leftAt: s.leftAt
			}))
		);
		const tracks: NameTracks = new Map();
		const readings = new Map<string, NameReading>();
		const kicked = (steamId: string) =>
			c.action === 'kick' && !(c.spareReserved && reserved.has(steamId));
		for (let i = 0; i < rows.length; i++) {
			const r = rows[i];
			const at = new Date(r.ts).getTime();
			const listed = listedAt(at);
			if (i % 1000 === 0) pruneNameTracks(c, tracks, at);
			const shown: { steamId: string; name: string }[] = [];
			if (r.killer && r.killerName !== null) shown.push({ steamId: r.killer, name: r.killerName });
			if (r.victim && r.victim !== r.killer && r.victimName !== null)
				shown.push({ steamId: r.victim, name: r.victimName });
			for (const h of nameChangeStep(c, tracks, shown, listed, at, { kicked, readings }).hits)
				push(
					new Date(at),
					`${kicked(h.player.steamId) ? 'kick' : 'flag'} ${h.listed} (${h.player.steamId}): ${h.verdict}`
				);
		}
		const [feed] = await env.db
			.select({ configured: sql<boolean>`feed_token_hash IS NOT NULL` })
			.from(servers)
			.where(eq(servers.id, server.id));
		if (!feed?.configured)
			result.notes.push(
				'This server has no kill feed set up (Config tab), so the rule cannot see any names.'
			);
		result.notes.push(
			`${rows.length} kill${rows.length === 1 ? '' : 's'} in the window, each player's name held against the one their session had: a name is checked each time its player kills or dies.`
		);
		if (rows.length >= NAME_CHANGE_REPLAY_MAX)
			result.notes.push(
				`Replayed the first ${NAME_CHANGE_REPLAY_MAX.toLocaleString('en')} kills of the window only.`
			);
		if (sessions.length >= NAME_SESSIONS_MAX)
			result.notes.push(
				`Read the first ${NAME_SESSIONS_MAX.toLocaleString('en')} sessions of the window only; players of later ones were not judged.`
			);
		return result;
	}
	if (kind === 'rotation_shuffle') {
		const c = cfg as RotationShuffleConfig;
		const [live] = await env.db
			.select({ startedAt: serverLive.startedAt, restartTimeUtc: serverLive.restartTimeUtc })
			.from(serverLive)
			.where(eq(serverLive.serverId, server.id))
			.limit(1);
		const schedule = restartScheduleOf(server.restartSchedule, live?.restartTimeUtc);
		const w = live?.startedAt
			? restartWindow(live.startedAt.toISOString(), schedule, to.getTime())
			: null;
		if (!w || !live?.startedAt)
			result.notes.push(
				'The worker has not read this server’s uptime yet (GET /v1/health), so there is nothing to project.'
			);
		else {
			push(w.due ? to : new Date(w.dueAt), 'shuffle in the last round, for after the restart');
			const restart = schedule.kind === 'daily' ? 'the daily restart' : 'the 24-hour restart';
			result.notes.push(
				`${restartsNote(schedule)}Up ${fmtUptime(w.upMs)}; ${w.due ? `${restart} comes when this round ends` : `${restart} is due in ${fmtUptime(w.untilDueMs ?? 0)}`}. A restart that comes first (a set restart time, a crash, one from the host's panel) is followed by a shuffle once the server is back.`
			);
		}
		result.notes.push(
			`Maps in turn: ${c.maps.length ? `${c.maps.map(mapName).join(', ')}, then any other in the order the rotation has it` : 'in the order the rotation has them'}; each map's control zones in turn as well. Saving the rule shuffles once straight away.`
		);
		return result;
	}
	if (kind === 'restart_notice') {
		const c = cfg as RestartNoticeConfig;
		const [live] = await env.db
			.select({
				startedAt: serverLive.startedAt,
				players: serverLive.playerCount,
				restartTimeUtc: serverLive.restartTimeUtc
			})
			.from(serverLive)
			.where(eq(serverLive.serverId, server.id))
			.limit(1);
		const schedule = restartScheduleOf(server.restartSchedule, live?.restartTimeUtc);
		const w = live?.startedAt
			? restartWindow(live.startedAt.toISOString(), schedule, to.getTime())
			: null;
		if (!w || !live?.startedAt) {
			result.notes.push(
				'The worker has not read this server’s uptime yet (GET /v1/health), so there is nothing to project.'
			);
			return result;
		}
		const dueAt = new Date(w.dueAt);
		const v = dryRunVars(server.name, null, {
			players: live.players,
			uptime: fmtUptime(w.upMs)
		});
		if (c.leadMinutes) {
			const leadAt = new Date(dueAt.getTime() - c.leadMinutes * 60_000);
			push(
				leadAt,
				`${leadAt < to ? 'already ' : ''}broadcast: ${renderTemplate(c.leadMessage, { ...v, minutes: c.leadMinutes }, MAX_CHAT)}`
			);
		}
		push(
			dueAt,
			`${w.due ? 'already ' : ''}broadcast: ${renderTemplate(c.message, { ...v, minutes: 0 }, MAX_CHAT)}`
		);
		result.notes.push(
			`${restartsNote(schedule)}Up ${fmtUptime(w.upMs)}; the restart window ${w.due ? 'is open: the game restarts when this round ends' : `opens in ${fmtUptime(w.untilDueMs ?? 0)}`}. Times shown are the coming cycle, not a replay; each stage goes once per game start${c.repeatMinutes ? `, the main message again every ${c.repeatMinutes} min while the window stays open` : ''}, and only with at least ${c.minPlayers} on.`
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
	if (kind === 'afk_protection') {
		const c = cfg as AfkProtectionConfig;
		const replay = afkReplay(
			c,
			rows.map((r) => ({
				ts: r.ts.getTime(),
				ok: r.ok,
				count: r.count ?? 0,
				scores: Array.isArray(r.scores) ? (r.scores as { score: number }[]) : []
			})),
			c.stopAt
		);
		let kills = 0;
		for (const it of replay) {
			const at = new Date(it.at);
			if (it.kind === 'round') {
				kills += it.count;
				push(at, `kill everyone on (${it.count})`);
			} else if (result.items.length < 50)
				// the rule turning off or on is no action: listed, not counted
				result.items.push({
					at: at.toISOString(),
					text: it.kind === 'off' ? `off: ${it.why}` : 'back on: the server sat empty'
				});
		}
		if (result.fires) result.notes.push(`${kills} kills in all.`);
		result.notes.push(
			`Off from ${c.stopAt} on; back on after ${AFK_REARM_EMPTY_MS / 60_000} min empty or a restart (restarts are not replayed).`
		);
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
			.where(
				and(
					eq(playerSessions.serverId, server.id),
					gte(playerSessions.lastSeen, from),
					or(isNull(playerSessions.leftAt), gte(playerSessions.leftAt, from))
				)
			)
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
			if (reserved.has(steamId)) {
				held++;
				continue;
			}
			const at = new Date(t.crossedAt!);
			push(
				at,
				`reserve ${names.get(steamId)} (${steamId}) ${c.scope === 'server' ? 'here' : 'across the organisation'} until ${dateOf(new Date(at.getTime() + c.slotDays * 86400_000))}: ${Math.floor(t.seconds / 60)} min with ${c.lowAt} or fewer on`
			);
		}
		const lowMinutes = Math.round(stretches.reduce((n, l) => n + (l.to - l.from), 0) / 60_000);
		result.notes.push(
			`The server was at or under ${c.lowAt} players for ${lowMinutes} min of the window; ${totals.size} player${totals.size === 1 ? '' : 's'} earned seed time${held ? `, ${held} of those who reached ${c.minutes} min already hold a reserved slot and would be skipped` : ''}.`
		);
		result.notes.push(
			`Replayed over the last 24 hours only; the live rule adds up seed time over ${c.windowDays} day${c.windowDays === 1 ? '' : 's'}, so it can also fire for players this replay does not show.`
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
			for (const { message } of matchBroadcastMessages(
				c,
				step.fire.end,
				r.count,
				dryRunVars(server.name, null, {
					...(r.map ? { map: mapName(r.map) } : {}),
					players: r.count,
					cap: DEFAULT_SCORE_CAP
				}),
				null
			))
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
			const message = renderTemplate(
				c.messages[index++ % c.messages.length],
				dryRunVars(server.name, null, {
					...(r.map ? { map: mapName(r.map) } : {}),
					players: r.count ?? 0,
					...(r.max ? { max: r.max } : {})
				}),
				MAX_CHAT
			);
			push(r.ts, `broadcast (${r.count} on): ${message}`);
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
