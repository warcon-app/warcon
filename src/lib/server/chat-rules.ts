// The chat rules (kinds `chat_command` and `staff_call`), the pure part: their settings, the words
// a server's rules answer to, and what one read of the chat brings. A Chat command answers a word
// a player types ("!rules") with its organisation's own lines, to that player or to everyone. A
// Staff call sends what a player types after its words ("!admin he is stuck at B") to the
// organisation's Discord and tells the player so.
//
// Nothing a player typed is repeated by the server: no placeholder carries it, so a command cannot
// make the server say a player's words. And nothing typed is kept: the step below reads the lines
// of one look, decides, and hands back what to send; the worker (chat-look.ts) sends it in the
// same look and holds only when each rule last answered whom. No database, no game server here.
import { ApiError, int } from './http';
import { MAX_CHAT } from '$lib/chat';
import { mapName } from '$lib/format';
import { oneLine } from '$lib/saved-messages';
import type { ChatLine } from '$lib/chat-read';
import {
	COMMAND_PREFIX,
	commandWord,
	MAX_COMMAND_ALIASES,
	MAX_COMMAND_REPLIES,
	MAX_COMMAND_WORD,
	MAX_STAFF_WORDS,
	STAFF_CALL_DEFAULTS,
	typedCommand
} from '$lib/chat-commands';
import { UNKNOWN } from './message-vars';
import type { TriggerKind } from '$lib/types';

export type ChatKind = 'chat_command' | 'staff_call';
export const isChatKind = (kind: TriggerKind | string): kind is ChatKind =>
	kind === 'chat_command' || kind === 'staff_call';

/** The longest wait a rule can put between two answers. */
export const CHAT_MAX_COOLDOWN = 3600;
/** A reply said to the whole server waits at least this long before the next. */
export const SAID_MIN_COOLDOWN = 10;
/** A player's calls to staff are at least this far apart. */
export const CALL_MIN_COOLDOWN = 10;

export interface ChatCommandConfig {
	/** the word players type after "!", in lower case */
	command: string;
	/** other words that bring the same answer */
	aliases: string[];
	/** what it answers: a line a message, sent in order */
	replies: string[];
	/** whispered to the player who typed it, or said to the whole server */
	to: 'player' | 'everyone';
	/** the least time between two answers: to the same player, or (said to everyone) at all */
	cooldownSeconds: number;
}

export interface StaffCallConfig {
	/** words that send what follows them to staff */
	commands: string[];
	/** words that report a player: what follows starts with their name, looked up on the list */
	reports: string[];
	/** whispered to the player once the call is on its way to Discord; '' for nothing */
	ack: string;
	/** whispered when nothing followed the word; '' for nothing */
	usage: string;
	/** whispered when the player's last call is too recent; '' for nothing */
	wait: string;
	/** the least time between two calls from one player */
	cooldownSeconds: number;
}

const NOT_A_WORD = `A command is one word of letters and digits, up to ${MAX_COMMAND_WORD} long, such as rules.`;

/**
 * A list of command words as typed: an array, or one text with spaces, commas or lines between.
 * Each word once; `tooMany` is refused as soon as there are more than `max`, so a list of any
 * length costs no more than its reading.
 */
function wordList(raw: unknown, max: number, tooMany: string): string[] {
	const list = Array.isArray(raw) ? raw : String(raw ?? '').split(/[\s,]+/);
	const out = new Set<string>();
	for (const item of list) {
		if (typeof item === 'string' && !item.trim()) continue;
		const word = commandWord(item);
		if (!word)
			throw new ApiError(400, `"${String(item).slice(0, 30)}" is not a command. ${NOT_A_WORD}`);
		out.add(word);
		if (out.size > max) throw new ApiError(400, tooMany);
	}
	return [...out];
}

