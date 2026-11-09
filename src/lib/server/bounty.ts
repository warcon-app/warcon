// The Bounty rule's own part: who is on a run, when a run puts a bounty on a player, which kill
// claims it, and the worker's memory of both. A run is the match page's Best streak (feedRecord): a
// kill of another player that is not a team kill or a suicide adds to the killer's run, any death
// ends the victim's. One bounty is open on a server at a time; the first enemy to kill the marked
// player claims it, and a team kill, a suicide or the environment never does, so nobody clears
// their own or has a friend do it. It lapses when the player leaves, the match ends, or the panel
// loses sight of the server (it cannot tell what happened meanwhile). No database
// and no game server here: the live path (feed-events.ts for kills, triggers.ts for leaves and match
// ends) and the dry run (triggers.ts) run the same steps.
import { ApiError, int, str } from './http';
import { settingsFingerprint } from './fingerprint';
import { MAX_CHAT } from '$lib/chat';

/**
 * The outbox action of a claimed bounty's reserved slot: a panel action, the player goes on a
 * reserved list.
 */
export const BOUNTY_REWARD = 'bounty_reward';
/**
 * The outbox actions that note a bounty claimed and a bounty lapsing: panel actions whose audit row is
 * the delivery, so the trail says who claimed it whatever the rule announces.
 */
export const BOUNTY_CLAIM = 'bounty_claim';
export const BOUNTY_LAPSE = 'bounty_lapse';

export type BountyReward = 'slot' | 'none';
/** Where a claimed slot goes: this server's own reserved list, or the organisation's. */
export type BountyScope = 'server' | 'org';

export interface BountyConfig {
	/** kills in a row without dying, in one match, that put a bounty on a player */
	streak: number;
	/** nobody is marked while fewer than this many are on */
	minPlayers: number;
	reward: BountyReward;
	/** how long the claimer's reserved slot lasts */
	slotDays: number;
	scope: BountyScope;
	/** broadcast when a bounty is set */
	setMessage: string;
	/** broadcast when it is claimed; '' for none */
	claimMessage: string;
	/** whispered to the claimer; '' for none */
	whisper: string;
}

export const BOUNTY_SET_MESSAGE =
	'BOUNTY on {name}: {streak} kills without dying. Kill them for {reward}.';
export const BOUNTY_SET_MESSAGE_PLAIN =
	'BOUNTY on {name}: {streak} kills without dying. Who ends the run?';

/** What a rule's reward needs of whoever saves it: a slot here, or on the organisation's list. */
export const bountyScope = (c: unknown): BountyScope =>
	c && typeof c === 'object' && (c as Record<string, unknown>).scope === 'org' ? 'org' : 'server';
export const bountyReward = (c: unknown): BountyReward =>
	c && typeof c === 'object' && (c as Record<string, unknown>).reward === 'none' ? 'none' : 'slot';

