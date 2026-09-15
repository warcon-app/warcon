// Client-side column sorting for the tables that hold their whole list in the page: the live
// roster and scoreboard, the ban lists. The organisation's player list sorts in Postgres instead,
// because it is paged; see lib/server/seen.ts. Both drive the same SortHeader.
export type SortDir = 'asc' | 'desc';
/** What a column yields for a row. null and undefined mean the row has no value for it. */
export type SortValue = string | number | null | undefined;

const missing = (v: SortValue): v is null | undefined => v === null || v === undefined;

/**
 * A copy of `rows` ordered by `value`. Rows with no value go last whichever way the column points,
 * and tied rows keep the order they arrived in, so a table re-sorting on every observation does
 * not shuffle underneath the pointer.
 */
export function sortRows<T>(rows: T[], value: (row: T) => SortValue, dir: SortDir): T[] {
	const sign = dir === 'asc' ? 1 : -1;
	return [...rows].sort((ra, rb) => {
		const a = value(ra);
		const b = value(rb);
		if (missing(a)) return missing(b) ? 0 : 1;
		if (missing(b)) return -1;
		if (typeof a === 'number' && typeof b === 'number') return (a - b) * sign;
		return String(a).localeCompare(String(b), undefined, { sensitivity: 'base' }) * sign;
	});
}

/**
 * Where a click on `key` leaves the sort: turn the active column around, or start a column the
 * table is not sorted by at `fallback` (ascending reads better for names, descending for counts).
 */
export function nextDir(active: string, dir: SortDir, key: string, fallback: SortDir): SortDir {
	if (active !== key) return fallback;
	return dir === 'asc' ? 'desc' : 'asc';
}