export function validateChatCommand(c: Record<string, unknown>): ChatCommandConfig {
	const command = commandWord(c.command);
	if (!command) throw new ApiError(400, `Say which word it answers. ${NOT_A_WORD}`);
	const tooMany = `A command answers to at most ${MAX_COMMAND_ALIASES} other words.`;
	// one more than the most, for the command's own word among them
	const aliases = wordList(c.aliases, MAX_COMMAND_ALIASES + 1, tooMany).filter(
		(w) => w !== command
	);
	if (aliases.length > MAX_COMMAND_ALIASES) throw new ApiError(400, tooMany);
	const list = Array.isArray(c.replies) ? c.replies : String(c.replies ?? '').split('\n');
	// each on one line and cut to what the game takes
	const replies = list.map((m) => oneLine(m, MAX_CHAT)).filter(Boolean);
	if (!replies.length) throw new ApiError(400, 'Add the reply.');
	if (replies.length > MAX_COMMAND_REPLIES)
		throw new ApiError(
			400,
			`A reply is at most ${MAX_COMMAND_REPLIES} lines: each one is a message of its own.`
		);
	const to = c.to === 'everyone' ? 'everyone' : 'player';
	const cooldownSeconds = int(c.cooldownSeconds, to === 'everyone' ? 60 : 10, 0, CHAT_MAX_COOLDOWN);
	if (to === 'everyone' && cooldownSeconds < SAID_MIN_COOLDOWN)
		throw new ApiError(
			400,
			`A reply said to everyone waits at least ${SAID_MIN_COOLDOWN} seconds before the next.`
		);
	return { command, aliases, replies, to, cooldownSeconds };
}

export function validateStaffCall(c: Record<string, unknown>): StaffCallConfig {
	// a rule that names neither list starts from the usual two words
	const fresh = c.commands === undefined && c.reports === undefined;
	const tooMany = `A Staff call answers to at most ${MAX_STAFF_WORDS} words.`;
	const commands = fresh
		? [...STAFF_CALL_DEFAULTS.commands]
		: wordList(c.commands, MAX_STAFF_WORDS, tooMany);
	const reports = fresh
		? [...STAFF_CALL_DEFAULTS.reports]
		: wordList(c.reports, MAX_STAFF_WORDS, tooMany);
	const both = commands.find((w) => reports.includes(w));
	if (both)
		throw new ApiError(
			400,
			`${COMMAND_PREFIX}${both} is in both lists: a word calls staff or reports a player.`
		);
	if (!commands.length && !reports.length)
		throw new ApiError(400, 'Add at least one word that calls staff, such as admin.');
	if (commands.length + reports.length > MAX_STAFF_WORDS) throw new ApiError(400, tooMany);
	const cooldownSeconds = int(
		c.cooldownSeconds,
		STAFF_CALL_DEFAULTS.cooldownSeconds,
		0,
		CHAT_MAX_COOLDOWN
	);
	if (cooldownSeconds < CALL_MIN_COOLDOWN)
		throw new ApiError(
			400,
			`A player's calls are at least ${CALL_MIN_COOLDOWN} seconds apart (cooldownSeconds).`
		);
	// absent: the usual text; blank: none
	const text = (v: unknown, usual: string) => (v === undefined ? usual : oneLine(v, MAX_CHAT));
	return {
		commands,
		reports,
		ack: text(c.ack, STAFF_CALL_DEFAULTS.ack),
		usage: text(c.usage, STAFF_CALL_DEFAULTS.usage),
		wait: text(c.wait, STAFF_CALL_DEFAULTS.wait),
		cooldownSeconds
	};
}

/**
 * What a chat rule waits for before it can read the chat ('' when it reads it): the game's chat
 * terms to be accepted, a build that serves the chat, or a read that keeps failing to succeed.
 */
export type ChatWait = '' | 'terms' | 'build' | 'failing';
/** What a chat rule's row keeps of where it stands (the trigger's `state`). */
export interface ChatRuleState {
	wait: ChatWait;
}
export function chatWaitOf(state: unknown): ChatWait | null {
	const wait = (state as { wait?: unknown } | null)?.wait;
	return wait === '' || wait === 'terms' || wait === 'build' || wait === 'failing' ? wait : null;
}
/** How every wait starts in words: a last result that starts so is a wait (chat-look.ts). */
export const WAITING = 'Waiting:';
/** The same in words, for the rule's last result. */
export const CHAT_WAIT_WORDS: Record<ChatWait, string> = {
	'': 'Reading the chat.',
	terms: `${WAITING} the game's chat terms have not been accepted on this server (Chat tab).`,
	build: `${WAITING} this server's build does not serve the in-game chat.`,
	failing: `${WAITING} the chat cannot be read right now. The rule answers again once it can.`
};

