// The pure half of the org-list sync: given what an org wants on a server, what the server has,
// and what the panel put there earlier, decide what to add, remove and record. No I/O, so it is
// unit-tested directly; lists-sync.ts does the game-server calls and the database writes.
import type { ListKind } from '$lib/types';

export type Kind = ListKind;

/** What a failed reserved-slot add says when the server is full; the planner recomputes these each run instead of backing off. */
export const RESERVED_FULL = 'Reserved slots are full';

/** MaxReservedSlots from a ServerSettings.ini document, if the WDGameSession section sets it. */
export function parseMaxReservedSlots(text: string): number | null {
	let inSection = false;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith(';') || line.startsWith('#')) continue;
		if (line.startsWith('[')) {
			inSection = /^\[\/Script\/WDGame\.WDGameSession\]$/i.test(line);
			continue;
		}
		if (!inSection) continue;
		const m = /^MaxReservedSlots\s*=\s*(\d+)\s*$/i.exec(line);
		if (m) return Number(m[1]);
	}
	return null;
}

export interface GameFailure {
	status: number;
	code?: string;
	message: string;
}

/** A POST the server refused because the entry is already there counts as applied. */
export const isAlreadyApplied = (err: GameFailure): boolean =>
	err.status === 409 || err.code === 'already' || /\balready\b/i.test(err.message);

/** A DELETE the server refused because the entry is not there counts as removed. */
export const isGone = (err: GameFailure): boolean => err.status === 404 || err.code === 'not_found';

/** The server could not be reached or answered with a server-side error: stop the run, keep what succeeded. */
export const isUnreachable = (err: GameFailure): boolean =>
	err.status === 502 || err.status >= 500 || err.code === 'unreachable';

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

export interface DesiredReserve {
	steamId: string;
	listId: string;
	priority: number;
	addedAt: Date;
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
	/** MaxReservedSlots on this server; null = unknown or unlimited */
	cap: number | null;
	/** how long a failed add or remove waits before it is tried again */
	retryAfterMs: number;
	desired: { bans: DesiredBan[]; reserved: DesiredReserve[] };
	observed: { bans: string[]; reserved: string[] };
	state: StateLike[];
}

export interface PlanAdd {
	kind: Kind;
	steamId: string;
	listId: string;
	reason: string;
}

export interface PlanRef {
	kind: Kind;
	steamId: string;
}

export interface SyncPlan {
	/** to POST, removes first so a freed reserved slot can be reused in the same run */
	adds: PlanAdd[];
	/** to DELETE: the panel put them there and they are no longer wanted */
	removes: PlanRef[];
	/** managed rows whose entry is present and wanted: make sure the state row says applied */
	confirms: PlanAdd[];
	/** managed rows that are neither wanted nor present any more: drop them */
	deletes: PlanRef[];
	/** wanted reserved slots that do not fit under the cap: record as failed, no call */
	overflow: (PlanAdd & { error: string })[];
	/** wanted entries already on the server but not put there by the panel: left alone */
	local: PlanRef[];
	/** what the reserved list on the server will hold after the run (for the cap display) */
	reservedUsed: number;
}

const byKind = (rows: StateLike[], kind: Kind) =>
	new Map(rows.filter((r) => r.kind === kind).map((r) => [r.steamId, r]));

const withinBackoff = (s: StateLike | undefined, now: Date, retryAfterMs: number): boolean =>
	!!s &&
	s.state === 'failed' &&
	!s.error.startsWith(RESERVED_FULL) &&
	!!s.attemptedAt &&
	now.getTime() - s.attemptedAt.getTime() < retryAfterMs;

export function planSync(i: PlanInput): SyncPlan {
	const plan: SyncPlan = {
		adds: [],
		removes: [],
		confirms: [],
		deletes: [],
		overflow: [],
		local: [],
		reservedUsed: 0
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

	const banAdds = settle(
		'ban',
		i.desired.bans.map((d) => ({ kind: 'ban', ...d })),
		new Set(i.observed.bans),
		byKind(i.state, 'ban')
	);
	plan.adds.push(...banAdds);

	const reserved = new Set(i.observed.reserved);
	const reserveDesired = [...i.desired.reserved]
		.sort((a, b) => b.priority - a.priority || a.addedAt.getTime() - b.addedAt.getTime())
		.map((d) => ({ kind: 'reserve' as const, steamId: d.steamId, listId: d.listId, reason: '' }));
	const reserveAdds = settle('reserve', reserveDesired, reserved, byKind(i.state, 'reserve'));
	const removing = plan.removes.filter((r) => r.kind === 'reserve').length;
	let used = reserved.size - removing;
	const room = i.cap === null ? Infinity : Math.max(0, i.cap - used);
	// reserveAdds keeps the priority order of reserveDesired
	for (const [n, add] of reserveAdds.entries()) {
		if (n < room) {
			plan.adds.push(add);
			used++;
		} else {
			plan.overflow.push({ ...add, error: `${RESERVED_FULL} (${i.cap}/${i.cap}).` });
		}
	}
	plan.reservedUsed = used;
	return plan;
}

export const planHasWork = (p: SyncPlan): boolean => p.adds.length > 0 || p.removes.length > 0;
