// Death whisper (kind `death_whisper`), the pure part. When the kill feed reports a player killed,
// the rule whispers them one of its messages, picked at random, while they wait to respawn: a
// community's Discord, say, told at a moment that interrupts no fight. A rule whispers a player at
// most once in its cooldown, never one on its list or, when it spares them, one with a reserved
// slot, and nobody while fewer than its count are on. With two messages or more, a player never
// gets the one they had last, nor one naming a killer, weapon or distance their death lacks while
// another fits (a fall has no killer: "Killed by {killer}" would go out as "Killed by ").
//
// The cooldowns live in the worker's memory (feed-events.ts), filled from the rule's outbox rows the
// first time it acts there, so a restart or a deploy keeps them. No database, no game server here.
import { ApiError, int } from './http';
import { steamIdList } from './steam';
import { causeLabel } from '$lib/causes';
import { MAX_CHAT } from '$lib/chat';
import { canonical } from '$lib/placeholders';
import { oneLine } from '$lib/saved-messages';
import type { MessageVars } from './message-vars';

export const DEATH_WHISPER_MAX_MESSAGES = 20;
export const DEATH_WHISPER_DEFAULT_COOLDOWN = 30;
export const DEATH_WHISPER_MAX_COOLDOWN = 24 * 60;
/** Players a rule leaves alone, as many as the Name filter's. */
const MAX_EXEMPT = 100;
/**
 * A whisper not sent this long after the rule decided it is dropped: the player will have
 * respawned, and the whisper would land in the middle of play.
 */
export const DEATH_WHISPER_MAX_AGE_MS = 30_000;
/**
 * How long past its cooldown a player is remembered, so the message they had last is known at
 * their next death even when it comes well after the cooldown. The outbox fill reads as far back.
 */
export const DEATH_WHISPER_KEEP_MS = 60 * 60_000;

export interface DeathWhisperConfig {
	/** what it whispers, one picked at random each time */
	messages: string[];
	/** the rule whispers a player at most once in this long */
	cooldownMinutes: number;
	/** acts only while at least this many are on */
	minPlayers: number;
	/** never whispers a player with a reserved slot */
	spareReserved: boolean;
	/** SteamIDs the rule never whispers: staff, say */
	exempt: string[];
}

export function validateDeathWhisper(c: Record<string, unknown>): DeathWhisperConfig {
	const list = Array.isArray(c.messages) ? c.messages : String(c.messages ?? '').split('\n');
	// each on one line and cut to what the game takes, the same text once
	const messages = [...new Set(list.map((m) => oneLine(m, MAX_CHAT)).filter(Boolean))];
	if (!messages.length) throw new ApiError(400, 'Add at least one message to whisper.');
	if (messages.length > DEATH_WHISPER_MAX_MESSAGES)
		throw new ApiError(400, `A rule holds at most ${DEATH_WHISPER_MAX_MESSAGES} messages.`);
	const cooldownMinutes = int(
		c.cooldownMinutes,
		DEATH_WHISPER_DEFAULT_COOLDOWN,
		0,
		DEATH_WHISPER_MAX_COOLDOWN
	);
	if (!cooldownMinutes)
		throw new ApiError(400, `cooldownMinutes must be 1-${DEATH_WHISPER_MAX_COOLDOWN}.`);
	return {
		messages,
		cooldownMinutes,
		minPlayers: int(c.minPlayers, 1, 0, 1000),
		spareReserved: !!c.spareReserved,
		exempt: steamIdList(c.exempt, MAX_EXEMPT)
	};
}

/** What a rule remembers of a player it whispered: when, and which of its messages. */
export interface Whispered {
	at: number;
	/** the message's place in the rule's list; -1 when not known */
	index: number;
}
export type WhisperedTracks = Map<string, Whispered>;

/** The rule's own placeholders: what a death can leave empty. */
export const DEATH_PLACEHOLDERS = ['killer', 'weapon', 'distance'] as const;
export type DeathPlaceholder = (typeof DEATH_PLACEHOLDERS)[number];

/** A death as the rule reads it: the player killed, the event the feed gave it, and which of the
 *  rule's own placeholders it leaves empty. */
export interface Death {
	steamId: string;
	eventId: string;
	blank?: readonly DeathPlaceholder[];
}

export interface DeathWhisperPick extends Death {
	index: number;
}

/**
 * One of the `fit` messages (their places in the list) at random, never `last` (the one the player
 * had before) while there is another. `rand` is in [0, 1).
 */
export function pickMessage(
	fit: readonly number[],
	last: number,
	rand: () => number = Math.random
): number {
	const pool = fit.length > 1 ? fit.filter((i) => i !== last) : fit;
	return pool[Math.min(Math.floor(rand() * pool.length), pool.length - 1)];
}

const TOKEN = /\{([a-z_]+)\}/gi;
const usesCache = new WeakMap<DeathWhisperConfig, Set<string>[]>();
/** Which of the rule's own placeholders each message uses, through any name it is typed with. */
const usesOf = (cfg: DeathWhisperConfig): Set<string>[] => {
	let uses = usesCache.get(cfg);
	if (!uses)
		usesCache.set(
			cfg,
			(uses = cfg.messages.map((m) => new Set([...m.matchAll(TOKEN)].map(([, n]) => canonical(n)))))
		);
	return uses;
};