/** A chat rule as the step reads it: a trigger row, or a rule about to be saved. */
export interface ChatRule {
	id: string;
	name: string;
	kind: ChatKind;
	config: ChatCommandConfig | StaffCallConfig;
}

/** Every word a rule answers to, its own first. */
export function chatWords(kind: ChatKind, config: unknown): string[] {
	if (kind === 'chat_command') {
		const c = config as Partial<ChatCommandConfig> | null;
		return [c?.command, ...(Array.isArray(c?.aliases) ? c.aliases : [])].filter(
			(w): w is string => typeof w === 'string' && !!w
		);
	}
	const c = config as Partial<StaffCallConfig> | null;
	return [
		...(Array.isArray(c?.commands) ? c.commands : []),
		...(Array.isArray(c?.reports) ? c.reports : [])
	].filter((w): w is string => typeof w === 'string' && !!w);
}

/**
 * The first word of `rule` that another of the server's enabled chat rules already answers, with
 * that rule's name; null when none does. A word has one answer on a server.
 */
export function wordClash(
	rule: Pick<ChatRule, 'id' | 'kind' | 'config'>,
	others: readonly ChatRule[]
): { word: string; rule: string } | null {
	const mine = chatWords(rule.kind, rule.config);
	for (const other of others) {
		if (other.id === rule.id) continue;
		const theirs = new Set(chatWords(other.kind, other.config));
		const word = mine.find((w) => theirs.has(w));
		if (word) return { word, rule: other.name };
	}
	return null;
}

/** What a word does on a server: the rule that answers it, and whether it reports a player. */
export interface WordUse {
	rule: ChatRule;
	report: boolean;
}

/** The words a server's chat rules answer to. Should two rules hold one word, the first has it. */
export function wordsOf(rules: readonly ChatRule[]): Map<string, WordUse> {
	const out = new Map<string, WordUse>();
	for (const rule of rules) {
		const reports =
			rule.kind === 'staff_call' ? new Set((rule.config as StaffCallConfig).reports) : null;
		for (const word of chatWords(rule.kind, rule.config))
			if (!out.has(word)) out.set(word, { rule, report: !!reports?.has(word) });
	}
	return out;
}

/** The words `{commands}` lists: each Chat command's own word and every word that calls staff. */
export function listedWords(rules: readonly ChatRule[]): string[] {
	const out: string[] = [];
	for (const rule of rules) {
		const words =
			rule.kind === 'chat_command'
				? [(rule.config as ChatCommandConfig).command]
				: chatWords(rule.kind, rule.config);
		for (const w of words) if (w && !out.includes(w)) out.push(w);
	}
	return out;
}

// ---- the step -----------------------------------------------------------------------------------

/** Commands one player may have answered in a minute; past that the rules are silent to them. */
export const CHAT_COMMANDS_PER_MINUTE = 6;
/** Messages the rules send one server in one look, at most: the look holds the server's lane. */
export const CHAT_SENDS_PER_LOOK = 8;
/** Messages the rules send one server in a minute, at most. */
export const CHAT_SENDS_PER_MINUTE = 60;
const MINUTE_MS = 60_000;

/** What the rules remember of a server between looks: times only, never a line. */
export interface ChatTracks {
	/** when each rule last answered each player */
	players: Map<string, Map<string, number>>;
	/** when each rule that answers everyone last did */
	said: Map<string, number>;
	/** each player's commands of the last minute, by when they were taken */
	typed: Map<string, number[]>;
	/** the messages sent to this server in the last minute, by when */
	sent: number[];
}

export const newChatTracks = (): ChatTracks => ({
	players: new Map(),
	said: new Map(),
	typed: new Map(),
	sent: []
});

