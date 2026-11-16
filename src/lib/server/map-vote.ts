// The Map vote rule (kind `map_vote`). Near the end of a match, once the side in the lead reaches the
// rule's score, the server is told which maps it can play next, each with its number ("!1 Ozeti ·
// !2 Zestafona · !3 Sabatulo"); for the rule's seconds players type the number in chat, and the map
// with the most votes is put next in the rotation.
//
//   - The options come from the server's own rotation, read as the vote opens: for each map but the
//     one being played, the first entry of it the rotation comes to from the entry it has next, as
//     the rotation has it (an Infantry Only rotation offers Infantry Only maps; where the options
//     are played differently, each says how). The entry the server had next comes first, so the
//     players can keep it.
//   - A vote is a line of "!" and an option's number. The chat stage (chat-look.ts) reads the chat
//     for the rule from a few points short of its score until the vote closes, and for nothing
//     else, and hands each such line's player and number to `castBallot`. What is kept, in this
//     process's memory and only until the vote closes (or the rule goes), is each voter's SteamID
//     and the number they last chose, so that a player counts once; never a line, and nothing of it
//     reaches a table, a log, a card or the rule's row. What leaves the vote is the count for each
//     map.
//   - A vote opens as the leader's score passes the rule's from one look to the next, so a match has
//     one at most: a worker that starts, or takes over, with the score past it waits for the next
//     match. Its memory moves once what it decides is written.
//   - The winner and the entry the server had next change places in the config document (live
//     builds change the rotation only there), each found there by what it is. A swap keeps every
//     entry, and puts the winner next whether the server keeps its place in the list or follows the
//     entry being played; which it does has not been seen, so the rotation is read back, and the
//     winner swapped once more into the place the server then says comes next if it is not there.
//   - The vote lives in this process's memory: a worker that starts over (a deploy) forgets a vote
//     under way, and nothing is applied for it.
import { ApiError, int, str } from './http';
import { ACTIONS } from './actions';
import { GameError, type WardogsClient } from './rcon';
import { settingsFingerprint } from './fingerprint';
import { rewriteRotation } from './rotation-shuffle';
import { entryKey } from '../rotation-doc';
import { isMod, mapId, mapName, modKey, prettify } from '../format';
import { MAX_CHAT } from '../chat';
import { oneLine } from '../saved-messages';
import { COMMAND_PREFIX } from '../chat-commands';
import { MAP_VOTE_DEFAULTS, MAP_VOTE_LIMITS } from '../map-vote';
import type { MapSelection, Rotation } from '../types';

/** The outbox action that opens a vote: the options read from the rotation and said (not in ACTIONS). */
export const MAP_VOTE_OPEN = 'map_vote_open';
/** The outbox action that puts a vote's winner next in the rotation and says so. */
export const MAP_VOTE = 'map_vote';

export interface MapVoteConfig {
	startAt: number;
	seconds: number;
	options: number;
	minPlayers: number;
	minVotes: number;
	/** said as the vote opens; `{options}` lists the maps with their numbers */
	openMessage: string;
	/** said halfway through with the votes so far; '' for nothing */
	tallyMessage: string;
	/** said once the winner is next */
	resultMessage: string;
	/** said when the vote closes with too few votes; '' for nothing */
	noneMessage: string;
}

export function validateMapVote(c: Record<string, unknown>): MapVoteConfig {
	const d = MAP_VOTE_DEFAULTS;
	const n = (k: keyof typeof MAP_VOTE_LIMITS) =>
		int(c[k], d[k], MAP_VOTE_LIMITS[k][0], MAP_VOTE_LIMITS[k][1]);
	// absent: the usual text; blank: none (for the two that may be left out)
	const text = (k: 'openMessage' | 'tallyMessage' | 'resultMessage' | 'noneMessage') =>
		c[k] === undefined ? d[k] : oneLine(c[k], MAX_CHAT);
	const openMessage = text('openMessage');
	if (!/\{options\}/i.test(openMessage))
		throw new ApiError(
			400,
			'The opening message needs {options}: it is where players read the maps and their numbers.'
		);
	const resultMessage = text('resultMessage');
	if (!resultMessage) throw new ApiError(400, 'Write the message that says which map won.');
	return {
		startAt: n('startAt'),
		seconds: n('seconds'),
		options: n('options'),
		minPlayers: n('minPlayers'),
		minVotes: n('minVotes'),
		openMessage,
		tallyMessage: text('tallyMessage'),
		resultMessage,
		noneMessage: text('noneMessage')
	};
}

