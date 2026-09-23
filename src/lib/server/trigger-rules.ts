// The pure part of automation: trigger settings, their validation, message templates and the
// kick-on-connect verdict. No database, no game server, so it is unit-testable on its own;
// triggers.ts holds the engine that runs these against live ticks.
import { ApiError, int, str } from './http';
import { accountAgeDays, assessRisk, type RiskLevel, type RiskPerformance } from './risk';
import { validateNameFilter, type NameFilterConfig } from './name-filter';
import { validateKillRate, type KillRateConfig } from './kill-rate';
import { MAX_RESTART_LEAD_MINUTES, restartWindow, type RestartSchedule } from '$lib/uptime';
import type { SteamProfileRow } from './db/schema';
import type { TriggerKind } from '$lib/types';

export const TRIGGER_KINDS: TriggerKind[] = [
	'welcome',
	'faction_change',
	'broadcast',
	'empty_reset',
	'risk_kick',
	'ping_kick',
	'restart_notice',
	'team_kill',
	'seed_reward',
	'match_broadcast',
	'name_filter',
	'kill_rate'
];
export const TRIGGER_LABELS: Record<TriggerKind, string> = {
	welcome: 'Welcome whisper',
	faction_change: 'Faction change whisper',
	broadcast: 'Scheduled broadcast',
	empty_reset: 'Empty-server map reset',
	risk_kick: 'Kick on connect risk',
	ping_kick: 'High ping kick',
	restart_notice: 'Restart notice',
	team_kill: 'Team kill limit',
	seed_reward: 'Seeding reward',
	match_broadcast: 'Match broadcast',
	name_filter: 'Name filter',
	kill_rate: 'Kill rate watch'
};

export interface WelcomeConfig {
	message: string;
	onlyFirstVisit: boolean;
	/** wait for the player's first faction pick of the session: they choose one after joining, so a
	 *  whisper on join can land while they are still in the menu */
	afterFaction: boolean;
}
/** Whispers a player when they switch from one faction to another (not their first pick). */
export interface FactionChangeConfig {
	message: string;
}
export interface BroadcastConfig {
	messages: string[];
	everyMinutes: number;
	minPlayers: number;
	/** stop once more than this many are on; null is no ceiling */
	maxPlayers: number | null;
}
export interface EmptyResetConfig {
	map: string;
	experiences: string[];
	lighting: string;
	zoneAlternator: string;
	afterMinutes: number;
	cooldownMinutes: number;
}
export interface RiskKickConfig {
	vacBans: boolean;
	gameBans: boolean;
	/** only consider bans this recent; 0 means any ban on record */
	maxBanAgeDays: number;
	minAccountDays: number;
	privateProfiles: boolean;
	bannedElsewhere: boolean;
	watchlist: boolean;
	/** also kick at this advisory risk level or worse (the score the players table shows); null is off */
	kickAtLevel: Exclude<RiskLevel, 'low'> | null;
	spareReserved: boolean;
	reason: string;
}
export interface PingKickConfig {
	maxPingMs: number;
	durationSeconds: number;
	reason: string;
}

export interface PingKickState {
	lastAt: number;
	players: Record<string, { since: number; fired: boolean }>;
}

/** Advance one fresh player-list sample. Missing/normal pings end a streak. */
export function pingKickStep(
	cfg: PingKickConfig,
	previous: PingKickState | null,
	players: { steamId: string; ping: number | null }[],
	now: number,
	maxGapMs: number
): { state: PingKickState; kicks: string[] } {
	const old: PingKickState['players'] =
		previous &&
		Number.isFinite(previous.lastAt) &&
		now >= previous.lastAt &&
		now - previous.lastAt <= maxGapMs &&
		previous.players
			? previous.players
			: {};
	const next: PingKickState = { lastAt: now, players: {} };
	const kicks: string[] = [];
	for (const p of players) {
		if (p.ping === null || !Number.isFinite(p.ping) || p.ping <= cfg.maxPingMs) continue;
		const streak = old[p.steamId] ? { ...old[p.steamId] } : { since: now, fired: false };
		if (!streak.fired && now - streak.since >= cfg.durationSeconds * 1000) {
			streak.fired = true;
			kicks.push(p.steamId);
		}
		next.players[p.steamId] = streak;
	}
	return { state: next, kicks };
}
/**
 * Tells players about the server's scheduled restart (its restart schedule, $lib/uptime: after so
 * many hours up, or daily at a set time), which happens at the end of the round then in
 * progress. Two broadcasts per game start: a heads-up `leadMinutes` before the window opens
 * (0 = none) and `message` once it has, repeated every `repeatMinutes` while the round drags on
 * (0 = once).
 */