/** One thing to do about one line; `sends` is the most messages it puts to the game. */
export type ChatAct = { rule: ChatRule; line: ChatLine; word: string; sends: number } & (
	| { type: 'reply'; cfg: ChatCommandConfig }
	| { type: 'call'; cfg: StaffCallConfig; rest: string; report: boolean; ack: boolean }
	| { type: 'usage'; cfg: StaffCallConfig }
	| { type: 'wait'; cfg: StaffCallConfig; seconds: number }
);

/** Commands a step let go, by why: for the tests, and nothing else counts them. */
export interface ChatPassed {
	/** the player had their commands for the minute */
	capped: number;
	/** inside the rule's wait */
	cooling: number;
	/** more than the look, or the minute, may send */
	cut: number;
}

/** How many messages the rules may still send the server in this look. */
export function sendsLeft(tracks: ChatTracks, now: number): number {
	tracks.sent = tracks.sent.filter((t) => now - t < MINUTE_MS);
	return Math.max(0, Math.min(CHAT_SENDS_PER_LOOK, CHAT_SENDS_PER_MINUTE - tracks.sent.length));
}

/**
 * What one read's new lines bring, oldest first, moving the memory on as it decides: a line that is
 * no command, or a word no rule of the server answers, is passed without a trace; a player gets
 * CHAT_COMMANDS_PER_MINUTE answers a minute; a Chat command answers a player (or, said to everyone,
 * the server) once in its wait; a Staff call takes a player's call once in its wait and says so
 * when they call sooner. `budget` is what the look may still send (sendsLeft): an answer that does
 * not fit is let go whole and costs the player nothing, but a call still goes to Discord without
 * its whisper back.
 */
export function chatStep(
	words: ReadonlyMap<string, WordUse>,
	tracks: ChatTracks,
	lines: readonly ChatLine[],
	now: number,
	budget: number
): { acts: ChatAct[]; passed: ChatPassed } {
	const acts: ChatAct[] = [];
	const passed: ChatPassed = { capped: 0, cooling: 0, cut: 0 };
	if (!words.size) return { acts, passed };
	const answered = (ruleId: string, steamId: string) => tracks.players.get(ruleId)?.get(steamId);
	const answer = (ruleId: string, steamId: string) => {
		const by = tracks.players.get(ruleId) ?? new Map<string, number>();
		by.set(steamId, now);
		tracks.players.set(ruleId, by);
	};
	for (const line of lines) {
		const typed = typedCommand(line);
		const use = typed && words.get(typed.word);
		if (!typed || !use) continue;
		const { rule } = use;
		const recent = (tracks.typed.get(line.steamId) ?? []).filter((t) => now - t < MINUTE_MS);
		if (recent.length >= CHAT_COMMANDS_PER_MINUTE) {
			passed.capped++;
			continue;
		}
		const take = (act: ChatAct) => {
			recent.push(now);
			tracks.typed.set(line.steamId, recent);
			budget -= act.sends;
			acts.push(act);
		};
		const base = { rule, line, word: typed.word };
		if (rule.kind === 'chat_command') {
			const cfg = rule.config as ChatCommandConfig;
			const last =
				cfg.to === 'everyone' ? tracks.said.get(rule.id) : answered(rule.id, line.steamId);
			if (last !== undefined && now - last < cfg.cooldownSeconds * 1000) {
				passed.cooling++;
				continue;
			}
			if (cfg.replies.length > budget) {
				passed.cut++;
				continue;
			}
			if (cfg.to === 'everyone') tracks.said.set(rule.id, now);
			else answer(rule.id, line.steamId);
			take({ ...base, type: 'reply', cfg, sends: cfg.replies.length });
			continue;
		}
		const cfg = rule.config as StaffCallConfig;
		if (!typed.rest) {
			if (!cfg.usage) continue;
			if (budget < 1) passed.cut++;
			else take({ ...base, type: 'usage', cfg, sends: 1 });
			continue;
		}
		const last = answered(rule.id, line.steamId);
		const left = last === undefined ? 0 : cfg.cooldownSeconds * 1000 - (now - last);
		if (left > 0) {
			passed.cooling++;
			if (cfg.wait && budget >= 1)
				take({ ...base, type: 'wait', cfg, sends: 1, seconds: Math.ceil(left / 1000) });
			continue;
		}
		answer(rule.id, line.steamId);
		const ack = !!cfg.ack && budget >= 1;
		take({
			...base,
			type: 'call',
			cfg,
			rest: typed.rest,
			report: use.report,
			ack,
			sends: ack ? 1 : 0
		});
	}
	return { acts, passed };
}