/**
 * The messages that fit a death: those naming nothing it leaves empty, or every message when none
 * does (an author who wants "Killed by {killer}" on a fall gets it).
 */
export function fittingMessages(
	cfg: DeathWhisperConfig,
	blank: readonly DeathPlaceholder[] = []
): number[] {
	const all = cfg.messages.map((_, i) => i);
	if (!blank.length) return all;
	const uses = usesOf(cfg);
	const fit = all.filter((i) => !blank.some((b) => uses[i].has(b)));
	return fit.length ? fit : all;
}

const exemptSets = new WeakMap<DeathWhisperConfig, Set<string>>();
const exemptOf = (cfg: DeathWhisperConfig): Set<string> => {
	let set = exemptSets.get(cfg);
	if (!set) exemptSets.set(cfg, (set = new Set(cfg.exempt)));
	return set;
};

/** The deaths a step passed over, by why: what a dry run counts. */
export interface DeathsPassed {
	/** below the rule's player count, every death of the batch */
	few: number;
	/** waiting for the reserved slots to be read, every death of the batch */
	waiting: number;
	listed: number;
	reserved: number;
	/** inside the player's cooldown (a second death in one batch among them) */
	cooling: number;
}

/**
 * The whispers one batch's deaths bring, in the order the game played them, moving the rule's
 * memory on as it decides: a player at most once, never inside their cooldown, never one on the
 * rule's list or, when it spares them, one with a reserved slot, and nobody while fewer than its
 * count are on. `reserved` is null until the worker has read the server's list: a rule that spares
 * slots then whispers nobody and says it is `held`. `undo` puts the memory back as it was, but for
 * a player a later batch has moved on since.
 */
export function deathWhisperStep(
	cfg: DeathWhisperConfig,
	tracks: WhisperedTracks,
	deaths: Death[],
	at: { now: number; on: number; reserved: ReadonlySet<string> | null; rand?: () => number }
): { picks: DeathWhisperPick[]; held: '' | 'reserved'; passed: DeathsPassed; undo: () => void } {
	const passed: DeathsPassed = { few: 0, waiting: 0, listed: 0, reserved: 0, cooling: 0 };
	const none = { picks: [], passed, undo: () => {} };
	if (at.on < cfg.minPlayers) {
		passed.few = deaths.length;
		return { ...none, held: '' };
	}
	if (cfg.spareReserved && !at.reserved) {
		passed.waiting = deaths.length;
		return { ...none, held: 'reserved' };
	}
	const exempt = exemptOf(cfg);
	const cooled = at.now - cfg.cooldownMinutes * 60_000;
	const picks: DeathWhisperPick[] = [];
	const moved: { steamId: string; before: Whispered | undefined; set: Whispered }[] = [];
	for (const d of deaths) {
		if (exempt.has(d.steamId)) {
			passed.listed++;
			continue;
		}
		if (cfg.spareReserved && at.reserved!.has(d.steamId)) {
			passed.reserved++;
			continue;
		}
		const before = tracks.get(d.steamId);
		if (before && before.at > cooled) {
			passed.cooling++;
			continue;
		}
		const index = pickMessage(fittingMessages(cfg, d.blank), before?.index ?? -1, at.rand);
		const set = { at: at.now, index };
		tracks.set(d.steamId, set);
		moved.push({ steamId: d.steamId, before, set });
		picks.push({ ...d, index });
	}
	return {
		picks,
		held: '',
		passed,
		undo: () => {
			for (const m of moved.reverse()) {
				if (tracks.get(m.steamId) !== m.set) continue;
				if (m.before) tracks.set(m.steamId, m.before);
				else tracks.delete(m.steamId);
			}
		}
	};
}

/** Forgets players whose cooldown ended more than DEATH_WHISPER_KEEP_MS ago. */
export function pruneWhispered(cfg: DeathWhisperConfig, tracks: WhisperedTracks, now: number) {
	const from = now - cfg.cooldownMinutes * 60_000 - DEATH_WHISPER_KEEP_MS;
	for (const [id, t] of tracks) if (t.at <= from) tracks.delete(id);
}

/** A kill as the rule's own placeholders read it. */
export interface DeathKill {
	killer: { steamId: string; name: string } | null;
	victim: { steamId: string };
	cause: string | null;
	distanceM: number | null;
	suicide: boolean;
}

/**
 * The rule's own placeholders for one death: who killed the player, with what, and from how far.
 * Each is blank where it does not apply: nobody killed them (the environment, a fall) or they
 * killed themselves, the feed names no cause (falls), or sends no distance (vehicle explosions,
 * most suicides).
 */
export function deathVars(k: DeathKill): MessageVars {
	const killer =
		k.killer && !k.suicide && k.killer.steamId !== k.victim.steamId
			? k.killer.name || k.killer.steamId
			: '';
	return {
		killer,
		weapon: causeLabel(k.cause),
		distance: k.distanceM === null ? '' : Math.round(k.distanceM)
	};
}

/** Which of the rule's own placeholders a death leaves empty. */
export const deathBlanks = (vars: MessageVars): DeathPlaceholder[] =>
	DEATH_PLACEHOLDERS.filter((n) => vars[n] === '');