export interface RestartNoticeConfig {
	message: string;
	leadMinutes: number;
	leadMessage: string;
	repeatMinutes: number;
	minPlayers: number;
}
/**
 * Acts on team kills the kill feed reports, counted per killer within their current session:
 * a whisper from `warnAt` team kills on (0 = never), a kick at `kickAt` (0 = never).
 */
export interface TeamKillConfig {
	warnAt: number;
	warnMessage: string;
	kickAt: number;
	kickReason: string;
}
/** Where a Seeding reward's slot goes: this server's own list, or the organisation's (every server). */
export type SeedScope = 'server' | 'org';
/**
 * A reserved slot for players who stay while the server is low: time on with at most `lowAt`
 * players counts as seed time, and `minutes` of it within `windowDays` earns a slot for
 * `slotDays`, on this server alone or across the organisation. `message` is whispered on the
 * grant ('' for none). Rules saved before `scope` existed have none and hand out org-wide slots.
 */
export interface SeedRewardConfig {
	scope?: SeedScope;
	lowAt: number;
	/** count seed time only once the server has filled with the player still on */
	untilFull: boolean;
	/** what "filled" means: at least this many on; null is the player limit the server reports */
	fullAt: number | null;
	minutes: number;
	windowDays: number;
	slotDays: number;
	message: string;
}
/**
 * Announces a match ending and the next one starting. A match ends when the map changes or the
 * faction scores fall back (a faction reached the cap, or an admin ended the round); the live
 * builds send no score cap, so the winner is whoever led when the scores reset.
 */
export interface MatchBroadcastConfig {
	/** sent for the match that ended; '' for none */
	endMessage: string;
	/** sent for the match now starting; '' for none */
	startMessage: string;
	minPlayers: number;
}
export type TriggerConfig =
	| WelcomeConfig
	| FactionChangeConfig
	| BroadcastConfig
	| EmptyResetConfig
	| RiskKickConfig
	| PingKickConfig
	| RestartNoticeConfig
	| TeamKillConfig
	| SeedRewardConfig
	| MatchBroadcastConfig
	| NameFilterConfig
	| KillRateConfig;

const MAX_MESSAGE = 200;

export const isTriggerKind = (v: unknown): v is TriggerKind =>
	TRIGGER_KINDS.includes(v as TriggerKind);

