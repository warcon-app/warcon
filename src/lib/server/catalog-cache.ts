// The per-server catalog and feature flags the server layout needs on every page: they change
// with plugin builds, not with matches, so one read per server per hour per web process. A game
// reads its build and its allow lists (the maps, game modes and lightings it lists) when it
// starts, so an entry read before its last start is due for another read at once: the first page
// after a restart reads again, and a map the host has just been given is in the pickers then, not
// within the hour. While that read fails (a game that is down again) the entry it would replace
// still serves, and the read is tried again no sooner than every half minute. A connection test
// forgets the entry.
import type { Catalog, Features } from '$lib/types';

const CATALOG_TTL_MS = 3600_000;
/**
 * A start this much later than the one an entry was read under is another run of the game; less
 * is the same start seen again (as NEW_START_MS in observe.ts, where the start is worked out).
 */
const NEW_RUN_MS = 60_000;
/** After a read that failed, how long the entry in hand serves before the game is asked again. */
const RETRY_MS = 30_000;

export interface CatalogEntry {
	catalog: Catalog;
	features: Features;
}

interface Kept extends CatalogEntry {
	until: number;
	startedAt: number;
	/** not asked again before this, after a read that failed */
	retryAt: number;
}

const cache = new Map<string, Kept>();

/**
 * The entry while it is under an hour old, and whether it is `due` another read: the game has
 * started again since it was read. `startedAt` is when the game last started (ms), as the worker
 * has it; 0 when it is not known, and then only the hour counts.
 */
export function cachedCatalog(
	serverId: string,
	startedAt = 0
): { entry: CatalogEntry; due: boolean } | null {
	const hit = cache.get(serverId);
	const now = Date.now();
	if (!hit || hit.until <= now) return null;
	const restarted = !!startedAt && startedAt - hit.startedAt > NEW_RUN_MS;
	return { entry: hit, due: restarted && now >= hit.retryAt };
}

export function rememberCatalog(serverId: string, entry: CatalogEntry, startedAt = 0): void {
	cache.set(serverId, { ...entry, until: Date.now() + CATALOG_TTL_MS, startedAt, retryAt: 0 });
}

/** A read that was due failed: the entry in hand serves a while longer before the next try. */
export function catalogReadFailed(serverId: string): void {
	const hit = cache.get(serverId);
	if (hit) hit.retryAt = Date.now() + RETRY_MS;
}

export function forgetCatalog(serverId: string): void {
	cache.delete(serverId);
}