export function validateBounty(c: Record<string, unknown>): BountyConfig {
	const reward = bountyReward(c);
	return {
		streak: int(c.streak, 15, 3, 200),
		minPlayers: int(c.minPlayers, 20, 0, 1000),
		reward,
		slotDays: int(c.slotDays, 1, 1, 365),
		scope: bountyScope(c),
		setMessage:
			str(c.setMessage, MAX_CHAT) ||
			(reward === 'slot' ? BOUNTY_SET_MESSAGE : BOUNTY_SET_MESSAGE_PLAIN),
		claimMessage: str(c.claimMessage, MAX_CHAT),
		whisper: str(c.whisper, MAX_CHAT)
	};
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

/** The reward in words, for `{reward}` and the panel's own lines; '' for none. */
export const rewardWords = (cfg: Pick<BountyConfig, 'reward' | 'slotDays'>): string =>
	cfg.reward === 'slot' ? `a reserved slot for ${days(cfg.slotDays)}` : '';

/** One player of a kill as the rule reads them. */
export interface BountyPlayer {
	steamId: string;
	name: string;
	faction: string | null;
}

/** One kill as the rule reads it. */
export interface BountyKill {
	eventId: string;
	killer: BountyPlayer | null;
	victim: BountyPlayer;
	suicide: boolean;
	teamKill: boolean;
}

/** The bounty open on a server. */
export interface OpenBounty extends BountyPlayer {
	/** the run that put the bounty on them */
	streak: number;
	/** their longest run since it was set, for the claim (in memory; written with the next change) */
	best: number;
	/** when it was set (ms) */
	setAt: number;
	/**
	 * the match it was set in (matchKey of the batch), so one read back after a restart is not
	 * claimed in a later match; '' until known
	 */
	match: string;
}

/** A rule's runs and its open bounty. */
export interface BountyTrack {
	runs: Map<string, number>;
	open: OpenBounty | null;
}

export type BountyEvent =
	| { kind: 'set'; bounty: OpenBounty; kill: BountyKill }
	| { kind: 'claim'; bounty: OpenBounty; claimer: BountyPlayer; kill: BountyKill };

/** A kill that adds to the killer's run: of another player, not a team kill or a suicide. */
const scores = (k: BountyKill): boolean =>
	!!k.killer && !k.suicide && !k.teamKill && k.killer.steamId !== k.victim.steamId;

/**
 * A kill that claims the bounty on its victim: one that scores, by a player whose side is known and
 * not the victim's. A kill between players whose sides the panel has not seen could be a friend's.
 */
export const claims = (k: BountyKill, open: Pick<OpenBounty, 'steamId'>): boolean =>
	k.victim.steamId === open.steamId &&
	scores(k) &&
	!!k.killer!.faction &&
	!!k.victim.faction &&
	k.killer!.faction !== k.victim.faction;

/**
 * Takes in kills in the order the game played them: a claim first (the marked player's death),
 * then the victim's run ends and the killer's grows, and a run that reaches the rule's count while
 * no bounty is open, with `canMark` (enough players on), puts one on the killer. The claimer can be
 * marked by the very kill that claims. Moves `track` on and returns what happened.
 */
export function bountyStep(
	cfg: Pick<BountyConfig, 'streak'>,
	track: BountyTrack,
	inOrder: BountyKill[],
	at: { canMark: boolean; now: number }
): BountyEvent[] {
	const out: BountyEvent[] = [];
	for (const k of inOrder) {
		if (track.open && claims(k, track.open)) {
			out.push({ kind: 'claim', bounty: track.open, claimer: k.killer!, kill: k });
			track.open = null;
		}
		track.runs.delete(k.victim.steamId);
		if (!scores(k)) continue;
		const killer = k.killer!;
		const run = (track.runs.get(killer.steamId) ?? 0) + 1;
		track.runs.set(killer.steamId, run);
		if (track.open?.steamId === killer.steamId) track.open.best = Math.max(track.open.best, run);
		else if (!track.open && at.canMark && run >= cfg.streak) {
			track.open = {
				steamId: killer.steamId,
				name: killer.name || killer.steamId,
				faction: killer.faction,
				streak: run,
				best: run,
				setAt: at.now,
				match: ''
			};
			out.push({ kind: 'set', bounty: track.open, kill: k });
		}
	}
	return out;
}

/**
 * Why an open bounty lapses: its player left, the match ended, or the panel lost sight of the server
 * (out of reach for a few looks, its own restart among them), after which it cannot tell either.
 */
export type BountyLapse = 'left' | 'match' | 'lost';

/** What the panel says of a lapse. */
export const lapseWords = (b: Pick<OpenBounty, 'name' | 'best'>, why: BountyLapse): string =>
	`The bounty on ${b.name} lapsed: ${
		why === 'left'
			? 'they left the server'
			: why === 'match'
				? 'the match ended'
				: 'the server was out of reach'
	} (a run of ${b.best}).`;

/**
 * Whether a bounty set in match `set` is from before the match `now` (both matchKey): only two
 * matches the panel opened are told apart, so a bounty set or claimed while none was open stands.
 */
export const fromEarlierMatch = (set: string, now: string): boolean =>
	set.startsWith('m') && now.startsWith('m') && set !== now;

// ---- the worker's memory ------------------------------------------------------------------------

/**
 * What a rule's open bounty and runs were kept under: its settings and its last save. Any save of the
 * rule (switching it off and on included) calls off an open bounty and starts the runs over; the
 * saved state of an older save is not read back.
 */
export const bountyVersion = (row: { config: unknown; updatedAt: Date | null }): string =>
	`${settingsFingerprint(row.config)}:${row.updatedAt?.getTime() ?? 0}`;

/** The rule's state as written to its row: the open bounty, under the version it was set in. */
export interface BountyState {
	version: string;
	open: OpenBounty | null;
}

/** The open bounty a row's saved state holds for this version, if any. */
export function savedBounty(state: unknown, version: string): OpenBounty | null {
	const s = state as Partial<BountyState> | null;
	if (!s || s.version !== version || !s.open || typeof s.open !== 'object') return null;
	const o = s.open;
	return typeof o.steamId === 'string' && typeof o.name === 'string'
		? {
				steamId: o.steamId,
				name: o.name,
				faction: typeof o.faction === 'string' ? o.faction : null,
				streak: Number(o.streak) || 0,
				best: Number(o.best) || Number(o.streak) || 0,
				setAt: Number(o.setAt) || 0,
				match: typeof o.match === 'string' ? o.match : ''
			}
		: null;
}

export const bountyState = (version: string, open: OpenBounty | null): BountyState => ({
	version,
	open: open ? { ...open } : null
});

/**
 * Each Bounty rule's runs and open bounty in this process's memory, by server and rule. The open
 * bounty is also written to the rule's row as it changes, so a restart keeps the hunt and forgets
 * only the runs. Kept only for servers with the rule on.
 */
const memory = new Map<string, Map<string, { version: string; track: BountyTrack }>>();

/** The rule's track, read back from its row's state the first time this process sees it. */
export function bountyTrack(row: {
	id: string;
	serverId: string;
	config: unknown;
	state: unknown;
	updatedAt: Date | null;
}): { version: string; track: BountyTrack } {
	const version = bountyVersion(row);
	let mine = memory.get(row.serverId);
	if (!mine) memory.set(row.serverId, (mine = new Map()));
	let m = mine.get(row.id);
	if (!m || m.version !== version) {
		m = { version, track: { runs: new Map(), open: savedBounty(row.state, version) } };
		mine.set(row.id, m);
	}
	return m;
}

/** Drops the tracks of a server's rules that are no longer on. */
export function keepBounties(serverId: string, live: ReadonlySet<string>): void {
	const mine = memory.get(serverId);
	if (!mine) return;
	for (const id of mine.keys()) if (!live.has(id)) mine.delete(id);
	if (!mine.size) memory.delete(serverId);
}

/** Forgets the tracks of one server (removed from the worker), or of every server. */
export function forgetBounties(serverId?: string): void {
	if (serverId) memory.delete(serverId);
	else memory.clear();
}

// ---- the dry run ----------------------------------------------------------------------------------

/** One thing the replay takes in, in the order it happened. */
export type BountyReplayEvent =
	| {
			kind: 'kills';
			at: number;
			/** the match the batch was stamped with (matchKey) */
			match: string;
			/** players on when the batch came in */
			players: number;
			kills: BountyKill[];
	  }
	| { kind: 'left'; at: number; steamId: string };

export type BountyOutcome =
	| { kind: 'set'; at: number; bounty: OpenBounty; players: number }
	| { kind: 'claim'; at: number; bounty: OpenBounty; claimer: BountyPlayer }
	| { kind: 'lapse'; at: number; bounty: OpenBounty; why: BountyLapse };

/**
 * The live rule over a stretch of history: batches through bountyStep, runs started over and the
 * open bounty lapsed at each new match, and lapsed when its player's session closes.
 */
export function bountyReplay(
	cfg: Pick<BountyConfig, 'streak' | 'minPlayers'>,
	events: BountyReplayEvent[]
): { outcomes: BountyOutcome[]; open: OpenBounty | null } {
	const track: BountyTrack = { runs: new Map(), open: null };
	const outcomes: BountyOutcome[] = [];
	let match: string | null = null;
	for (const e of events) {
		if (e.kind === 'left') {
			if (track.open?.steamId === e.steamId) {
				outcomes.push({ kind: 'lapse', at: e.at, bounty: track.open, why: 'left' });
				track.open = null;
			}
			continue;
		}
		if (match !== null && e.match !== match) {
			if (track.open) outcomes.push({ kind: 'lapse', at: e.at, bounty: track.open, why: 'match' });
			track.open = null;
			track.runs.clear();
		}
		match = e.match;
		for (const x of bountyStep(cfg, track, e.kills, {
			canMark: e.players >= cfg.minPlayers,
			now: e.at
		}))
			outcomes.push(
				x.kind === 'set'
					? { kind: 'set', at: e.at, bounty: { ...x.bounty }, players: e.players }
					: { kind: 'claim', at: e.at, bounty: { ...x.bounty }, claimer: x.claimer }
			);
	}
	return { outcomes, open: track.open };
}