/** Checks and normalises a kind's settings; throws a 400 with a reason people can act on. */
export function validateConfig(kind: TriggerKind, raw: unknown): TriggerConfig {
	const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	switch (kind) {
		case 'welcome': {
			const message = str(c.message, MAX_MESSAGE);
			if (!message) throw new ApiError(400, 'The welcome message is empty.');
			return { message, onlyFirstVisit: !!c.onlyFirstVisit, afterFaction: !!c.afterFaction };
		}
		case 'faction_change': {
			const message = str(c.message, MAX_MESSAGE);
			if (!message) throw new ApiError(400, 'The message is empty.');
			return { message };
		}
		case 'broadcast': {
			const list = Array.isArray(c.messages) ? c.messages : String(c.messages ?? '').split('\n');
			const messages = list
				.map((m) => str(m, MAX_MESSAGE))
				.filter(Boolean)
				.slice(0, 20);
			if (!messages.length) throw new ApiError(400, 'Add at least one message to broadcast.');
			const everyMinutes = int(c.everyMinutes, 0, 0, 24 * 60);
			if (!everyMinutes) throw new ApiError(400, 'everyMinutes must be 1-1440.');
			const minPlayers = int(c.minPlayers, 1, 0, 1000);
			const maxPlayers =
				c.maxPlayers === null || c.maxPlayers === undefined || c.maxPlayers === ''
					? null
					: int(c.maxPlayers, 0, 0, 1000);
			if (maxPlayers !== null && maxPlayers < minPlayers)
				throw new ApiError(400, 'The player ceiling cannot be below the floor.');
			return { messages, everyMinutes, minPlayers, maxPlayers };
		}
		case 'empty_reset': {
			const map = str(c.map, 100);
			if (!map) throw new ApiError(400, 'Pick the map to reset to.');
			const experiences = Array.isArray(c.experiences)
				? c.experiences
						.map((e) => str(e, 100))
						.filter(Boolean)
						.slice(0, 10)
				: [];
			const afterMinutes = int(c.afterMinutes, 0, 0, 24 * 60);
			if (!afterMinutes) throw new ApiError(400, 'afterMinutes must be 1-1440.');
			return {
				map,
				experiences,
				lighting: str(c.lighting, 100),
				zoneAlternator: str(c.zoneAlternator, 200),
				afterMinutes,
				cooldownMinutes: int(c.cooldownMinutes, 30, 1, 24 * 60)
			};
		}
		case 'risk_kick': {
			const cfg: RiskKickConfig = {
				vacBans: !!c.vacBans,
				gameBans: !!c.gameBans,
				maxBanAgeDays: int(c.maxBanAgeDays, 0, 0, 36500),
				minAccountDays: int(c.minAccountDays, 0, 0, 3650),
				privateProfiles: !!c.privateProfiles,
				bannedElsewhere: !!c.bannedElsewhere,
				watchlist: !!c.watchlist,
				kickAtLevel: c.kickAtLevel === 'high' || c.kickAtLevel === 'medium' ? c.kickAtLevel : null,
				spareReserved: c.spareReserved === undefined ? true : !!c.spareReserved,
				reason:
					str(c.reason, MAX_MESSAGE) || 'Your account does not meet this server’s requirements.'
			};
			if (
				!cfg.vacBans &&
				!cfg.gameBans &&
				!cfg.minAccountDays &&
				!cfg.bannedElsewhere &&
				!cfg.watchlist &&
				!cfg.kickAtLevel
			)
				throw new ApiError(400, 'Turn on at least one rule.');
			return cfg;
		}
		case 'ping_kick': {
			const maxPingMs = int(c.maxPingMs, 200, 0, 2000);
			const durationSeconds = int(c.durationSeconds, 60, 0, 3600);
			if (!maxPingMs) throw new ApiError(400, 'Set a ping limit from 1 to 2000 ms.');
			if (!durationSeconds) throw new ApiError(400, 'Set a duration from 1 to 3600 seconds.');
			return {
				maxPingMs,
				durationSeconds,
				reason: str(c.reason, MAX_MESSAGE) || 'Ping too high for too long.'
			};
		}
		case 'restart_notice': {
			const message = str(c.message, MAX_MESSAGE);
			if (!message) throw new ApiError(400, 'The restart message is empty.');
			const leadMinutes = int(c.leadMinutes, 0, 0, MAX_RESTART_LEAD_MINUTES);
			const leadMessage = str(c.leadMessage, MAX_MESSAGE);
			if (leadMinutes && !leadMessage)
				throw new ApiError(400, 'Add the heads-up message, or set the heads-up to 0 minutes.');
			return {
				message,
				leadMinutes,
				leadMessage,
				repeatMinutes: int(c.repeatMinutes, 0, 0, 24 * 60),
				minPlayers: int(c.minPlayers, 1, 0, 1000)
			};
		}
		case 'team_kill': {
			const warnAt = int(c.warnAt, 0, 0, 100);
			const kickAt = int(c.kickAt, 0, 0, 100);
			if (!warnAt && !kickAt)
				throw new ApiError(400, 'Set a whisper threshold, a kick threshold, or both.');
			if (warnAt && kickAt && kickAt < warnAt)
				throw new ApiError(400, 'The kick threshold cannot be below the whisper threshold.');
			return {
				warnAt,
				warnMessage:
					str(c.warnMessage, MAX_MESSAGE) ||
					'Careful, {name}: that was a team kill ({count} this session).',
				kickAt,
				kickReason: str(c.kickReason, MAX_MESSAGE) || 'Team killing ({count} this session).'
			};
		}
		case 'seed_reward': {
			const minutes = int(c.minutes, 0, 0, 90 * 1440);
			if (!minutes) throw new ApiError(400, 'Set how many minutes of seeding earn the slot.');
			const windowDays = int(c.windowDays, 7, 1, 90);
			if (minutes > windowDays * 1440)
				throw new ApiError(
					400,
					'The seed time needed cannot exceed the window it is counted over.'
				);
			const lowAt = int(c.lowAt, 20, 1, 1000);
			const fullAt =
				c.fullAt === null || c.fullAt === undefined || c.fullAt === ''
					? null
					: int(c.fullAt, 0, 1, 1000);
			if (fullAt !== null && fullAt <= lowAt)
				throw new ApiError(400, 'Filled must be more players than the seeding threshold.');
			return {
				scope: c.scope === 'server' ? 'server' : 'org',
				lowAt,
				untilFull: c.untilFull === undefined ? true : !!c.untilFull,
				fullAt,
				minutes,
				windowDays,
				slotDays: int(c.slotDays, 7, 1, 365),
				message: str(c.message, MAX_MESSAGE)
			};
		}
		case 'match_broadcast': {
			const endMessage = str(c.endMessage, MAX_MESSAGE);
			const startMessage = str(c.startMessage, MAX_MESSAGE);
			if (!endMessage && !startMessage)
				throw new ApiError(
					400,
					'Add a message for the match ending, the next one starting, or both.'
				);
			return { endMessage, startMessage, minPlayers: int(c.minPlayers, 1, 0, 1000) };
		}
		case 'name_filter':
			return validateNameFilter(c);
		case 'kill_rate':
			return validateKillRate(c);
	}
}

