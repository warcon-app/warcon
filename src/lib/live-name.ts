// The Live server name rule's name: the server's own name with a short part appended, filled in
// from what the server shows at the look (each faction's score, the map, the player count). The
// worker writes it and the editor previews it with the same function. Pure and client-safe.
import { mapName } from './format';
import type { Status } from './types';

/** What the appended part can say: all read off the server's status, nothing a player types. */
export const LIVE_NAME_PLACEHOLDERS = ['scoreline', 'map', 'players', 'max'] as const;

/** The longest name the rule writes, and the longest server name and appended part it saves. */
export const LIVE_NAME_MAX = 100;
export const LIVE_NAME_APPEND_MAX = 60;
export const LIVE_NAME_APPEND_DEFAULT = '| {scoreline}';

export interface LiveNameConfig {
	/** the server's own name: written back when the rule is switched off */
	base: string;
	/** what follows it, after a space, with the placeholders above */
	append: string;
}

/**
 * Text on one line: every control character (a line break would start a new line of the config
 * document) becomes a space, and the ends are trimmed.
 */
export const oneLine = (text: string): string =>
	text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim();

/** At most `max` characters, never half an emoji. */
const cut = (text: string, max: number): string => Array.from(text).slice(0, max).join('');

type Look = Pick<Status, 'map' | 'playerCount' | 'maxPlayers' | 'scores'>;

/** The appended part's placeholders, from the server's status. */
export function liveNameVars(s: Look): Map<string, string> {
	return new Map([
		['scoreline', s.scores.map((f) => String(Math.max(0, Math.round(f.score)))).join('-')],
		['map', s.map ? mapName(s.map) : ''],
		['players', String(s.playerCount)],
		['max', String(s.maxPlayers)]
	]);
}

/**
 * The name the rule writes: the server's name, a space, then the appended part filled in. A name
 * it does not know stays as typed. One line, at most LIVE_NAME_MAX characters.
 */
export function liveName(cfg: LiveNameConfig, s: Look): string {
	const vars = liveNameVars(s);
	const tail = cfg.append.replace(
		/\{([a-z_]+)\}/gi,
		(whole, name: string) => vars.get(name.toLowerCase()) ?? whole
	);
	return cut(oneLine(`${oneLine(cfg.base)} ${oneLine(tail)}`), LIVE_NAME_MAX).trim();
}