/** The settings a queued vote action was decided under (outbox.ts checks them at delivery). */
export const mapVoteSettingsKey = (cfg: MapVoteConfig): string => settingsFingerprint(cfg);

/** The words a Map vote rule takes in chat: its options' numbers. */
export const voteWords = (cfg: Partial<MapVoteConfig> | null): string[] => {
	const count = int(cfg?.options, MAP_VOTE_DEFAULTS.options, ...MAP_VOTE_LIMITS.options);
	return Array.from({ length: count }, (_, i) => String(i + 1));
};

// ---- the options --------------------------------------------------------------------------------

/** One map a vote offers: the rotation entry it plays, and where the rotation had it. */
export interface VoteOption {
	index: number;
	entry: MapSelection;
}

/** Two names of one map, however each was given (the status may name it as players know it). */
export const sameMap = (a: string, b: string): boolean =>
	!!a && !!b && mapId(a).toLowerCase() === mapId(b).toLowerCase();

/**
 * What a vote offers, from the rotation the server plays: going round the list from the entry it
 * has next, the first entry of each map, as the rotation has it, leaving out the map being played
 * (by the entry on and by the status's word) and entries the server refuses, up to `count` maps.
 */
export function voteOptions(
	entries: readonly (MapSelection & { denied?: boolean })[],
	nowIndex: number,
	nextIndex: number,
	playing: string,
	count: number
): VoteOption[] {
	const n = entries.length;
	if (!n) return [];
	const valid = (i: number) => Number.isInteger(i) && i >= 0 && i < n;
	const start = valid(nextIndex) ? nextIndex : valid(nowIndex) ? (nowIndex + 1) % n : 0;
	const on = valid(nowIndex) ? entries[nowIndex].map : '';
	const seen = new Set<string>();
	const out: VoteOption[] = [];
	for (let k = 0; k < n && out.length < count; k++) {
		const i = (start + k) % n;
		const e = entries[i];
		if (i === nowIndex || !e.map || e.denied) continue;
		const map = mapId(e.map).toLowerCase();
		if (seen.has(map) || sameMap(e.map, on) || sameMap(e.map, playing)) continue;
		seen.add(map);
		out.push({
			index: i,
			entry: {
				map: e.map,
				experiences: [...e.experiences],
				lighting: e.lighting ?? '',
				zoneAlternator: e.zoneAlternator ?? ''
			}
		});
	}
	return out;
}

/** An entry's modifiers, each once (Limited Gear has two ids), as players know them. */
const modifiersOf = (e: MapSelection): string[] => {
	const one = new Map<string, string>();
	for (const id of e.experiences.filter(isMod))
		if (!one.has(modKey(id))) one.set(modKey(id), prettify(id.replace(/^KOTH_/i, '')));
	return [...one.values()];
};

/**
 * The options as players read them: each its map, and where they are not all played alike, how
 * each is ("Ozeti (Infantry Only)"); one played the standard way says nothing.
 */
export function optionNames(options: readonly VoteOption[]): string[] {
	const mods = options.map((o) => modifiersOf(o.entry));
	const key = (m: string[]) => [...m].sort().join('+');
	const alike = mods.every((m) => key(m) === key(mods[0] ?? []));
	return options.map((o, i) => {
		const name = mapName(o.entry.map);
		return alike || !mods[i].length ? name : `${name} (${mods[i].join(', ')})`;
	});
}

/** "!1 Ozeti · !2 Zestafona · !3 Sabatulo": the options as players type them. */
export const optionsLine = (options: readonly VoteOption[]): string =>
	optionNames(options)
		.map((name, i) => `${COMMAND_PREFIX}${i + 1} ${name}`)
		.join(' · ');

/** "!1 Ozeti 4 · !2 Zestafona 2 · !3 Sabatulo 0": the votes so far. */
export const tallyLine = (options: readonly VoteOption[], counts: readonly number[]): string =>
	optionNames(options)
		.map((name, i) => `${COMMAND_PREFIX}${i + 1} ${name} ${counts[i] ?? 0}`)
		.join(' · ');