/** A stretch of time the server spent at or under the seeding threshold (ms since the epoch). */
export interface LowStretch {
	from: number;
	to: number;
}

/**
 * The low stretches in a run of samples: each sample holds until the next one (the last until
 * `to`) but for at most `maxHoldMs`, since a longer gap means the worker was not watching, and
 * neighbouring low samples merge into one stretch. A failed sample is not low.
 */
export function lowStretches(
	rows: { ts: number; ok: boolean; count: number }[],
	lowAt: number,
	to: number,
	maxHoldMs = Infinity
): LowStretch[] {
	const out: LowStretch[] = [];
	for (let i = 0; i < rows.length; i++) {
		const r = rows[i];
		if (!r.ok || r.count > lowAt) continue;
		const end = Math.min(to, i + 1 < rows.length ? rows[i + 1].ts : to, r.ts + maxHoldMs);
		if (end <= r.ts) continue;
		const last = out[out.length - 1];
		if (last && last.to >= r.ts) last.to = end;
		else out.push({ from: r.ts, to: end });
	}
	return out;
}

/** The moments the server was filled: samples with the count at or over the rule's fill line, or
 * the limit the server reported; a sample without a limit is never full. */
export function fullMoments(
	rows: { ts: number; ok: boolean; count: number; max: number }[],
	fullAt: number | null
): number[] {
	return rows.filter((r) => r.ok && r.count >= (fullAt ?? (r.max || Infinity))).map((r) => r.ts);
}

export interface SeedSession {
	steamId: string;
	joinedAt: number;
	/** null while still on */
	leftAt: number | null;
}

export interface SeedTotal {
	seconds: number;
	/** when the player's seed time reached the target, or null if it never did */
	crossedAt: number | null;
}

