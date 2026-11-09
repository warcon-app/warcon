// The pure half of the org-list sync: given what an org wants on a server, what the server has,
// and what the panel put there earlier, decide what to add, remove and record. No I/O, so it is
// unit-tested directly; lists-sync.ts does the game-server calls and the database writes.
import type { ListKind } from '$lib/types';

export type Kind = ListKind;

export interface GameFailure {
	status: number;
	code?: string;
	message: string;
}

/**
 * A POST the server refused because the entry is already there counts as applied. A config
 * revision conflict is a 409/412 too but means the entry is *not* there.
 */
export const isAlreadyApplied = (err: GameFailure): boolean =>
	err.code !== 'revision_conflict' &&
	(err.status === 409 || err.code === 'already' || /\balready\b/i.test(err.message));

/**
 * A DELETE the server refused because the entry is not there counts as removed. A 404 for a route
 * the build does not serve (`no_route`, see classifyGameError) is not that.
 */
export const isGone = (err: GameFailure): boolean =>
	(err.status === 404 || err.code === 'not_found') && err.code !== 'no_route';

/** The server could not be reached or answered with a server-side error: stop the run, keep what succeeded. */
export const isUnreachable = (err: GameFailure): boolean =>
	err.status === 502 ||
	err.status >= 500 ||
	err.status === 429 ||
	err.code === 'unreachable' ||
	err.code === 'rate_limited';

export interface EntryLike {
	removedAt: Date | null;
	expiresAt: Date | null;
}

/** Entries still in force: not removed, not past their expiry. */
export const activeEntries = <T extends EntryLike>(rows: T[], now: Date): T[] =>
	rows.filter((r) => !r.removedAt && (!r.expiresAt || r.expiresAt.getTime() > now.getTime()));

export interface DesiredBan {
	steamId: string;
	reason: string;
	listId: string;
}

/** An active entry with the list it is on, as desiredOf takes it. */
export interface DesiredEntry {
	kind: Kind;
	steamId: string;
	reason: string;
	listId: string;
	/** the list's server, when the list belongs to one server; null for an org list */
	serverId: string | null;
	/** the org's default list of the kind; an org list that is not is a reserved-slot group */
	isDefault: boolean;
	/** the list's name, which orders groups */
	listName: string;
}

/**
 * Whether a list is on at `now`. The default lists and the servers' own are always on; a group is
 * on inside its window and never once archived. This and listOnAt (lists-sync.ts) are the only
 * judges of it.
 */
export const isListOn = (
	l: { archivedAt: Date | null; onFrom: Date | null; onUntil: Date | null },
	now: Date
): boolean =>
	!l.archivedAt &&
	(!l.onFrom || l.onFrom.getTime() <= now.getTime()) &&
	(!l.onUntil || now.getTime() < l.onUntil.getTime());

/** The default list first, then the groups by name, then the server's own. */
const attribution = (r: DesiredEntry): number => (r.serverId !== null ? 2 : r.isDefault ? 0 : 1);

/**
 * The bans and reserved slots a server's lists want on it, one per player and kind: a player on
 * several lists is wanted once, from the org's default list, else the first group by name, else
 * the server's own, so taking them off one list leaves the others in force (the next sync
 * re-attributes the slot, which is no game call).
 */
export function desiredOf(rows: DesiredEntry[]): {
	bans: DesiredBan[];
	reserved: DesiredReserve[];
} {
	const bans = new Map<string, DesiredBan>();
	const reserved = new Map<string, DesiredReserve>();
	const ordered = [...rows].sort(
		(a, b) =>
			attribution(a) - attribution(b) ||
			a.listName.localeCompare(b.listName) ||
			a.listId.localeCompare(b.listId)
	);
	for (const r of ordered) {
		if (r.kind === 'ban') {
			if (!bans.has(r.steamId))
				bans.set(r.steamId, { steamId: r.steamId, reason: r.reason, listId: r.listId });
			continue;
		}
		// a slot goes in as early as the most pressing list that wants it
		const priority =
			r.serverId !== null ? PRIORITY.server : r.isDefault ? PRIORITY.org : PRIORITY.group;
		const held = reserved.get(r.steamId);
		if (held) held.priority = Math.min(held.priority, priority);
		else reserved.set(r.steamId, { steamId: r.steamId, listId: r.listId, member: false, priority });
	}
	return { bans: [...bans.values()], reserved: [...reserved.values()] };
}