/** Cut to `max` UTF-16 units, never through a character: half an emoji is dropped, not sent. */
const cut = (text: string, max: number): string => {
	const out = text.slice(0, Math.max(0, max));
	return /[\uD800-\uDBFF]$/.test(out) ? out.slice(0, -1) : out;
};

/**
 * The opening text with its options put in, as the game takes it. The list is kept whole: should
 * the whole not fit, the words round it give way, those after it first.
 */
export function fillOptions(text: string, line: string): string {
	const whole = text.replace(/\{options\}/gi, () => line);
	if (whole.length <= MAX_CHAT) return whole.trim();
	const at = text.search(/\{options\}/i);
	if (at < 0) return cut(text, MAX_CHAT).trim();
	const list = cut(line, MAX_CHAT);
	const head = cut(text.slice(0, at), MAX_CHAT - list.length);
	const tail = cut(
		text.slice(at + '{options}'.length).replace(/\{options\}/gi, ''),
		MAX_CHAT - list.length - head.length
	);
	return `${head}${list}${tail}`.trim();
}

/** The votes for each option. */
export function countVotes(options: readonly VoteOption[], ballots: ReadonlyMap<string, number>) {
	const counts = options.map(() => 0);
	for (const n of ballots.values()) if (n >= 1 && n <= counts.length) counts[n - 1]++;
	return counts;
}

/** The option with the most votes (its place in the list), drawn among those tied; null for none. */
export function winnerOf(
	counts: readonly number[],
	random: () => number = Math.random
): { index: number; tied: boolean } | null {
	const top = Math.max(0, ...counts);
	if (!top) return null;
	const tied = counts.flatMap((c, i) => (c === top ? [i] : []));
	const pick = Math.min(tied.length - 1, Math.floor(random() * tied.length));
	return { index: tied[Math.max(0, pick)], tied: tied.length > 1 };
}

// ---- the vote, in this process's memory ---------------------------------------------------------

export interface Vote {
	ruleId: string;
	/** the rule's settings it was decided under: new settings drop it (a rename does not) */
	under: string;
	/** the map of the match the vote is for, as the status names it */
	map: string;
	/** waiting in the outbox to be opened; open to votes; over (closed, or never opened) */
	phase: 'opening' | 'open' | 'done';
	/** the look that decided it (ms) */
	decidedAt: number;
	/** when its options went out, and when it closes; 0 until they have */
	openedAt: number;
	closesAt: number;
	options: VoteOption[];
	/** the entry being played when the options were read (its entryKey); '' where the server did
	 *  not say: the result is for the match on that entry and no other */
	on: string;
	/** each voter's choice (an option's number) until the vote closes: a player counts once */
	ballots: Map<string, number>;
	/** the votes so far have been said */
	tallied: boolean;
}

/** The vote of each server, by its id: one at a time, and one a match. */
const votes = new Map<string, Vote>();
/** Each server's last look as the rule saw it: a vote opens as the leader's score passes the rule's
 *  from one look to the next. */
const looks = new Map<string, { map: string; leading: number; at: number }>();
/** When each server's chat was last read with its place known (chat-look.ts): votes typed then are
 *  counted. */
const reads = new Map<string, number>();

/** A server's vote, for the tests. */
export const voteOf = (serverId: string): Vote | undefined => votes.get(serverId);

/**
 * Forgets what the rule holds of one server (its Map vote off or gone, the server gone), or of every
 * server (a new period of ownership: what another worker decided meanwhile is not known here). A
 * vote under way goes with it, its voters included, and nothing is applied for it.
 */
export function forgetVotes(serverId?: string): void {
	if (serverId) {
		votes.delete(serverId);
		looks.delete(serverId);
		reads.delete(serverId);
	} else {
		votes.clear();
		looks.clear();
		reads.clear();
	}
}

/** The chat stage has read the server's chat, its place known: votes typed now are counted. */
export function noteChatRead(serverId: string, at: number): void {
	reads.set(serverId, at);
}

/** How recent a read must be for the chat to count as being read. */
export const READING_MS = 15_000;