/**
 * Seed time per player from how their sessions overlap the low stretches, as the live rule
 * banks it. With `untilFull` the low time is pending until a full moment with the player still
 * on, and credited then; a session that ends first forfeits it. Without it every minute of
 * overlap counts as it passes. `to` closes open sessions.
 */
export function seedReplay(
	stretches: LowStretch[],
	fulls: number[],
	sessions: SeedSession[],
	targetSeconds: number,
	to: number,
	untilFull = true
): Map<string, SeedTotal> {
	const banked = new Map<string, { at: number; ms: number }[]>();
	const add = (steamId: string, at: number, ms: number) =>
		(banked.get(steamId) ?? banked.set(steamId, []).get(steamId)!).push({ at, ms });
	for (const s of sessions) {
		const end = s.leftAt ?? to;
		const spans: { from: number; to: number }[] = [];
		for (const l of stretches) {
			const from = Math.max(s.joinedAt, l.from);
			const until = Math.min(end, l.to);
			if (until > from) spans.push({ from, to: until });
		}
		if (!untilFull) {
			for (const span of spans) add(s.steamId, span.to, span.to - span.from);
			continue;
		}
		// A low stretch never overlaps a full moment, so each span sits wholly before or after one.
		let pending = 0;
		let next = 0;
		for (const f of fulls) {
			if (f < s.joinedAt) continue;
			if (f > end) break;
			for (; next < spans.length && spans[next].to <= f; next++)
				pending += spans[next].to - spans[next].from;
			if (pending) add(s.steamId, f, pending);
			pending = 0;
		}
	}
	const out = new Map<string, SeedTotal>();
	for (const [steamId, list] of banked) {
		list.sort((a, b) => a.at - b.at);
		let ms = 0;
		let crossedAt: number | null = null;
		for (const b of list) {
			const before = ms;
			ms += b.ms;
			if (crossedAt === null && ms >= targetSeconds * 1000)
				// banked all at once when it fills; minute by minute otherwise
				crossedAt = untilFull ? b.at : b.at - b.ms + (targetSeconds * 1000 - before);
		}
		out.set(steamId, { seconds: Math.floor(ms / 1000), crossedAt });
	}
	return out;
}

/**
 * What the worker counts seed time against on a server: the enabled seeding rule's threshold and
 * whether the time only counts once the server fills, or null when there is no such rule. With
 * more than one rule (one is enforced at save) the highest threshold wins.
 */
export interface SeedRuleShape {
	lowAt: number;
	untilFull: boolean;
	fullAt: number | null;
}
export function seedRule(rows: { kind: string; config: unknown }[]): SeedRuleShape | null {
	let out: SeedRuleShape | null = null;
	for (const r of rows) {
		if (r.kind !== 'seed_reward') continue;
		const c = r.config as SeedRewardConfig;
		if (out === null || c.lowAt > out.lowAt)
			out = { lowAt: c.lowAt, untilFull: c.untilFull, fullAt: c.fullAt ?? null };
	}
	return out;
}

/** Whether a scheduled broadcast goes out with this many players on. */
export function broadcastWanted(
	cfg: Pick<BroadcastConfig, 'minPlayers' | 'maxPlayers'>,
	playerCount: number
): boolean {
	if (playerCount < cfg.minPlayers) return false;
	return cfg.maxPlayers === null || cfg.maxPlayers === undefined || playerCount <= cfg.maxPlayers;
}

/** What a team-kill rule does once the killer's count this session has reached `count`. */
export function teamKillStage(
	cfg: Pick<TeamKillConfig, 'warnAt' | 'kickAt'>,
	count: number
): 'kick' | 'warn' | null {
	if (cfg.kickAt && count >= cfg.kickAt) return 'kick';
	if (cfg.warnAt && count >= cfg.warnAt) return 'warn';
	return null;
}