/**
 * Forgets what no wait needs any more: a player past every rule's longest wait, a rule that is
 * gone, a player with no command in the last minute.
 */
export function pruneChatTracks(tracks: ChatTracks, rules: readonly ChatRule[], now: number): void {
	const live = new Map(rules.map((r) => [r.id, r]));
	for (const [ruleId, by] of tracks.players) {
		const rule = live.get(ruleId);
		if (!rule) {
			tracks.players.delete(ruleId);
			continue;
		}
		const keep = (rule.config.cooldownSeconds || 0) * 1000;
		for (const [steamId, at] of by) if (now - at >= keep) by.delete(steamId);
		if (!by.size) tracks.players.delete(ruleId);
	}
	for (const ruleId of tracks.said.keys()) if (!live.has(ruleId)) tracks.said.delete(ruleId);
	for (const [steamId, times] of tracks.typed) {
		const recent = times.filter((t) => now - t < MINUTE_MS);
		if (recent.length) tracks.typed.set(steamId, recent);
		else tracks.typed.delete(steamId);
	}
	tracks.sent = tracks.sent.filter((t) => now - t < MINUTE_MS);
}

// ---- what a Chat command's own placeholders say ---------------------------------------------------

const TOKEN = /\{([a-z_]+)\}/gi;
const usesCache = new WeakMap<ChatCommandConfig, Set<string>>();

/** The placeholders a Chat command's replies name, in lower case as typed. */
export function repliesUse(cfg: ChatCommandConfig): ReadonlySet<string> {
	let uses = usesCache.get(cfg);
	if (!uses)
		usesCache.set(
			cfg,
			(uses = new Set(
				cfg.replies.flatMap((r) => [...r.matchAll(TOKEN)].map(([, n]) => n.toLowerCase()))
			))
		);
	return uses;
}

/**
 * `{teams}`: how many players are on each side, the sides in the scoreboard's order ("Lonestar 34 ·
 * Valkyra 33 · Manticore 31"). A side the scoreboard does not list (the game's holding team between
 * matches) is no side.
 */
export function teamsLine(
	players: readonly { faction: string | null }[],
	sides: readonly string[]
): string {
	const names = sides.length
		? sides
		: [...new Set(players.map((p) => p.faction).filter((f): f is string => !!f))].sort();
	return names
		.map((side) => `${side} ${players.filter((p) => p.faction === side).length}`)
		.join(' · ');
}

/**
 * `{next_map}` and `{rotation}` from the server's rotation: the map up next (`…` when the game does
 * not say), and its maps in the order they first come up, each once.
 */
export function rotationVars(
	entries: readonly { map: string; denied?: boolean }[],
	next: number
): { next_map: string; rotation: string } {
	const upNext = Number.isInteger(next) && next >= 0 ? entries[next] : undefined;
	const maps = [...new Set(entries.filter((e) => e.map && !e.denied).map((e) => mapName(e.map)))];
	return {
		next_map: upNext?.map ? mapName(upNext.map) : UNKNOWN,
		rotation: maps.join(', ') || UNKNOWN
	};
}

/** `{top}`: the board's first three by kills ("1. Night Owl 1204 · 2. Kova 988 · 3. Brick 951"). */
export function topLine(rows: readonly { name: string; kills: number }[]): string {
	return (
		rows
			.slice(0, 3)
			.map((r, i) => `${i + 1}. ${oneLine(r.name, 24)} ${r.kills}`)
			.join(' · ') || UNKNOWN
	);
}