/** Whether the server's chat is being read as of `now`, so that votes typed would be counted. */
export const chatReadRecently = (serverId: string, now: number): boolean =>
	now - (reads.get(serverId) ?? -Infinity) <= READING_MS;

/** Points short of the rule's score from which the chat is read for it. */
export const WARM_POINTS = 5;

/**
 * Whether the chat is read for a server's Map vote now: from a few points short of the rule's score
 * until the score is reached, so that a vote is decided knowing the chat can be read; and while a
 * vote waits to open or is open. Not otherwise: a rule that only counts votes reads no more of the
 * chat than its votes need.
 */
export function voteWantsChat(
	serverId: string,
	cfg: Pick<MapVoteConfig, 'startAt'>,
	status: { scores: { score: number }[] } | null
): boolean {
	const v = votes.get(serverId);
	if (v && (v.phase === 'opening' || v.phase === 'open')) return true;
	const leading = Math.max(0, ...(status?.scores ?? []).map((f) => f.score));
	return leading >= cfg.startAt - WARM_POINTS && leading < cfg.startAt;
}

/** A player's vote, from the chat stage: their last one counts. None outside an open vote. */
export function castBallot(
	serverId: string,
	ruleId: string,
	steamId: string,
	option: number,
	now: number
): boolean {
	const v = votes.get(serverId);
	if (!v || v.ruleId !== ruleId || v.phase !== 'open' || now >= v.closesAt) return false;
	if (!steamId || !Number.isInteger(option) || option < 1 || option > v.options.length)
		return false;
	v.ballots.set(steamId, option);
	return true;
}

/** What the worker sees of the match at one look, as far as the vote needs it. */
export interface VoteLook {
	now: number;
	/** the map being played, as the status names it */
	map: string;
	/** the leading side's score, and the score a match is won at */
	leading: number;
	cap: number;
	players: number;
	/** a match ended since the last look */
	boundary: boolean;
	/** the chat is being read on this server (chatReadRecently) */
	reading: boolean;
}

export type VoteStep =
	| { do: 'open'; vote: Vote }
	| { do: 'tally'; vote: Vote; counts: number[] }
	| {
			do: 'close';
			vote: Vote;
			counts: number[];
			total: number;
			/** the winning option's place in the list; null under the votes needed */
			winner: number | null;
			tied: boolean;
	  }
	/** the vote was open when its match ended, or the rule's settings changed: nothing is put next */
	| { do: 'ended'; vote: Vote; changed: boolean }
	/** the opening never came back from the outbox */
	| { do: 'lapsed'; vote: Vote }
	| null;

/** What one look decides, and how the server's vote moves for it. */
export interface VoteDecision {
	step: VoteStep;
	/** moves the vote in memory: for the caller to run once what the step queues is written, so a
	 *  look whose write fails decides again at the next */
	commit: () => void;
}

/** How long a vote's opening may wait to be sent before the vote counts as not coming. */
export const OPENING_MS = 60_000;
/** A look this long after the one before says nothing of how the score went in between. */
const LOOK_GAP_MS = 60_000;
/** What is held of a server no look has come for in this long is forgotten. */
const STALE_MS = 10 * 60_000;
let sweptAt = 0;

/** Forgets, once a minute at most, what is held of servers no look has come for in a while. */
function sweep(now: number): void {
	if (now - sweptAt < 60_000) return;
	sweptAt = now;
	const old = now - STALE_MS;
	for (const [id, v] of votes) if (Math.max(v.decidedAt, v.closesAt) < old) votes.delete(id);
	for (const [id, l] of looks) if (l.at < old) looks.delete(id);
	for (const [id, at] of reads) if (at < old) reads.delete(id);
}

/**
 * One look at the server for its vote. A vote opens as the leader's score passes the rule's from
 * one look to the next on the same match, before the match is won, with the chat being read and
 * enough players on: a worker that starts, or a rule switched on, with the score already past it
 * waits for the next match, and no match has two votes. Halfway the votes so far are said; the vote
 * closes when its time is up or the match is won, and is dropped, with nothing applied, when the
 * match ends or the rule's settings change first.
 */