/** Per-server memory of a restart notice: which stages went out for the current game start. */
export interface RestartNoticeState {
	/** the game start (ms) these stamps belong to; a different start is a new cycle */
	startedAt: number;
	leadAt?: number;
	dueAt?: number;
}

export interface RestartNoticeStage {
	stage: 'lead' | 'due';
	/** minutes until the window opens (lead), or 0 once it has */
	minutes: number;
	state: RestartNoticeState;
}

/**
 * Which broadcast a restart notice sends now, if any. The heads-up goes once per game start when
 * the window is `leadMinutes` away or less; the main message once the window is open, and again
 * every `repeatMinutes` when set. A start time the rule has not seen resets both.
 */
export function restartNoticeStage(
	cfg: Pick<RestartNoticeConfig, 'leadMinutes' | 'repeatMinutes' | 'minPlayers'>,
	prev: RestartNoticeState | null | undefined,
	input: {
		startedAt: number;
		playerCount: number;
		now: number;
		/** the server's restart schedule; null or undefined is the game's default */
		schedule?: RestartSchedule | null;
	}
): RestartNoticeStage | null {
	if (!input.startedAt || input.playerCount < cfg.minPlayers) return null;
	const w = restartWindow(new Date(input.startedAt).toISOString(), input.schedule, input.now);
	if (!w) return null;
	const state: RestartNoticeState =
		prev && prev.startedAt === input.startedAt ? { ...prev } : { startedAt: input.startedAt };
	if (w.due) {
		const again =
			cfg.repeatMinutes > 0 && input.now - (state.dueAt ?? 0) >= cfg.repeatMinutes * 60_000;
		if (state.dueAt && !again) return null;
		state.dueAt = input.now;
		return { stage: 'due', minutes: 0, state };
	}
	if (!cfg.leadMinutes || state.leadAt || w.untilDueMs === null) return null;
	if (w.untilDueMs > cfg.leadMinutes * 60_000) return null;
	state.leadAt = input.now;
	return { stage: 'lead', minutes: Math.max(1, Math.round(w.untilDueMs / 60_000)), state };
}

/** One look at a server's match, as far as the status shows it. */
export interface MatchLook {
	map: string;
	scores: { name: string; score: number }[];
	/** the match clock; live builds send none */
	matchSeconds: number | null;
}

/** The match a boundary closed: its final scores and who led them. */
export interface MatchEnd {
	map: string;
	scores: { name: string; score: number }[];
	/** the leader, when it scored; null for a tie or a match nobody scored in */
	winner: string | null;
	/** the leader, or every faction tied at the top; empty when nobody scored */
	leaders: string[];
}

/**
 * The match that ended between two looks, or null while it is the same match. A boundary is a
 * map change, the match clock going backwards, or the total score falling: KOTH scores only rise
 * during a round, so a lower total is a reset, and "lower" rather than "zero" also catches a look
 * that lands a tick into the next round with the scores already moving. No previous look (the
 * first after a start or an outage) is never a boundary.
 */
export function matchBoundary(prev: MatchLook | null, next: MatchLook): MatchEnd | null {
	if (!prev) return null;
	const total = (l: MatchLook) => l.scores.reduce((n, f) => n + f.score, 0);
	const clockBack =
		prev.matchSeconds !== null &&
		next.matchSeconds !== null &&
		next.matchSeconds < prev.matchSeconds - 30;
	if (prev.map === next.map && !clockBack && total(next) >= total(prev)) return null;
	const scores = [...prev.scores].sort((a, b) => b.score - a.score);
	const top = scores[0]?.score ?? 0;
	const leaders = top > 0 ? scores.filter((f) => f.score === top).map((f) => f.name) : [];
	return {
		map: prev.map,
		scores,
		winner: leaders.length === 1 ? leaders[0] : null,
		leaders
	};
}

/** A player's line of the match that ended, as far as the placeholders need it. */
export interface MatchLineVars {
	name: string;
	kills: number;
}

/**
 * The placeholders a match boundary fills: the result of the match that ended, and from the
 * players' lines of it, `{mvp}` (the most kills, tied players named together) and `{top}` (the
 * top three with their kills). Both are empty when nobody killed anyone.
 */
