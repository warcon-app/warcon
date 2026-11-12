// The placeholders automation messages and kick reasons take, as one catalogue: every message has
// the server's, every message to or about one player has the player's and their all-time stats,
// here and across the organisation, and a rule adds its own (a team kill's victim, a seeding
// reward's expiry). The editor offers a rule these groups; the worker fills the same names
// (message-vars.ts). Pure and client-safe.
import type { TriggerKind } from './types';

/** The server, as the look that sends the message sees it. */
export const SERVER_PLACEHOLDERS = [
	'server',
	'map',
	'players',
	'max',
	'scores',
	'cap',
	'uptime'
] as const;

/** The player a message is to or about. */
export const PLAYER_PLACEHOLDERS = ['name', 'faction', 'steamid', 'ping'] as const;

/** The player's line on this server's all-time leaderboard: read only for a message that uses one. */
export const STATS_PLACEHOLDERS = [
	'kills',
	'deaths',
	'kd',
	'playtime',
	'matches',
	'wins',
	'winrate',
	'seeded'
] as const;

/**
 * The same over every server of the organisation. A player is told their own, and nobody else
 * reads them: no rule whose text is kept where staff read it offers them (`MessageRule.kept`).
 */
export const ORG_STATS_PLACEHOLDERS = [
	'org_kills',
	'org_deaths',
	'org_kd',
	'org_playtime',
	'org_matches',
	'org_wins',
	'org_winrate',
	'org_seeded'
] as const;

/** Other names people type for a placeholder. */
export const PLACEHOLDER_ALIASES: Readonly<Record<string, string>> = {
	player: 'name',
	kdr: 'kd',
	org_kdr: 'org_kd'
};

/**
 * A rule's messages: the config keys that hold them (all filled alike), the placeholders the rule
 * itself fills, and whether they are to or about one player.
 */
interface MessageRule {
	fields: readonly string[];
	own: readonly string[];
	player: boolean;
	/** its text can be kept where staff read it (a Kill distance reason becomes a ban reason), or is
	 *  said to the whole server (a Bounty's), so it has no org-wide stats: staff of this server may
	 *  not see the organisation's other servers, and a player's are told to them alone */
	kept?: boolean;
	/** its messages are about something else than how the player plays (a Staff call's): it offers
	 *  no stats, and none is read for it */
	noStats?: boolean;
}

/** Every rule that sends a message or a kick reason. */
export const MESSAGE_RULES: Readonly<Partial<Record<TriggerKind, MessageRule>>> = {
	welcome: { fields: ['message'], own: [], player: true },
	faction_change: { fields: ['message'], own: ['previous'], player: true },
	// who killed the player, with what, from how far: blank where it does not apply (a fall)
	death_whisper: { fields: ['messages'], own: ['killer', 'weapon', 'distance'], player: true },
	broadcast: { fields: ['messages'], own: [], player: false },
	restart_notice: { fields: ['leadMessage', 'message'], own: ['minutes'], player: false },
	// the result of the match that ended, and from its players' lines the best of them
	match_broadcast: {
		fields: ['endMessage', 'startMessage'],
		own: ['faction', 'score', 'scores', 'previous', 'mvp', 'top'],
		player: false
	},
	risk_kick: { fields: ['reason'], own: [], player: true },
	name_filter: { fields: ['reason'], own: ['why'], player: true },
	ping_kick: { fields: ['reason'], own: [], player: true },
	// how long the player has been idle, and the idle time the rule acts at (both whole minutes)
	afk_watch: { fields: ['warnMessage', 'reason'], own: ['idle', 'limit'], player: true },
	team_kill: { fields: ['warnMessage', 'kickReason'], own: ['victim', 'count'], player: true },
	two_teams: { fields: ['message'], own: ['team'], player: true },
	kill_distance: {
		fields: ['reason'],
		own: ['weapon', 'distance', 'count'],
		player: true,
		kept: true
	},
	seed_reward: { fields: ['message'], own: ['minutes', 'until', 'days'], player: true },
	afk_protection: { fields: ['message', 'doneMessage'], own: ['goal'], player: false },
	// the name the player had before the change
	name_change: { fields: ['reason'], own: ['previous'], player: true },
	// said to the whole server, so no org-wide stats: `{name}` is the marked player when the bounty is
	// set and the claimer after, `{target}` always the marked player
	bounty: {
		fields: ['setMessage', 'claimMessage', 'whisper'],
		own: ['target', 'streak', 'reward', 'days', 'until'],
		player: true,
		kept: true
	},
	// a reply to a word a player typed in chat: this server's words, how many are on each side, the
	// map up next and the maps in turn, the player's place on this server's board and its first three
	chat_command: {
		fields: ['replies'],
		own: ['commands', 'teams', 'next_map', 'rotation', 'rank', 'top'],
		player: true
	},
	// the word the player typed (one of the rule's own), and the seconds left before their next call
	staff_call: {
		fields: ['ack', 'usage', 'wait'],
		own: ['command', 'seconds'],
		player: true,
		noStats: true
	}
};

