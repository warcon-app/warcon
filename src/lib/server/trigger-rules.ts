// The pure part of automation: trigger settings, their validation, message templates and the
// kick-on-connect verdict. No database, no game server, so it is unit-testable on its own;
// triggers.ts holds the engine that runs these against live ticks.
import { ApiError, int, str } from './http';
import { accountAgeDays } from './risk';
import type { SteamProfileRow } from './db/schema';
import type { TriggerKind } from '$lib/types';

export const TRIGGER_KINDS: TriggerKind[] = ['welcome', 'broadcast', 'empty_reset', 'risk_kick'];
export const TRIGGER_LABELS: Record<TriggerKind, string> = {
	welcome: 'Welcome whisper',
	broadcast: 'Scheduled broadcast',
	empty_reset: 'Empty-server map reset',
	risk_kick: 'Kick on connect risk'
};

export interface WelcomeConfig {
	message: string;
	onlyFirstVisit: boolean;
}
export interface BroadcastConfig {
	messages: string[];
	everyMinutes: number;
	minPlayers: number;
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
	minAccountDays: number;
	privateProfiles: boolean;
	bannedElsewhere: boolean;
	watchlist: boolean;
	spareReserved: boolean;
	reason: string;
}
export type TriggerConfig = WelcomeConfig | BroadcastConfig | EmptyResetConfig | RiskKickConfig;

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
			return { message, onlyFirstVisit: !!c.onlyFirstVisit };
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
			return { messages, everyMinutes, minPlayers: int(c.minPlayers, 1, 0, 1000) };
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
				minAccountDays: int(c.minAccountDays, 0, 0, 3650),
				privateProfiles: !!c.privateProfiles,
				bannedElsewhere: !!c.bannedElsewhere,
				watchlist: !!c.watchlist,
				spareReserved: c.spareReserved === undefined ? true : !!c.spareReserved,
				reason:
					str(c.reason, MAX_MESSAGE) || 'Your account does not meet this server’s requirements.'
			};
			if (
				!cfg.vacBans &&
				!cfg.gameBans &&
				!cfg.minAccountDays &&
				!cfg.bannedElsewhere &&
				!cfg.watchlist
			)
				throw new ApiError(400, 'Turn on at least one rule.');
			return cfg;
		}
	}
}

/** Fills {name}, {server}, {map}, {players} and {max} placeholders; unknown ones stay. */
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
	reserved: boolean;
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
		if (cfg.vacBans && p.vacBans > 0)
			return `${p.vacBans} VAC ban${p.vacBans === 1 ? '' : 's'} on record`;
		if (cfg.gameBans && p.gameBans > 0)
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
