// The values behind the message placeholders ($lib/placeholders): the server as a look sees it,
// the player a message is to or about, and that player's all-time stats, on this server and over
// every server of its organisation, as the leaderboards count them. Pure: the stats arrive already
// read (playerStats in leaderboards.ts), the rest from what the worker holds. Every rule's messages
// are filled from here, live and in the dry run, so a placeholder means the same thing in each.
import { fmtMinutes, mapName } from '$lib/format';
import { kdRatio, winRate } from '$lib/leaderboard';
import { scoreCapOf } from '$lib/match';
import {
	ORG_STATS_PLACEHOLDERS,
	ORG_WIDE_PLACEHOLDERS,
	PLACEHOLDER_ALIASES,
	PLAYER_PLACEHOLDERS,
	STATS_PLACEHOLDERS
} from '$lib/placeholders';
import { fmtUptime } from '$lib/uptime';
import type { Status } from '$lib/types';

export type MessageVars = Record<string, string | number>;

/** What a placeholder says when its value is not known: stats that could not be read, a value a
 *  dry run does not replay. A placeholder that does not apply (a player's in a broadcast) is blank. */
export const UNKNOWN = '…';

/** A player's line on an all-time leaderboard, as far as the placeholders need it. */
export interface PlayerStats {
	kills: number;
	deaths: number;
	/** time on the server, seed time included */
	minutes: number;
	seedMinutes: number;
	matches: number;
	wins: number;
	losses: number;
	draws: number;
}

/** A player the server has never recorded. */
export const NO_STATS: PlayerStats = {
	kills: 0,
	deaths: 0,
	minutes: 0,
	seedMinutes: 0,
	matches: 0,
	wins: 0,
	losses: 0,
	draws: 0
};

/** A player's stats on this server and across the organisation; a side left out was not read. */
export interface StatsBy {
	here?: PlayerStats | null;
	org?: PlayerStats | null;
}

/** The player a message is to or about. */
export interface MessagePlayer {
	name: string;
	steamId: string;
	faction: string | null;
	ping?: number | null;
}

/** As much of the server's status as its placeholders read. */
type ServerLook = Partial<
	Pick<Status, 'serverName' | 'map' | 'playerCount' | 'maxPlayers' | 'scoreCap'> & {
		scores: { name: string; score: number }[];
	}
>;

/** The server's placeholders. `startedAt` is when the game started (0 while unknown). */
export function serverVars(look: {
	name: string;
	status: ServerLook | null;
	startedAt: number;
	now: number;
}): MessageVars {
	const s = look.status;
	return {
		server: s?.serverName || look.name,
		map: s?.map ? mapName(s.map) : '',
		players: s?.playerCount ?? 0,
		max: s?.maxPlayers ?? 0,
		scores: (s?.scores ?? []).map((f) => `${f.name} ${f.score}`).join(' · '),
		cap: scoreCapOf(s as Pick<Status, 'scoreCap'> | null),
		uptime: look.startedAt ? fmtUptime(look.now - look.startedAt) : UNKNOWN
	};
}

/** One leaderboard line, its names behind `prefix` (`org_` for the organisation's), `…` unread. */
function statsVars(prefix: '' | 'org_', s: PlayerStats | null | undefined): MessageVars {
	const line: Record<(typeof STATS_PLACEHOLDERS)[number], string | number> | null = s
		? {
				kills: s.kills,
				deaths: s.deaths,
				kd: (kdRatio(s.kills, s.deaths) ?? 0).toFixed(2),
				playtime: fmtMinutes(s.minutes),
				matches: s.matches,
				wins: s.wins,
				winrate: `${Math.round((winRate(s.wins, s.losses, s.draws) ?? 0) * 100)}%`,
				seeded: fmtMinutes(s.seedMinutes)
			}
		: null;
	return Object.fromEntries(STATS_PLACEHOLDERS.map((n) => [prefix + n, line ? line[n] : UNKNOWN]));
}

/** The player's placeholders and their stats'; blank without a player, `…` for stats not read. */
export function playerVars(p: MessagePlayer | null, stats: StatsBy = {}): MessageVars {
	if (!p)
		return Object.fromEntries(
			[...PLAYER_PLACEHOLDERS, ...STATS_PLACEHOLDERS, ...ORG_STATS_PLACEHOLDERS].map((name) => [
				name,
				''
			])
		);
	const ping = typeof p.ping === 'number' && Number.isFinite(p.ping) ? Math.round(p.ping) : UNKNOWN;
	return {
		name: p.name,
		faction: p.faction ?? '',
		steamid: p.steamId,
		ping,
		...statsVars('', stats.here),
		...statsVars('org_', stats.org)
	};
}

/**
 * Everything a message fills: the server's, the player's (blank when it has none), then what the
 * rule itself decided, which wins over a general name it shares (a match broadcast's `{faction}` is
 * the winner).
 */
export function messageVars(
	server: MessageVars,
	player: MessagePlayer | null,
	stats: StatsBy = {},
	own: MessageVars = {}
): MessageVars {
	const all: MessageVars = { ...server, ...playerVars(player, stats), ...own };
	for (const [alias, name] of Object.entries(PLACEHOLDER_ALIASES))
		if (all[name] !== undefined) all[alias] = all[name];
	return all;
}

/**
 * The placeholders of a dry run, which replays history rather than a look: the server's name and
 * the player's name and SteamID are known, what the look would have shown is `…` unless the replay
 * has it (`known`).
 */
export function dryRunVars(
	serverName: string,
	player: { name: string; steamId: string } | null,
	known: MessageVars = {}
): MessageVars {
	const server: MessageVars = {
		server: serverName,
		map: UNKNOWN,
		players: UNKNOWN,
		max: UNKNOWN,
		scores: UNKNOWN,
		cap: UNKNOWN,
		uptime: UNKNOWN
	};
	const p = player
		? {
				...playerVars({ name: player.name, steamId: player.steamId, faction: null }),
				faction: UNKNOWN
			}
		: {};
	return messageVars(server, null, {}, { ...p, ...known });
}

/**
 * The placeholders of a text kept where staff read it (a Kill distance reason becomes a ban
 * reason), or said to the whole server: nothing across the organisation is a placeholder there (the
 * player's org-wide stats, a Chat command's `{org_rank}`), so it goes as typed.
 */
export function keptVars(vars: MessageVars): MessageVars {
	const org = new Set<string>(ORG_WIDE_PLACEHOLDERS);
	const out = { ...vars };
	for (const [alias, name] of Object.entries(PLACEHOLDER_ALIASES))
		if (org.has(name)) org.add(alias);
	for (const name of org) delete out[name];
	return out;
}
