// Chat commands: what a player types to the server in the in-game chat, "!" and a word ("!rules",
// "!admin he is stuck at B"). A chat rule answers the words its organisation gave it and nothing
// else; a line that is not a command is nobody's business here and is never kept, counted or passed
// on. This is the reading of one line and of the words a rule may answer to. Pure and client-safe.
import type { ChatLine } from './chat-read';

/** What a command starts with. */
export const COMMAND_PREFIX = '!';
/** The longest command word. */
export const MAX_COMMAND_WORD = 20;
/** Other words a Chat command answers to, besides its own. */
export const MAX_COMMAND_ALIASES = 5;
/** Lines one Chat command answers with, each a whisper or a broadcast of its own. */
export const MAX_COMMAND_REPLIES = 4;
/** Words one Staff call rule answers to, calls and reports together. */
export const MAX_STAFF_WORDS = 6;

/**
 * A Staff call rule's words and texts until its organisation writes its own. The texts promise no
 * more than the panel knows: a call is passed on to Discord, and whether anyone reads it there is
 * not the panel's to say.
 */
export const STAFF_CALL_DEFAULTS = {
	commands: ['admin'],
	reports: ['report'],
	ack: 'Thanks {name}: your call is on its way to staff.',
	usage: 'Tell staff what is wrong: {command} <message>',
	wait: 'Your last call was passed on, {name}. You can send another in {seconds} s.',
	cooldownSeconds: 60
} as const;

/** How a chat rule's last result starts when an answer of its did not go out. */
export const NOT_ANSWERED = 'Not answered';

const WORD = new RegExp(`^[a-z0-9]{1,${MAX_COMMAND_WORD}}$`);

/** A command word as a rule keeps it: lower case, without the "!"; '' when it is not one. */
export function commandWord(raw: unknown): string {
	if (typeof raw !== 'string') return '';
	const word = raw.trim().replace(/^!/, '').toLowerCase();
	return WORD.test(word) ? word : '';
}

/** A command as it was typed: its word in lower case, and what followed it ('' for nothing). */
export interface TypedCommand {
	word: string;
	rest: string;
}

const TYPED = new RegExp(`^!([a-z0-9]{1,${MAX_COMMAND_WORD}})(?:\\s+(.*))?$`, 'i');

/** One text read as a command; null when it is not "!" and a word, alone or followed by a space. */
export function readCommand(text: string): TypedCommand | null {
	const m = TYPED.exec(text.trim());
	return m ? { word: m[1].toLowerCase(), rest: (m[2] ?? '').trim() } : null;
}

/**
 * The command a chat line is, or null: never a ping callout, never a line the game gives no
 * SteamID for (there is nobody to answer). Read from the line as the others saw it, and from what
 * was typed where the game's chat filter left no command of it.
 */
export function typedCommand(
	line: Pick<ChatLine, 'text' | 'typed' | 'ping' | 'steamId'>
): TypedCommand | null {
	if (line.ping || !line.steamId) return null;
	return readCommand(line.text) ?? (line.typed ? readCommand(line.typed) : null);
}

/** A rule's words as players type them, in one line: "!rules !discord !admin". */
export const commandsLine = (words: readonly string[]): string =>
	words.map((w) => COMMAND_PREFIX + w).join(' ');

const fold = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/** The player a report names, and how sure the naming is. */
export interface Named<P> {
	player: P;
	/** '' when the text names them outright; else the text they were guessed from */
	guess: string;
}

/**
 * The player a report names, from what followed the word. A SteamID typed out, or the one player
 * whose whole name the text starts with, is named outright. Anything less is a guess, and says what
 * it was guessed from: the longest of several whole names the text starts with ("Bob is" when Bob
 * is on too); else the one player whose name starts with the text's first word, or has it in it
 * (three characters or more, so "[ABC] Night Owl" answers to "owl", and "Panther" to "the"). Never
 * the caller, and null when nobody or more than one player fits: a report that names the wrong
 * player is worse than one that names none.
 */
export function namedPlayer<P extends { steamId: string; name: string }>(
	rest: string,
	players: readonly P[],
	caller: string
): Named<P> | null {
	const text = fold(rest);
	if (!text) return null;
	const others = players.filter((p) => p.steamId !== caller && fold(p.name));
	const id = /^(\d{17})(?!\d)/.exec(text)?.[1];
	if (id) {
		const player = others.find((p) => p.steamId === id);
		return player ? { player, guess: '' } : null;
	}
	const whole = others
		.filter((p) => {
			const name = fold(p.name);
			return text === name || text.startsWith(name + ' ');
		})
		.sort((a, b) => fold(b.name).length - fold(a.name).length);
	if (whole.length === 1) return { player: whole[0], guess: '' };
	if (whole.length)
		return fold(whole[0].name).length > fold(whole[1].name).length
			? { player: whole[0], guess: fold(whole[0].name) }
			: null;
	const first = text.split(' ')[0];
	if (Array.from(first).length < 3) return null;
	const starts = others.filter((p) => fold(p.name).startsWith(first));
	if (starts.length) return starts.length === 1 ? { player: starts[0], guess: first } : null;
	const holds = others.filter((p) => fold(p.name).includes(first));
	return holds.length === 1 ? { player: holds[0], guess: first } : null;
}