export function voteStep(
	serverId: string,
	ruleId: string,
	under: string,
	cfg: MapVoteConfig,
	look: VoteLook,
	random: () => number = Math.random
): VoteDecision {
	sweep(look.now);
	if (!look.map) return { step: null, commit: () => {} };
	const prev = looks.get(serverId);
	const v = votes.get(serverId);
	const decide = (step: VoteStep, move: () => void = () => {}): VoteDecision => ({
		step,
		commit: () => {
			move();
			looks.set(serverId, { map: look.map, leading: look.leading, at: look.now });
		}
	});
	if (
		v &&
		(v.ruleId !== ruleId || v.under !== under || look.boundary || !sameMap(v.map, look.map))
	) {
		const changed = v.ruleId !== ruleId || v.under !== under;
		return decide(v.phase === 'open' ? { do: 'ended', vote: v, changed } : null, () => {
			if (votes.get(serverId) === v) votes.delete(serverId);
		});
	}
	if (!v) {
		const passed =
			!!prev &&
			!look.boundary &&
			sameMap(prev.map, look.map) &&
			look.now - prev.at <= LOOK_GAP_MS &&
			prev.leading < cfg.startAt &&
			look.leading >= cfg.startAt;
		if (!passed || !look.reading || look.players < cfg.minPlayers || look.leading >= look.cap)
			return decide(null);
		const vote: Vote = {
			ruleId,
			under,
			map: look.map,
			phase: 'opening',
			decidedAt: look.now,
			openedAt: 0,
			closesAt: 0,
			options: [],
			on: '',
			ballots: new Map(),
			tallied: false
		};
		return decide({ do: 'open', vote }, () => votes.set(serverId, vote));
	}
	if (v.phase === 'opening')
		return look.now - v.decidedAt < OPENING_MS
			? decide(null)
			: decide({ do: 'lapsed', vote: v }, () => {
					v.phase = 'done';
				});
	if (v.phase === 'done') return decide(null);
	const counts = countVotes(v.options, v.ballots);
	if (look.now >= v.closesAt || look.leading >= look.cap) {
		const total = counts.reduce((a, b) => a + b, 0);
		const best = total >= cfg.minVotes ? winnerOf(counts, random) : null;
		return decide(
			{
				do: 'close',
				vote: v,
				counts,
				total,
				winner: best?.index ?? null,
				tied: best?.tied ?? false
			},
			() => {
				v.phase = 'done';
				v.ballots.clear();
			}
		);
	}
	if (!v.tallied && cfg.tallyMessage && look.now >= (v.openedAt + v.closesAt) / 2)
		return decide({ do: 'tally', vote: v, counts }, () => {
			v.tallied = true;
		});
	return decide(null);
}

/** One look of the past as the samples keep it, for the dry run. */
export interface VoteSample {
	ts: number;
	ok: boolean;
	count: number;
	map: string;
	scores: { name: string; score: number }[];
}

/**
 * When, over a window's samples, the rule would have opened a vote: in each match, the first sample
 * with the leader at the rule's score and short of the cap, and enough players on. A new match is a
 * new map or the scores falling back, as the worker tells one.
 */
export function voteReplay(
	rows: readonly VoteSample[],
	cfg: Pick<MapVoteConfig, 'startAt' | 'minPlayers'>,
	cap: number
): { at: number; map: string; leading: number; players: number }[] {
	const out: { at: number; map: string; leading: number; players: number }[] = [];
	let prev: { map: string; total: number } | null = null;
	let opened = false;
	for (const r of rows) {
		if (!r.ok || !r.map) continue;
		const total = r.scores.reduce((n, f) => n + f.score, 0);
		if (prev && (!sameMap(prev.map, r.map) || total < prev.total)) opened = false;
		prev = { map: r.map, total };
		const leading = Math.max(0, ...r.scores.map((f) => f.score));
		if (opened || r.count < cfg.minPlayers || leading < cfg.startAt || leading >= cap) continue;
		opened = true;
		out.push({ at: r.ts, map: r.map, leading, players: r.count });
	}
	return out;
}

// ---- delivery -----------------------------------------------------------------------------------

/** What a delivery came to: its message, and `skipped` when nothing was sent (kept, not audited). */
export interface VoteDelivery {
	message: string;
	skipped?: boolean;
	retryAfterMs?: number;
}