export type PlaceholderGroupKey = 'own' | 'player' | 'stats' | 'org' | 'server';

export interface PlaceholderGroup {
	key: PlaceholderGroupKey;
	names: string[];
}

/**
 * What a rule's messages fill, in the groups the editor shows; a name appears once, in its first.
 * `said`: the text is said to the whole server (a Chat command's reply to everyone), so it has no
 * org-wide stats, as a rule whose text is `kept` has none.
 */
export function placeholdersFor(kind: TriggerKind, said = false): PlaceholderGroup[] {
	const r = MESSAGE_RULES[kind];
	if (!r) return [];
	const taken = new Set(r.own);
	const rest = (names: readonly string[]) => names.filter((n) => !taken.has(n));
	const groups: PlaceholderGroup[] = [{ key: 'own', names: [...r.own] }];
	if (r.player)
		groups.push(
			{ key: 'player', names: rest(PLAYER_PLACEHOLDERS) },
			{ key: 'stats', names: r.noStats ? [] : rest(STATS_PLACEHOLDERS) },
			{ key: 'org', names: r.kept || r.noStats || said ? [] : rest(ORG_STATS_PLACEHOLDERS) }
		);
	groups.push({ key: 'server', names: rest(SERVER_PLACEHOLDERS) });
	return groups.filter((g) => g.names.length);
}

/** The placeholder pattern the worker fills: letters and underscores in single braces, any case. */
const TOKEN = /\{([a-z_]+)\}/gi;

const ALIASES = new Map(Object.entries(PLACEHOLDER_ALIASES));

/** The name a placeholder is filled under, whatever case or other name it was typed with. */
export const canonical = (name: string): string => {
	const lower = name.toLowerCase();
	return ALIASES.get(lower) ?? lower;
};

/** The placeholders in these texts that the rule's messages do not fill, as typed, each once. */
export function unfilled(texts: string[], kind: TriggerKind, said = false): string[] {
	const filled = new Set(placeholdersFor(kind, said).flatMap((g) => g.names));
	const out = new Map<string, string>();
	for (const text of texts)
		for (const [token, name] of text.matchAll(TOKEN))
			if (!filled.has(canonical(name)) && !out.has(token.toLowerCase()))
				out.set(token.toLowerCase(), token);
	return [...out.values()];
}

const STATS = new Set<string>(STATS_PLACEHOLDERS);
const ORG_STATS = new Set<string>(ORG_STATS_PLACEHOLDERS);

/** Which stats a text uses, this server's and the organisation's: each costs a read. */
export function statsIn(text: string): { here: boolean; org: boolean } {
	const out = { here: false, org: false };
	for (const [, name] of text.matchAll(TOKEN)) {
		const n = canonical(name);
		if (STATS.has(n)) out.here = true;
		else if (ORG_STATS.has(n)) out.org = true;
	}
	return out;
}

/** Whether a text tells a player any of their stats. */
export const usesStats = (text: string): boolean => {
	const s = statsIn(text);
	return s.here || s.org;
};
