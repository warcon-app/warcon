// The poller's scheduling maths, kept pure so it can be tested without a database: which phase
// of the interval a server polls on, when it is next due, and which due servers to launch on a
// beat under the concurrency budget.

export interface Slot {
	id: string;
	/** next time the server is due (ms since epoch), or null until it has been scheduled */
	dueAt: number | null;
	/** a poll is already running for this server */
	inFlight: boolean;
	/** the last polls failed: it competes only for the offline share of the budget */
	offline: boolean;
}

export interface Budget {
	/** polls that may run at once, across every server */
	total: number;
	/** polls running now */
	active: number;
	/** of those, polls of servers marked offline */
	offlineActive: number;
	/** at most this fraction of `total` may be spent on offline servers (0..1) */
	offlineShare: number;
}

/**
 * A stable phase for this server within the interval, so restarts keep the same spread and a
 * thousand servers do not all fire on the same beat. FNV-1a over the id.
 */
export function phaseOffset(id: string, intervalMs: number): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return intervalMs > 0 ? h % intervalMs : 0;
}

/**
 * The next due time after a launch: one interval on from the previous due time (fixed cadence,
 * no drift), unless that is already in the past, in which case one interval from now: a server
 * that fell behind catches up at its normal pace instead of firing back-to-back.
 */
export function nextDue(dueAt: number, intervalMs: number, now: number): number {
	const next = dueAt + intervalMs;
	return next > now ? next : now + intervalMs;
}

/** How many of the budget's slots offline servers may hold at once (always at least one). */
export function offlineLimit(budget: Pick<Budget, 'total' | 'offlineShare'>): number {
	return Math.max(1, Math.floor(budget.total * budget.offlineShare));
}

/**
 * The servers to launch on this beat: every due server that is not already running, most overdue
 * first, as far as the budget allows. Offline servers (whose polls sit on a connect timeout) can
 * only take their share of the slots, so a wave of unreachable hosts never starves the ones that
 * answer.
 */
export function pickDue<T extends Slot>(slots: readonly T[], now: number, budget: Budget): T[] {
	const due = slots
		.filter((s) => !s.inFlight && s.dueAt !== null && s.dueAt <= now)
		.sort((a, b) => a.dueAt! - b.dueAt!);
	const picked: T[] = [];
	let free = budget.total - budget.active;
	let offlineFree = offlineLimit(budget) - budget.offlineActive;
	for (const s of due) {
		if (free <= 0) break;
		if (s.offline) {
			if (offlineFree <= 0) continue;
			offlineFree--;
		}
		free--;
		picked.push(s);
	}
	return picked;
}
