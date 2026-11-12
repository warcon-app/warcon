// The server layout's catalog cache: kept for an hour, and due another read once the game has
// restarted, since that is when a server takes a new build or new allow lists (Sabatulo, say, once
// its host has been given it). A read that fails then leaves the entry in hand serving.
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import {
	cachedCatalog,
	catalogReadFailed,
	forgetCatalog,
	rememberCatalog,
	type CatalogEntry
} from './catalog-cache';
import type { Features } from '../types';

const MIN = 60_000;
const NOW = Date.UTC(2026, 10, 12, 14, 0, 0);
const START = NOW - 6 * 60 * MIN;
const entry = (...maps: string[]): CatalogEntry => ({
	catalog: { maps: maps.map((id) => ({ id, display: id })), lightings: [], experiences: [] },
	features: {} as Features
});
/** the maps of the entry in hand and whether it is due another read; null when there is none */
const kept = (id: string, startedAt?: number) => {
	const hit = cachedCatalog(id, startedAt);
	return hit ? [hit.entry.catalog.maps.map((m) => m.id).join('+'), hit.due] : null;
};
let n = 0;
const fresh = () => `catalog-cache-${++n}`;

afterEach(() => setSystemTime());

describe('the catalog cache', () => {
	test('kept for an hour, and forgotten on request', () => {
		setSystemTime(new Date(NOW));
		const id = fresh();
		expect(kept(id, START)).toBeNull();
		rememberCatalog(id, entry('Kavkazi'), START);
		expect(kept(id, START)).toEqual(['Kavkazi', false]);
		setSystemTime(new Date(NOW + 59 * MIN));
		expect(kept(id, START)).toEqual(['Kavkazi', false]);
		setSystemTime(new Date(NOW + 61 * MIN));
		expect(kept(id, START)).toBeNull();
		rememberCatalog(id, entry('Kavkazi'), START);
		forgetCatalog(id);
		expect(kept(id, START)).toBeNull();
	});

	test('due another read once the game has started again, not for the same start seen a little off', () => {
		setSystemTime(new Date(NOW));
		const id = fresh();
		rememberCatalog(id, entry('Kavkazi'), START);
		// the start is worked out from the uptime at each look, so it moves by a few seconds
		for (const drift of [-5_000, 0, 5_000, 59_000])
			expect(kept(id, START + drift)).toEqual(['Kavkazi', false]);
		// the game restarted five minutes ago, with Sabatulo on its allow list
		const restarted = NOW + 5 * MIN;
		setSystemTime(new Date(NOW + 10 * MIN));
		expect(kept(id, restarted)).toEqual(['Kavkazi', true]);
		rememberCatalog(id, entry('Kavkazi', 'Russia'), restarted);
		expect(kept(id, restarted)).toEqual(['Kavkazi+Russia', false]);
		// an earlier start than the one it was read under is no restart
		expect(kept(id, START)).toEqual(['Kavkazi+Russia', false]);
	});

	test('a read that fails after a restart: the entry in hand serves, and is due again in half a minute', () => {
		setSystemTime(new Date(NOW));
		const id = fresh();
		rememberCatalog(id, entry('Kavkazi'), START);
		const restarted = NOW + 5 * MIN;
		setSystemTime(new Date(NOW + 10 * MIN));
		expect(kept(id, restarted)).toEqual(['Kavkazi', true]);
		catalogReadFailed(id);
		// every page in the next half minute is served from it without asking the game
		for (const later of [0, 1_000, 29_000]) {
			setSystemTime(new Date(NOW + 10 * MIN + later));
			expect(kept(id, restarted)).toEqual(['Kavkazi', false]);
		}
		setSystemTime(new Date(NOW + 10 * MIN + 31_000));
		expect(kept(id, restarted)).toEqual(['Kavkazi', true]);
		// a read that works puts an end to it
		rememberCatalog(id, entry('Kavkazi', 'Russia'), restarted);
		expect(kept(id, restarted)).toEqual(['Kavkazi+Russia', false]);
		// still gone after its hour, read or not, and a failure with nothing in hand keeps nothing
		setSystemTime(new Date(NOW + 80 * MIN));
		expect(kept(id, restarted)).toBeNull();
		catalogReadFailed(fresh());
	});

	test('a start the worker does not know leaves the hour alone', () => {
		setSystemTime(new Date(NOW));
		const id = fresh();
		rememberCatalog(id, entry('Kavkazi'), START);
		expect(kept(id)).toEqual(['Kavkazi', false]);
		expect(kept(id, 0)).toEqual(['Kavkazi', false]);
		// read while the start was not known: due once when it is, then kept
		const other = fresh();
		rememberCatalog(other, entry('Kavkazi'));
		expect(kept(other)).toEqual(['Kavkazi', false]);
		expect(kept(other, START)).toEqual(['Kavkazi', true]);
		rememberCatalog(other, entry('Kavkazi'), START);
		expect(kept(other, START)).toEqual(['Kavkazi', false]);
	});
});
