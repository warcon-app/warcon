// The Team balance rule's pure part (kind `two_teams`, first built as Two-team mode). Two jobs, either
// or both: a closed faction, whose players are moved to the smaller of the others, so a
// three-faction server plays as two big teams; and balancing, which keeps the open sides within a
// few players of each other without taking anyone out of a fight. A player who is playing is never
// moved mid-match: balancing places a player when they arrive, puts back a player who switches
// onto the bigger side themselves, and evens everyone up when a new match starts. The game has no
// two-team setting of its own; its overpopulation lock sends joiners to the closed, empty faction,
// and this rule places them from there. No database, no game server: triggers.ts runs the step on
// each fresh player list, keeps its state in the worker's memory and writes the moves to the
// outbox.
import { settingsFingerprint } from './fingerprint';
import { ApiError, str } from './http';
import { MAX_CHAT } from '$lib/chat';

/** How long a move is waited on before it is asked for again (the player is still on the closed faction). */
export const TWO_TEAMS_RETRY_MS = 30_000;
/** A placed player is told once; the note is forgotten after this long away, so a return next day is told again. */
export const TWO_TEAMS_FORGET_MS = 2 * 3600_000;
/**
 * Moves asked for per second of the player-list cadence. Each move is two game requests (move,
 * then kill), so a full server's sort at a match start goes out over half a minute instead of at
 * once, under the listener's limit on requests from one address.
 */
export const TWO_TEAMS_MOVES_PER_SECOND = 3;
/**
 * The most moves one look asks for, whatever its cadence: the first look with players back after a
 * map load comes at the idle cadence (30 s), which would otherwise let most of a server go at once.
 */
export const TWO_TEAMS_MAX_MOVES_PER_LOOK = 6;
/**
 * A player asked to move this many times within TWO_TEAMS_ASK_WINDOW_MS is left where they are
 * until the window passes: something keeps putting them back, and every move kills them.
 */
export const TWO_TEAMS_MAX_ASKS = 3;
export const TWO_TEAMS_ASK_WINDOW_MS = 10 * 60_000;
/**
 * How long the side a player was placed on is kept while they are away: the list empties for half
 * a minute at a map change, and a player who leaves and rejoins on the bigger side is still put
 * back.
 */
export const TWO_TEAMS_SIDE_FORGET_MS = 10 * 60_000;
/** How long after a person moves a player from the panel the rule takes the new side as placed. */
export const TWO_TEAMS_STAFF_MOVE_MS = 2 * 60_000;
/**
 * After a match ends, placing waits this long while a quarter or more of the list has not picked a
 * side yet (the game holds players on a side of its own between matches): the first to pick are
 * not moved on counts the rest are about to change.
 */
export const TWO_TEAMS_PICK_HOLD_MS = 30_000;
export const TWO_TEAMS_DEFAULT_GAP = 3;
export const TWO_TEAMS_MAX_GAP = 20;
export const TWO_TEAMS_MAX_EXEMPT = 100;

export interface TwoTeamsConfig {
	/** the faction nobody plays on, '' for none; its players are moved off it */
	closedFaction: string;
	/** what players are told the open factions are called, by faction ('' keeps the faction name) */
	names: Record<string, string>;
	/** whispered once a moved player lands, with {team}; '' sends nothing */
	message: string;
	/** keep the open sides within `gap` players of each other (absent on rules saved before it) */
	balance?: boolean;
	/** the most the open sides may differ by before balancing moves anyone */
	gap?: number;
	/** place a player on the side most of their clan tag is on, when the gap allows */
	clans?: boolean;
	/** SteamIDs the rule never moves */
	exempt?: string[];
	/** decide and record each move, send none */
	watchOnly?: boolean;
}