/** What the worker last saw of the match, for a delivery to check it is still the one decided on. */
export interface MatchNow {
	map: string;
	leading: number;
	cap: number;
}

const readRotation = (client: WardogsClient) =>
	ACTIONS.rotation.run(client, {}) as Promise<Rotation>;

/** Why the rotation cannot take a vote's winner: '' when it can. */
const rotationRefusal = (r: Pick<Rotation, 'enabled' | 'mode'>): string =>
	!r.enabled
		? 'the rotation is switched off on this server'
		: r.mode !== 'ordered'
			? 'the rotation is set to Random on this server, and a vote needs it Ordered'
			: '';

/**
 * The vote's opening, at delivery: the options read from the rotation as it stands, said with the
 * rule's text, and the vote open from then for its seconds. Not opened when the match it was for has
 * ended or the vote was called off meanwhile (skipped), or when the rotation cannot take a winner
 * (refused, which the rule's row and Discord show). The result names maps only.
 */
export async function openVoteOnServer(
	client: WardogsClient,
	serverId: string,
	params: Record<string, unknown>,
	match: MatchNow | null,
	now: () => number = Date.now
): Promise<VoteDelivery> {
	const v = votes.get(serverId);
	if (!v || v.phase !== 'opening' || v.decidedAt !== Number(params.decidedAt))
		return { skipped: true, message: 'The vote was called off before it opened.' };
	const over = (message: string) => {
		v.phase = 'done';
		return { skipped: true, message };
	};
	if (match && (!sameMap(match.map, v.map) || match.leading >= match.cap))
		return over('The match ended before the vote opened.');
	try {
		const live = await readRotation(client);
		const why = rotationRefusal(live);
		if (why) throw new ApiError(409, `No vote: ${why}.`);
		const count = int(params.options, MAP_VOTE_DEFAULTS.options, ...MAP_VOTE_LIMITS.options);
		const options = voteOptions(live.entries, live.nowIndex, live.nextIndex, v.map, count);
		if (options.length < 2)
			throw new ApiError(
				409,
				'No vote: the rotation has fewer than two maps other than the one being played.'
			);
		const message = fillOptions(str(params.text, 4 * MAX_CHAT), optionsLine(options));
		await ACTIONS.broadcast.run(client, { message });
		const seconds = int(params.seconds, MAP_VOTE_DEFAULTS.seconds, ...MAP_VOTE_LIMITS.seconds);
		const on = live.entries[live.nowIndex];
		v.on = on ? entryKey(on) : '';
		v.options = options;
		v.ballots = new Map();
		v.openedAt = now();
		v.closesAt = v.openedAt + seconds * 1000;
		v.phase = 'open';
		return {
			message: `Vote open for ${seconds} s: ${options.map((o) => mapName(o.entry.map)).join(', ')}.`
		};
	} catch (err) {
		// not opened, so not opened again this match
		v.phase = 'done';
		throw err;
	}
}

/** The list with the entries at `a` and `b` changing places. */
const swapped = <T>(list: readonly T[], a: number, b: number): T[] => {
	const out = list.slice();
	[out[a], out[b]] = [out[b], out[a]];
	return out;
};

/** Where an entry is in a list: at `hint` when it is there, else its first place; -1 for none. */
const placeOf = (list: readonly MapSelection[], key: string, hint: number): number =>
	hint >= 0 && hint < list.length && entryKey(list[hint]) === key
		? hint
		: list.findIndex((e) => entryKey(e) === key);

/**
 * The winner put next, at delivery: the winning entry and the entry the server has next change
 * places in the rotation the config document holds, each found there by what it is. The server's
 * rotation is then read back; should it say another entry comes next, the winner changes places
 * with that one, once. Said to the server only once the server shows the winner next. Not sent for
 * a match that has ended. The result names maps and counts only.
 */