export function matchVars(
	end: MatchEnd,
	lines: MatchLineVars[] = []
): Record<string, string | number> {
	const top = end.scores[0]?.score ?? 0;
	const ranked = lines.filter((l) => l.kills > 0).sort((a, b) => b.kills - a.kills);
	const best = ranked[0]?.kills ?? 0;
	return {
		faction: end.leaders.join(' and '),
		score: top,
		scores: end.scores.map((f) => `${f.name} ${f.score}`).join(' · '),
		previous: end.map,
		mvp: ranked
			.filter((l) => l.kills === best)
			.map((l) => l.name)
			.join(' and '),
		top: ranked
			.slice(0, 3)
			.map((l) => `${l.name} ${l.kills}`)
			.join(' · ')
	};
}

/**
 * What a match broadcast sends at a boundary, end message first. The end message is skipped when
 * nobody scored (a reset from nil-all says nothing worth announcing); both need the player count.
 */
export function matchBroadcastMessages(
	cfg: MatchBroadcastConfig,
	end: MatchEnd,
	playerCount: number,
	vars: Record<string, string | number>,
	lines: MatchLineVars[] = []
): { stage: 'end' | 'start'; message: string }[] {
	if (playerCount < cfg.minPlayers) return [];
	const all = { ...vars, ...matchVars(end, lines) };
	const out: { stage: 'end' | 'start'; message: string }[] = [];
	if (cfg.endMessage && end.leaders.length)
		out.push({ stage: 'end', message: renderTemplate(cfg.endMessage, all) });
	if (cfg.startMessage)
		out.push({ stage: 'start', message: renderTemplate(cfg.startMessage, all) });
	return out;
}

export interface MatchSample {
	ts: number;
	ok: boolean;
	map: string;
	scores: { name: string; score: number }[];
	count: number;
}

/**
 * The match boundaries in a run of samples, for the dry run: each sample is compared with the one
 * before it, except across a failed sample or a gap longer than `maxHoldMs` (the worker was not
 * watching, and the live rule would not have seen the boundary either).
 */
export function matchReplay(
	rows: MatchSample[],
	maxHoldMs: number
): { ts: number; count: number; map: string; end: MatchEnd }[] {
	const out: { ts: number; count: number; map: string; end: MatchEnd }[] = [];
	let prev: MatchSample | null = null;
	for (const r of rows) {
		if (!r.ok) {
			prev = null;
			continue;
		}
		const look = { map: r.map, scores: r.scores, matchSeconds: null };
		if (prev && r.ts - prev.ts <= maxHoldMs) {
			const end = matchBoundary({ map: prev.map, scores: prev.scores, matchSeconds: null }, look);
			if (end) out.push({ ts: r.ts, count: r.count, map: r.map, end });
		}
		prev = r;
	}
	return out;
}

/** A player who has a faction now and did not have this one at the last look. */
export interface FactionPick<P> {
	player: P;
	/** the faction they had before; null for their first pick of the session (or they arrived with one) */
	from: string | null;
}

/** Who a welcome rule whispers on this tick: joiners, or first faction picks when it waits for them. */
export function welcomeTargets<P extends { steamId: string }>(
	cfg: Pick<WelcomeConfig, 'onlyFirstVisit' | 'afterFaction'>,
	tick: { joined: P[]; factioned: FactionPick<P>[]; firstVisit: Set<string> }
): P[] {
	const pool = cfg.afterFaction
		? tick.factioned.filter((f) => !f.from).map((f) => f.player)
		: tick.joined;
	return cfg.onlyFirstVisit ? pool.filter((p) => tick.firstVisit.has(p.steamId)) : pool;
}

/** Who a faction-change rule whispers: players who switched from one faction to another. */
export const factionChangeTargets = <P>(tick: { factioned: FactionPick<P>[] }): FactionPick<P>[] =>
	tick.factioned.filter((f) => !!f.from);