export function validateTwoTeams(c: Record<string, unknown>): TwoTeamsConfig {
	const closedFaction = str(c.closedFaction, 100);
	const balance = c.balance === true;
	if (!closedFaction && !balance)
		throw new ApiError(400, 'Close a faction, keep the sides even, or both.');
	const names: Record<string, string> = {};
	if (c.names && typeof c.names === 'object')
		for (const [k, v] of Object.entries(c.names as Record<string, unknown>).slice(0, 8)) {
			const faction = str(k, 100);
			const name = str(v, 40);
			if (faction && name && faction !== closedFaction) names[faction] = name;
		}
	const asked =
		c.gap === undefined || c.gap === null || c.gap === '' ? TWO_TEAMS_DEFAULT_GAP : c.gap;
	const valid =
		Number.isInteger(asked) && (asked as number) >= 1 && (asked as number) <= TWO_TEAMS_MAX_GAP;
	// only a balancing rule uses it; without balancing a blank or stray value keeps the default
	if (!valid && balance)
		throw new ApiError(400, `The sides may differ by 1 to ${TWO_TEAMS_MAX_GAP} players.`);
	const gap = valid ? (asked as number) : TWO_TEAMS_DEFAULT_GAP;
	if (c.exempt !== undefined && !Array.isArray(c.exempt))
		throw new ApiError(400, 'exempt must be a list of SteamID64s.');
	const exempt = [...new Set(((c.exempt as unknown[]) ?? []).map((v) => str(v, 32)))].filter(
		Boolean
	);
	const bad = exempt.find((id) => !/^\d{17}$/.test(id));
	if (bad !== undefined)
		throw new ApiError(400, `"${bad.slice(0, 20)}" is not a SteamID64 (17 digits).`);
	if (exempt.length > TWO_TEAMS_MAX_EXEMPT)
		throw new ApiError(400, `At most ${TWO_TEAMS_MAX_EXEMPT} players can be left alone.`);
	return {
		closedFaction,
		names,
		message: str(c.message, MAX_CHAT),
		balance,
		gap,
		clans: c.clans === true,
		exempt,
		watchOnly: c.watchOnly === true
	};
}

/**
 * A short fingerprint of a rule's settings. Each move and whisper carries the one it was decided
 * under, so delivery can tell a row decided before the settings changed.
 */
export const twoTeamsSettingsKey = (cfg: TwoTeamsConfig): string => settingsFingerprint(cfg);

/**
 * A player's clan tag: a short tag in brackets at the front of the name ("[ABC] Name", "{ABC}Name"),
 * in one case, or null.
 */
export function clanTag(name: string): string | null {
	const m = /^\s*(?:\[([^\]]{1,12})\]|\{([^}]{1,12})\}|\(([^)]{1,12})\)|<([^>]{1,12})>)/u.exec(
		name
	);
	const tag = (m?.[1] ?? m?.[2] ?? m?.[3] ?? m?.[4] ?? '').normalize('NFKC').trim().toLowerCase();
	return tag || null;
}

/** What the rule remembers between player lists (the worker's memory, per rule). */
export interface TwoTeamsState {
	/**
	 * moves asked for and not yet seen landed: SteamID -> the faction they were on, the target, when,
	 * and the look that decided it (`seq`, which delivery matches the row against)
	 */
	moving: Map<string, { from: string; to: string; at: number; seq: number }>;
	/** placed players already told where they went, when there is a whisper: SteamID -> last seen */
	told: Map<string, number>;
	/** when each player was asked to move within TWO_TEAMS_ASK_WINDOW_MS, oldest first */
	asked: Map<string, number[]>;
	/** players left where they are for being asked too often (said once, in `stopped`) */
	capped: Set<string>;
	/**
	 * Balancing: the side each player was placed on (null: to be placed, as after a match ends) and
	 * when they were last on the list. A player not in it is new and is placed when they pick a side.
	 * Closing a faction only: the side a move of this match put each player on, which a player back
	 * on the closed faction is returned to.
	 */
	sides: Map<string, { side: string | null; seen: number }>;
	/** balancing: whoever was on when the rule first looked has been taken as placed */
	seeded: boolean;
	/** balancing: after a match end, placing waits until most have picked a side, or until this */
	holdUntil: number;
	/** balancing: a match end whose hold starts with the first list that has anyone on it */
	holdPending: boolean;
	/** watch only: where the rule would have put each player, while they are still where it found them */
	would: Map<string, { from: string; to: string; seen: number }>;
}

export const emptyTwoTeamsState = (): TwoTeamsState => ({
	moving: new Map(),
	told: new Map(),
	asked: new Map(),
	capped: new Set(),
	sides: new Map(),
	seeded: false,
	holdUntil: 0,
	holdPending: false,
	would: new Map()
});

/** Why a player is moved: off the closed faction, placed on a side, or put back after a switch. */
export type TwoTeamsReason = 'closed' | 'placed' | 'back';

export interface TwoTeamsStep {
	state: TwoTeamsState;
	/** players to move now, and where */
	moves: { steamId: string; name: string; from: string; to: string; why: TwoTeamsReason }[];
	/** moved players now on their side and not told yet */
	whispers: { steamId: string; name: string; faction: string }[];
	/** players the rule has just stopped moving for being asked too often */
	stopped: { steamId: string; name: string; faction: string }[];
}

