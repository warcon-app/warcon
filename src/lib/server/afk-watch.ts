// AFK watch (kind `afk_watch`), the pure part. The game kicks a player who gives it no input for a
// few minutes, and a macro that presses a key now and then beats that: the player sits in spawn all
// match, holding a slot and a place on a side. RCON shows no input, position or idle flag; a player's
// kills, deaths and cash on the player list are the only signs of play it gives (cash rises with
// every kill, capture, delivery and spot). A player with no kill, no death and no cash earned for the
// rule's minutes of a live match is idle: whispered first when the rule has a warning, then kicked,
// or flagged for staff. Spending is no sign of play: a macro can buy something now and then.
//
// A host can report no cash at all (every player at 0), and then a player holding a point without
// fighting would look idle: the rule acts only while it sees someone on the server earn cash within
// its minutes, and holds what falls due otherwise.
//
// Only a live match counts: a side has scored, no match ended at this look, and the rule's count
// are on. Pre-match and seeding never count (the scores sit at nil-all), nor does the empty list of
// a map change. Whatever stops the count (the match not live, the player off the list, a gap in the
// looks) starts their time again, so the rule never acts on time it did not see. The clocks live in
// the worker's memory (triggers.ts): a restart starts them over, which costs an idle player at most
// another stretch of the rule's minutes, where on the rule's row they would be a write for everyone
// on at every look. No database, no game server here.
import { ApiError, int, str } from './http';
import { settingsFingerprint } from './fingerprint';
import { steamIdList } from './steam';
import { MAX_CHAT } from '$lib/chat';

/** The outbox action of a rule that only alerts: a panel action, nothing is sent to the game. */
export const AFK_WATCH_FLAG = 'afk_watch_flag';
export const AFK_WATCH_DEFAULT_MINUTES = 15;
/** Below this, players at work go as long without a kill, a death or a dollar. */
export const AFK_WATCH_MIN_MINUTES = 5;
export const AFK_WATCH_MAX_MINUTES = 120;
/** From this many on: below it, AFK protection's default, a server is still seeding. */
export const AFK_WATCH_DEFAULT_MIN_PLAYERS = 20;
/** Players a rule leaves alone, as many as the Name filter's. */
const MAX_EXEMPT = 100;
/** Without a look at the player list for this long, every clock starts over. */
export const AFK_WATCH_GAP_MS = 2 * 60_000;
/** The gap at a player list cadence: never shorter than three looks. */
export const afkWatchGapMs = (playersIntervalMs: number): number =>
	Math.max(AFK_WATCH_GAP_MS, 3 * playersIntervalMs);

export interface AfkWatchConfig {
	/** idle this long in a live match, the rule acts */
	minutes: number;
	/** whisper a warning at this long idle; 0 for none */
	warnMinutes: number;
	warnMessage: string;
	/** `alert` writes the audit row (and so the Discord card) and leaves the player on */
	action: 'kick' | 'alert';
	/** counts only while at least this many are on */
	minPlayers: number;
	spareReserved: boolean;
	/** SteamIDs the rule never acts on: staff idle on purpose, say */
	exempt: string[];
	reason: string;
}

export function validateAfkWatch(c: Record<string, unknown>): AfkWatchConfig {
	const minutes = int(
		c.minutes,
		AFK_WATCH_DEFAULT_MINUTES,
		AFK_WATCH_MIN_MINUTES,
		AFK_WATCH_MAX_MINUTES
	);
	const warnMinutes = int(c.warnMinutes, 0, 0, AFK_WATCH_MAX_MINUTES);
	if (warnMinutes >= minutes)
		throw new ApiError(
			400,
			'The warning comes before the rule acts: set it below the idle time, or to 0 for none.'
		);
	const warnMessage = str(c.warnMessage, MAX_CHAT);
	if (warnMinutes && !warnMessage)
		throw new ApiError(400, 'Add the warning, or set it to 0 minutes.');
	return {
		minutes,
		warnMinutes,
		warnMessage,
		action: c.action === 'alert' ? 'alert' : 'kick',
		minPlayers: int(c.minPlayers, AFK_WATCH_DEFAULT_MIN_PLAYERS, 1, 1000),
		spareReserved: c.spareReserved === undefined ? true : !!c.spareReserved,
		exempt: steamIdList(c.exempt, MAX_EXEMPT),
		reason: str(c.reason, 200) || 'AFK: no kill, death or cash earned for {idle} minutes.'
	};
}

/** The fingerprint a rule's rows carry: a row decided under other settings is not sent. */
export const afkWatchSettingsKey = (cfg: AfkWatchConfig): string => settingsFingerprint(cfg);