/**
 * Which adds go in first when a server's config document has no room for them all (the listener
 * takes a body of 64 KB at most): a server's own slots, then the org's default list, then its
 * groups, then members' slots. Lower goes first.
 */
export const PRIORITY = { server: 0, org: 1, group: 2, member: 3 } as const;

export interface DesiredReserve {
	steamId: string;
	listId: string;
	/** a slot the org hands its members, not an entry someone added */
	member: boolean;
	/** see PRIORITY */
	priority: number;
}

export interface StateLike {
	kind: Kind;
	steamId: string;
	sourceListId: string | null;
	state: 'applied' | 'failed';
	error: string;
	attemptedAt: Date | null;
}

export interface PlanInput {
	now: Date;
	/** how long a failed add or remove waits before it is tried again */
	retryAfterMs: number;
	desired: { bans: DesiredBan[]; reserved: DesiredReserve[] };
	/** the reserved list the server will start with: its config document, where the build has one */
	observed: { reserved: string[] };
	state: StateLike[];
}

export interface PlanAdd {
	kind: Kind;
	steamId: string;
	listId: string;
	reason: string;
	/** see PRIORITY */
	priority: number;
}

export interface PlanRef {
	kind: Kind;
	steamId: string;
}

export interface SyncPlan {
	/** to POST (after the removes) */
	adds: PlanAdd[];
	/** to DELETE: the panel put them there and they are no longer wanted */
	removes: PlanRef[];
	/** managed rows whose entry is present and wanted: make sure the state row says applied */
	confirms: PlanAdd[];
	/** managed rows that are neither wanted nor present any more: drop them */
	deletes: PlanRef[];
	/** wanted entries already on the server but not put there by the panel: left alone */
	local: PlanRef[];
}

const byKind = (rows: StateLike[], kind: Kind) =>
	new Map(rows.filter((r) => r.kind === kind).map((r) => [r.steamId, r]));

const withinBackoff = (s: StateLike | undefined, now: Date, retryAfterMs: number): boolean =>
	!!s &&
	s.state === 'failed' &&
	!!s.attemptedAt &&
	now.getTime() - s.attemptedAt.getTime() < retryAfterMs;

export function planSync(i: PlanInput): SyncPlan {
	const plan: SyncPlan = {
		adds: [],
		removes: [],
		confirms: [],
		deletes: [],
		local: []
	};

	const settle = (
		kind: Kind,
		desired: PlanAdd[],
		observed: Set<string>,
		state: Map<string, StateLike>
	): PlanAdd[] => {
		const wanted = new Map(desired.map((d) => [d.steamId, d]));
		const toAdd: PlanAdd[] = [];
		for (const d of desired) {
			const s = state.get(d.steamId);
			if (s) {
				if (observed.has(d.steamId)) {
					if (s.state !== 'applied' || s.sourceListId !== d.listId) plan.confirms.push(d);
				} else if (!withinBackoff(s, i.now, i.retryAfterMs)) toAdd.push(d);
			} else if (observed.has(d.steamId)) plan.local.push({ kind, steamId: d.steamId });
			else toAdd.push(d);
		}
		for (const s of state.values()) {
			if (wanted.has(s.steamId)) continue;
			if (observed.has(s.steamId)) {
				if (!withinBackoff(s, i.now, i.retryAfterMs))
					plan.removes.push({ kind, steamId: s.steamId });
			} else plan.deletes.push({ kind, steamId: s.steamId });
		}
		return toAdd;
	};

	// Bans are not planned: the panel enforces them itself (kickBanned in lists-sync.ts) and leaves
	// the game's own ban list to whoever runs the server.
	// The reserved list is unbounded on the game server (MaxReservedSlots holds player slots back
	// for its members; it does not cap the list), so every wanted slot is added.
	plan.adds.push(
		...settle(
			'reserve',
			i.desired.reserved.map((d) => ({
				kind: 'reserve' as const,
				steamId: d.steamId,
				listId: d.listId,
				reason: '',
				priority: d.priority
			})),
			new Set(i.observed.reserved),
			byKind(i.state, 'reserve')
		)
	);
	return plan;
}

export const planHasWork = (p: SyncPlan): boolean => p.adds.length > 0 || p.removes.length > 0;

/** A ban the lists put on a server, as the worker holds it between syncs (see kickBanned). */
export interface PanelBan {
	steamId: string;
	listId: string;
	/** a kick the game refused: not tried again before this time */
	retryAt?: number;
}