export interface TwoTeamsLook {
	/** a match ended since the previous look: everyone is placed again */
	newMatch?: boolean;
	/** which look of the rule's memory this is; each move records it for delivery to match */
	seq?: number;
	/** players a person moved from the panel lately: SteamID -> the faction and when */
	staffMoves?: ReadonlyMap<string, { faction: string; at: number }>;
}

/**
 * The side to put a player on: their clan's side, else the one they are on, else the lightest,
 * whichever first keeps the open sides within the gap; when none does, the one that leaves them
 * closest. `counts` holds everyone, the player included on `current` when that is an open side.
 */
function chooseSide(
	counts: Map<string, number>,
	current: string | null,
	clanSide: string | null,
	gap: number,
	random: () => number
): string {
	const base = new Map(counts);
	if (current !== null && base.has(current)) base.set(current, base.get(current)! - 1);
	const spreadWith = (x: string) => {
		let max = -Infinity;
		let min = Infinity;
		for (const [f, n] of base) {
			const v = n + (f === x ? 1 : 0);
			if (v > max) max = v;
			if (v < min) min = v;
		}
		return max - min;
	};
	const order = new Map([...base.keys()].map((f) => [f, random()]));
	const lightest = [...base.keys()].sort(
		(a, b) => base.get(a)! - base.get(b)! || order.get(a)! - order.get(b)!
	);
	const prefs = [
		...new Set(
			[clanSide, current, ...lightest].filter((f): f is string => f !== null && base.has(f))
		)
	];
	for (const f of prefs) if (spreadWith(f) <= gap) return f;
	return prefs.reduce((best, f) => (spreadWith(f) < spreadWith(best) ? f : best));
}

/**
 * One fresh player list. `open` is the factions players are placed on (the match's factions
 * minus the closed one); at most `maxMoves` moves are asked for. Players already being moved count
 * toward their target, so a burst at a match start splits evenly; a move not seen landed after
 * TWO_TEAMS_RETRY_MS is asked for again. Without balancing, only the closed faction's players move.
 */