/** What a rule does when a player has been idle its minutes, from its settings as saved. */
export const afkWatchAction = (config: unknown): 'kick' | 'alert' =>
	(config as Partial<AfkWatchConfig> | null)?.action === 'alert' ? 'alert' : 'kick';

/** Whether a rule whispers a warning first. */
export const afkWatchWarns = (config: unknown): boolean => {
	const c = config as Partial<AfkWatchConfig> | null;
	return Number(c?.warnMinutes) > 0 && !!str(c?.warnMessage);
};

/** A player's counters as a look shows them. */
export interface AfkCounters {
	kills: number;
	deaths: number;
	cash: number;
}

export interface AfkTrack extends AfkCounters {
	/** when their idle time began: the last look their counters moved at, or the first that counted */
	since: number;
	/** this stretch's warning is queued */
	warned: boolean;
	/** the rule has acted on this stretch */
	acted: boolean;
}

export interface AfkWatchState {
	/** the look these clocks are from */
	at: number;
	/** the last look anyone on the list earned cash at; the first look, when starting over */
	earnedAt: number;
	players: Map<string, AfkTrack>;
}

export interface AfkWatchLook {
	now: number;
	/** a side has scored, no match ended at this look, and the rule's count are on */
	live: boolean;
	/** who holds a reserved slot is not known yet: whatever falls due waits */
	waiting?: boolean;
	/** everyone on the list; the spared are watched for cash earned, never acted on */
	players: ({ steamId: string; spared: boolean } & AfkCounters)[];
}

export interface AfkWatchStep {
	state: AfkWatchState;
	/** players to warn now, with how long they have been idle (ms) */
	warn: { steamId: string; idleMs: number; since: number }[];
	/** players to act on now */
	act: { steamId: string; idleMs: number; since: number }[];
	/** why a warning or action that fell due was held: the reserved slots not read yet, or nobody
	 *  seen earning cash within the rule's minutes; '' when nothing was */
	held: '' | 'reserved' | 'cash';
}

/** A player's counters moved in a way only play moves them: a kill, a death, cash earned. A counter
 *  falling is the next match starting them again. */
const played = (t: AfkCounters, p: AfkCounters): boolean =>
	p.kills !== t.kills || p.deaths !== t.deaths || p.cash > t.cash;

/**
 * One look at the player list. No previous state (a rule new to this worker, or one starting over)
 * starts everyone's time at this look. A player's time starts again whenever they play (a kill, a
 * death, cash earned), at every look that is not live, and at every look they are spared; a player
 * off the list is forgotten. Cash spent lowers what earning is counted from, nothing more. Idle the
 * rule's minutes, the rule acts on them once a stretch; idle the warning's minutes first, they are
 * warned once a stretch, and never on the look it acts. What falls due waits, marked as not done,
 * while the reserved slots are unread or nobody on the list has earned cash within the rule's
 * minutes.
 */
export function afkWatchStep(
	cfg: Pick<AfkWatchConfig, 'minutes' | 'warnMinutes'>,
	prev: AfkWatchState | null,
	look: AfkWatchLook
): AfkWatchStep {
	const earned = look.players.some((p) => {
		const t = prev?.players.get(p.steamId);
		return !!t && p.cash > t.cash;
	});
	const next: AfkWatchState = {
		at: look.now,
		earnedAt: earned || !prev ? look.now : prev.earnedAt,
		players: new Map()
	};
	const hold: AfkWatchStep['held'] = look.waiting
		? 'reserved'
		: look.now - next.earnedAt >= cfg.minutes * 60_000
			? 'cash'
			: '';
	const step: AfkWatchStep = { state: next, warn: [], act: [], held: '' };
	for (const p of look.players) {
		const t = prev?.players.get(p.steamId);
		const counters = { kills: p.kills, deaths: p.deaths, cash: p.cash };
		if (!t || !look.live || p.spared || played(t, p)) {
			next.players.set(p.steamId, { ...counters, since: look.now, warned: false, acted: false });
			continue;
		}
		const track = { ...t, ...counters };
		const idleMs = look.now - track.since;
		const acts = !track.acted && idleMs >= cfg.minutes * 60_000;
		const warns =
			!acts && !track.warned && cfg.warnMinutes > 0 && idleMs >= cfg.warnMinutes * 60_000;
		if ((acts || warns) && hold) step.held = hold;
		else if (acts) {
			track.acted = track.warned = true;
			step.act.push({ steamId: p.steamId, idleMs, since: track.since });
		} else if (warns) {
			track.warned = true;
			step.warn.push({ steamId: p.steamId, idleMs, since: track.since });
		}
		next.players.set(p.steamId, track);
	}
	return step;
}

/** Whole minutes of idle time, as a message says them. */
export const idleMinutes = (ms: number): number => Math.floor(ms / 60_000);