export async function applyVoteOnServer(
	client: WardogsClient,
	params: Record<string, unknown>,
	match: MatchNow | null
): Promise<VoteDelivery> {
	const entry = params.entry as MapSelection | undefined;
	if (!entry || typeof entry.map !== 'string' || !Array.isArray(entry.experiences))
		throw new ApiError(400, 'The vote did not say which entry won.');
	const name = mapName(entry.map);
	const votesFor = int(params.votes, 0, 0);
	const total = int(params.total, 0, 0);
	const counted = `${votesFor} of ${total} vote${total === 1 ? '' : 's'}`;
	const ended = {
		skipped: true,
		message: `The next match started before ${name} could be put next.`
	};
	if (match && !sameMap(match.map, str(params.map, 100))) return ended;
	const key = entryKey(entry);
	const live = await readRotation(client);
	const why = rotationRefusal(live);
	if (why) throw new ApiError(409, `${name} not put next: ${why}.`);
	const n = live.entries.length;
	const valid = (i: number) => i >= 0 && i < n;
	// the server has moved on to another entry since the vote opened: its match is over
	const on = str(params.on, 1000);
	if (on && valid(live.nowIndex) && entryKey(live.entries[live.nowIndex]) !== on) return ended;
	const w = placeOf(live.entries, key, int(params.index, -1));
	if (w < 0) throw new ApiError(409, `${name} not put next: the rotation no longer has its entry.`);
	const next = valid(live.nextIndex)
		? live.nextIndex
		: valid(live.nowIndex)
			? (live.nowIndex + 1) % n
			: -1;
	if (next < 0)
		throw new ApiError(
			409,
			`${name} not put next: the server does not say which entry comes next.`
		);
	const say = async (prefix: string): Promise<VoteDelivery> => {
		const message = str(params.message, MAX_CHAT);
		if (!message) return { message: `${prefix}.` };
		try {
			await ACTIONS.broadcast.run(client, { message });
			return { message: `${prefix}; said to the server.` };
		} catch (err) {
			// It is next whatever the game made of the message.
			if (err instanceof GameError && err.code === 'rate_limited')
				return {
					message: `${prefix}; the result was not said: the server asked the panel to slow down.`,
					retryAfterMs: err.retryAfterMs || 5_000
				};
			return { message: `${prefix}; the result could not be said.` };
		}
	};
	const nextKey = entryKey(live.entries[next]);
	if (w === next || nextKey === key)
		return say(`${name} won with ${counted}, and was next already`);
	/** The document's rotation with the winner and the entry at `other` (as the server lists it) changed. */
	const swap =
		(winnerHint: number, otherKey: string, otherHint: number) =>
		(doc: { entries: MapSelection[] }) => {
			const i = placeOf(doc.entries, key, winnerHint);
			const j = placeOf(doc.entries, otherKey, otherHint);
			if (i < 0 || j < 0)
				throw new ApiError(
					409,
					`${name} not put next: the rotation in the config document does not have ${i < 0 ? 'its entry' : 'the entry the server has next'}.`
				);
			return i === j ? null : swapped(doc.entries, i, j);
		};
	/** What the server says comes next, read back; null when it cannot be read. */
	const shows = async () => {
		const r = await readRotation(client).catch(() => null);
		return r ? { index: r.nextIndex, entry: r.entries[r.nextIndex] ?? null } : null;
	};
	const written = await rewriteRotation(client, swap(w, nextKey, next));
	if (!written) throw new ApiError(409, `${name} not put next: the rotation could not be written.`);
	let back = await shows();
	if (back?.entry && entryKey(back.entry) !== key) {
		// The server takes its next entry from another place: the winner goes there instead. The swap
		// has landed either way, so a refusal here is told, not thrown.
		const shown = mapName(back.entry.map);
		try {
			if (await rewriteRotation(client, swap(next, entryKey(back.entry), back.index)))
				back = await shows();
		} catch (err) {
			if (err instanceof GameError && err.code === 'rate_limited')
				return {
					message: `${name} won with ${counted}; the server shows ${shown} next, and moving ${name} there was refused for sending too fast.`,
					retryAfterMs: err.retryAfterMs || 5_000
				};
		}
	}
	if (!back)
		return { message: `${name} won with ${counted}; the server did not show its rotation back.` };
	if (!back.entry || entryKey(back.entry) !== key)
		return {
			message: `${name} won with ${counted}, but the server still shows ${back.entry ? mapName(back.entry.map) : 'no entry'} next.`
		};
	return say(`${name} won with ${counted} and is next`);
}