export function twoTeamsStep(
	cfg: TwoTeamsConfig,
	previous: TwoTeamsState,
	listed: { steamId: string; name: string; faction: string | null }[],
	open: string[],
	now: number,
	maxMoves: number,
	look: TwoTeamsLook = {},
	random: () => number = Math.random
): TwoTeamsStep {
	const state: TwoTeamsState = {
		moving: new Map(previous.moving),
		told: new Map(previous.told),
		asked: new Map(previous.asked),
		capped: new Set(previous.capped),
		sides: new Map(previous.sides),
		seeded: previous.seeded,
		holdUntil: previous.holdUntil,
		holdPending: previous.holdPending,
		would: new Map(previous.would)
	};
	const moves: TwoTeamsStep['moves'] = [];
	const whispers: TwoTeamsStep['whispers'] = [];
	const stopped: TwoTeamsStep['stopped'] = [];
	const balance = !!cfg.balance;
	const watch = !!cfg.watchOnly;
	const gap = cfg.gap ?? TWO_TEAMS_DEFAULT_GAP;
	const exempt = new Set(cfg.exempt ?? []);
	const isOpen = (f: string | null): f is string => f !== null && open.includes(f);

	// Away long enough (last on a list that long ago), a player is forgotten before this list is
	// read: back now, they are new.
	for (const [id, seen] of state.told) if (now - seen > TWO_TEAMS_FORGET_MS) state.told.delete(id);
	for (const [id, s] of state.sides)
		if (now - s.seen > TWO_TEAMS_SIDE_FORGET_MS) state.sides.delete(id);
	for (const [id, w] of state.would)
		if (now - w.seen > TWO_TEAMS_SIDE_FORGET_MS) state.would.delete(id);

	// Watch only: a player the rule would have moved is taken to be where it would have put them,
	// for as long as they are still where it found them; a new match starts from where they are.
	if (look.newMatch) state.would.clear();
	const players = listed.map((p) => {
		const w = state.would.get(p.steamId);
		if (!w) return p;
		if (p.faction !== w.from) {
			state.would.delete(p.steamId);
			return p;
		}
		state.would.set(p.steamId, { ...w, seen: now });
		return { ...p, faction: w.to };
	});

	const counts = new Map(open.map((f) => [f, 0]));
	for (const p of players) if (isOpen(p.faction)) counts.set(p.faction, counts.get(p.faction)! + 1);

	for (const p of players) {
		// Landed (or placed by hand meanwhile): the move is done; with a whisper, tell them once.
		const m = state.moving.get(p.steamId);
		const landed = !!m && isOpen(p.faction) && p.faction !== m.from;
		if (landed) state.moving.delete(p.steamId);
		if (balance) {
			const staff = look.staffMoves?.get(p.steamId);
			const byStaff =
				!!staff && staff.faction === p.faction && now - staff.at < TWO_TEAMS_STAFF_MOVE_MS;
			if (byStaff) state.moving.delete(p.steamId);
			const known = state.sides.get(p.steamId);
			// Placed: on the side a move put them, the side a person moved them to, or, for a player
			// the rule never moves, wherever they are.
			const side =
				isOpen(p.faction) && (landed || byStaff || exempt.has(p.steamId))
					? p.faction
					: (known?.side ?? null);
			state.sides.set(p.steamId, { side, seen: now });
		} else {
			// Closing a faction only: the side a move of this match put them on, kept while they are on.
			const known = state.sides.get(p.steamId);
			if (landed) state.sides.set(p.steamId, { side: p.faction, seen: now });
			else if (known) state.sides.set(p.steamId, { side: known.side, seen: now });
		}
		// No whisper on a match end's look: a move of the match that ended may land on it, and the new
		// match may move the player again at once.
		if (!cfg.message || watch || look.newMatch) continue;
		if (landed && !state.told.has(p.steamId))
			whispers.push({ steamId: p.steamId, name: p.name, faction: p.faction! });
		if (landed || state.told.has(p.steamId)) state.told.set(p.steamId, now);
	}
	for (const [id, m] of state.moving) if (now - m.at >= TWO_TEAMS_RETRY_MS) state.moving.delete(id);
	for (const [id, times] of state.asked) {
		const recent = times.filter((t) => now - t < TWO_TEAMS_ASK_WINDOW_MS);
		if (recent.length) state.asked.set(id, recent);
		else state.asked.delete(id);
	}
	for (const id of state.capped)
		if ((state.asked.get(id)?.length ?? 0) < TWO_TEAMS_MAX_ASKS) state.capped.delete(id);

	if (open.length < 2) return { state, moves, whispers, stopped };

	/** Players the rule leaves alone this look: a move of theirs is on its way, or it never moves them. */
	const waiting = (p: { steamId: string }) => state.moving.has(p.steamId) || exempt.has(p.steamId);
	// A move decided in the match that ended is no longer wanted (delivery drops its row from the
	// moment the match end is seen): the new match is decided on its own counts.
	if (look.newMatch) {
		state.moving.clear();
		// Players pick a side again in the new match: where the last one put them is forgotten.
		if (!balance) state.sides.clear();
	}
	/** players on no side yet: the game's holding side, or none (the closed faction is a side) */
	const unpicked = players.filter((p) => p.faction !== cfg.closedFaction && !isOpen(p.faction));
	if (balance) {
		// The first look with anyone on a side takes them as placed: whatever state the match is in,
		// it is not this rule's to reshuffle; balancing starts with the next arrival and the next match.
		// Many still picking means a match is starting: placing holds as after a match end.
		if (!state.seeded) {
			if (players.some((p) => isOpen(p.faction))) {
				state.seeded = true;
				for (const p of players)
					if (isOpen(p.faction)) state.sides.set(p.steamId, { side: p.faction, seen: now });
				if (unpicked.length * 4 >= players.length) state.holdUntil = now + TWO_TEAMS_PICK_HOLD_MS;
			}
		} else if (look.newMatch) {
			for (const [id, s] of state.sides) state.sides.set(id, { side: null, seen: s.seen });
			// The list is empty while the next map loads: the hold starts once players are back.
			state.holdPending = true;
		}
		if (state.holdPending && players.length) {
			state.holdPending = false;
			state.holdUntil = now + TWO_TEAMS_PICK_HOLD_MS;
		}
	}

	// Moves still in flight count toward their side before anyone new is placed.
	for (const p of players) {
		const m = state.moving.get(p.steamId);
		if (!m || !counts.has(m.to) || p.faction === m.to) continue;
		counts.set(m.to, counts.get(m.to)! + 1);
		if (isOpen(p.faction)) counts.set(p.faction, counts.get(p.faction)! - 1);
	}

	// Clan tags by side, players in flight on the side they are going to.
	const clans = new Map<string, Map<string, number>>();
	if (balance && cfg.clans)
		for (const p of players) {
			const tag = clanTag(p.name);
			const at = state.moving.get(p.steamId)?.to ?? p.faction;
			if (!tag || !isOpen(at)) continue;
			const sides = clans.get(tag) ?? clans.set(tag, new Map()).get(tag)!;
			sides.set(at, (sides.get(at) ?? 0) + 1);
		}
	/** The side most of a player's clan is on, the player left out; null on a tie or alone. */
	const clanSideOf = (p: { name: string; faction: string | null }): string | null => {
		const sides = clans.get(clanTag(p.name) ?? '');
		if (!sides) return null;
		let best: string | null = null;
		let most = 0;
		let tie = false;
		for (const [f, n] of sides) {
			const c = n - (f === p.faction ? 1 : 0);
			if (c > most) [best, most, tie] = [f, c, false];
			else if (c === most && c > 0) tie = true;
		}
		return tie ? null : best;
	};

	const move = (
		p: { steamId: string; name: string; faction: string | null },
		to: string,
		why: TwoTeamsReason
	) => {
		const times = state.asked.get(p.steamId) ?? [];
		if (times.length >= TWO_TEAMS_MAX_ASKS) {
			if (!state.capped.has(p.steamId)) {
				state.capped.add(p.steamId);
				stopped.push({ steamId: p.steamId, name: p.name, faction: p.faction! });
			}
			return;
		}
		if (moves.length >= maxMoves) return;
		if (isOpen(p.faction)) counts.set(p.faction, counts.get(p.faction)! - 1);
		counts.set(to, counts.get(to)! + 1);
		// Their clan's count goes with them, so a clanmate placed after them in this look finds them.
		const tag = balance && cfg.clans ? clanTag(p.name) : null;
		if (tag) {
			const mates = clans.get(tag) ?? clans.set(tag, new Map()).get(tag)!;
			if (isOpen(p.faction)) mates.set(p.faction, (mates.get(p.faction) ?? 1) - 1);
			mates.set(to, (mates.get(to) ?? 0) + 1);
		}
		state.asked.set(p.steamId, [...times, now]);
		if (watch) {
			// Nothing is sent: take them as placed where they would have gone.
			state.would.set(p.steamId, { from: p.faction!, to, seen: now });
			if (balance) state.sides.set(p.steamId, { side: to, seen: now });
		} else state.moving.set(p.steamId, { from: p.faction!, to, at: now, seq: look.seq ?? 0 });
		moves.push({ steamId: p.steamId, name: p.name, from: p.faction!, to, why });
	};

	// The closed faction first: nobody plays there. A player placed earlier in this match goes back
	// to the same side while that keeps within the gap: picking the closed faction again is no way
	// to be dealt another side.
	if (cfg.closedFaction)
		for (const p of players)
			if (p.faction === cfg.closedFaction && !waiting(p)) {
				const kept = state.sides.get(p.steamId)?.side ?? null;
				const prefer = isOpen(kept) ? kept : balance && cfg.clans ? clanSideOf(p) : null;
				move(p, chooseSide(counts, null, prefer, gap, random), 'closed');
			}
	if (!balance) return { state, moves, whispers, stopped };

	// A placed player on another side switched themselves: fine onto a side no bigger than the gap
	// allows over the one they left, else they are put back.
	for (const p of players) {
		const placed = state.sides.get(p.steamId)?.side ?? null;
		if (waiting(p) || !isOpen(p.faction) || placed === null || placed === p.faction) continue;
		if (isOpen(placed) && counts.get(p.faction)! - counts.get(placed)! > gap)
			move(p, placed, 'back');
		else state.sides.set(p.steamId, { side: p.faction, seen: now });
	}
	// Arrivals, and everyone after a match ends: kept where they are while the sides stay within the
	// gap (or with their clan), else placed on the lighter side. Right after a match end, not while a
	// quarter or more have yet to pick a side. In no set order: the game's list order would make the
	// same players the ones moved at every match start.
	if ((state.holdPending || now < state.holdUntil) && unpicked.length * 4 >= players.length)
		return { state, moves, whispers, stopped };
	const shuffled = players
		.map((p) => ({ p, k: random() }))
		.sort((a, b) => a.k - b.k)
		.map((x) => x.p);
	for (const p of shuffled) {
		if (waiting(p) || !isOpen(p.faction) || (state.sides.get(p.steamId)?.side ?? null) !== null)
			continue;
		const to = chooseSide(counts, p.faction, cfg.clans ? clanSideOf(p) : null, gap, random);
		if (to === p.faction) state.sides.set(p.steamId, { side: to, seen: now });
		else move(p, to, 'placed');
	}
	return { state, moves, whispers, stopped };
}

/** What players are told a faction is called. */
export const teamName = (cfg: TwoTeamsConfig, faction: string): string =>
	(Object.hasOwn(cfg.names, faction) && cfg.names[faction]) || faction;