/** Fills {name}, {faction}, {previous}, {server}, {map}, {players}, {max} and the rest; unknown ones stay. */
export function renderTemplate(text: string, vars: Record<string, string | number>): string {
	const lower: Record<string, string> = {};
	for (const [k, v] of Object.entries(vars)) lower[k.toLowerCase()] = String(v);
	return text
		.replace(/\{([a-z_]+)\}/gi, (m, key: string) => lower[key.toLowerCase()] ?? m)
		.slice(0, MAX_MESSAGE);
}

export interface RiskKickSignals {
	profile: SteamProfileRow | null;
	steamEnabled: boolean;
	bannedOn: { serverName: string; reason: string }[];
	watched: { reason: string } | null;
	/** banned players whose last known name looks like this one; only the risk level uses it */
	resembles?: { name: string; steamId: string; serverName: string }[];
	reserved: boolean;
	performance?: RiskPerformance | null;
	now?: Date;
}

/** Why a joiner would be kicked under this config, or null when they pass. */
export function riskKickVerdict(cfg: RiskKickConfig, s: RiskKickSignals): string | null {
	if (s.reserved && cfg.spareReserved) return null;
	if (cfg.bannedElsewhere && s.bannedOn.length)
		return `banned on ${s.bannedOn[0].serverName}${s.bannedOn[0].reason ? ` (${s.bannedOn[0].reason})` : ''}`;
	if (cfg.watchlist && s.watched)
		return `on the watchlist${s.watched.reason ? ` (${s.watched.reason})` : ''}`;
	if (s.steamEnabled && s.profile && !s.profile.error) {
		const p = s.profile;
		// Configs saved before this setting existed have no property; they keep the old
		// behaviour of considering the player's full ban history.
		const maxBanAgeDays = cfg.maxBanAgeDays ?? 0;
		const banIsRecentEnough =
			maxBanAgeDays === 0 || p.daysSinceLastBan === null || p.daysSinceLastBan <= maxBanAgeDays;
		if (cfg.vacBans && p.vacBans > 0 && banIsRecentEnough)
			return `${p.vacBans} VAC ban${p.vacBans === 1 ? '' : 's'} on record`;
		if (cfg.gameBans && p.gameBans > 0 && banIsRecentEnough)
			return `${p.gameBans} game ban${p.gameBans === 1 ? '' : 's'} on record`;
		if (cfg.minAccountDays > 0) {
			const age = accountAgeDays(p.accountCreatedAt, s.now);
			if (age === null) {
				if (cfg.privateProfiles) return 'private profile, account age unknown';
			} else if (age < cfg.minAccountDays) {
				return `Steam account only ${age} day${age === 1 ? '' : 's'} old (minimum ${cfg.minAccountDays})`;
			}
		}
	}
	if (cfg.kickAtLevel) {
		const risk = assessRisk({
			profile: s.profile,
			steamEnabled: s.steamEnabled,
			watched: s.watched,
			bannedOn: s.bannedOn,
			resembles: s.resembles ?? [],
			performance: s.performance,
			now: s.now
		});
		const bad = risk.level === 'high' || (cfg.kickAtLevel === 'medium' && risk.level === 'medium');
		if (bad) {
			const why = [...risk.reasons]
				.sort((a, b) => b.weight - a.weight)
				.slice(0, 3)
				.map((r) => r.text)
				.join('; ');
			return `${risk.level} risk (${risk.score}): ${why}${risk.steamChecked ? '' : ' [Steam not checked]'}`;
		}
	}
	return null;
}

const sameExperiences = (a: string[], b: string[]) =>
	[...a].sort().join('+') === [...b].sort().join('+');

/** Is the server already on the reset target? Map, and the experiences when the rule names any. */
export const onTarget = (
	cfg: Pick<EmptyResetConfig, 'map' | 'experiences'>,
	current: { map: string; experiences: string[] }
) =>
	current.map === cfg.map &&
	(!cfg.experiences.length || sameExperiences(cfg.experiences, current.experiences));
