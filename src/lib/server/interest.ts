// Interest leases: which servers someone is looking at right now. A browser with a server's page
// open keeps a live-events stream up, and that stream renews the lease; the worker moves such
// servers to the watched tier. Held in the worker's memory (the web process forwards leases when
// it runs separately).

const leases = new Map<string, number>();

/** Extends the lease on these servers to now + ttl. */
export function touchInterest(ids: Iterable<string>, ttlMs: number, now = Date.now()): void {
	const until = now + ttlMs;
	for (const id of ids) leases.set(id, until);
}

export function isWatched(id: string, now = Date.now()): boolean {
	const until = leases.get(id);
	if (until === undefined) return false;
	if (until <= now) {
		leases.delete(id);
		return false;
	}
	return true;
}

/** Server ids with a live lease. */
export function watchedIds(now = Date.now()): string[] {
	const out: string[] = [];
	for (const [id, until] of leases) {
		if (until > now) out.push(id);
		else leases.delete(id);
	}
	return out;
}

export function watchedCount(now = Date.now()): number {
	return watchedIds(now).length;
}
