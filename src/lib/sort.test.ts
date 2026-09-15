import { describe, expect, test } from 'bun:test';
import { nextDir, sortRows } from './sort';

const names = (rows: { id: string }[]) => rows.map((r) => r.id).join(',');

describe('sortRows', () => {
	test('orders numbers by the chosen direction', () => {
		const rows = [
			{ id: 'a', kills: 3 },
			{ id: 'b', kills: 11 },
			{ id: 'c', kills: 7 }
		];
		expect(names(sortRows(rows, (r) => r.kills, 'asc'))).toBe('a,c,b');
		expect(names(sortRows(rows, (r) => r.kills, 'desc'))).toBe('b,c,a');
	});

	test('missing values sort last whichever way the column points', () => {
		// Ping is null for a player the server has not measured yet; an unset ping is not a ping of 0.
		const rows = [
			{ id: 'a', ping: null },
			{ id: 'b', ping: 40 },
			{ id: 'c', ping: undefined },
			{ id: 'd', ping: 12 }
		];
		expect(names(sortRows(rows, (r) => r.ping, 'asc'))).toBe('d,b,a,c');
		expect(names(sortRows(rows, (r) => r.ping, 'desc'))).toBe('b,d,a,c');
	});

	test('compares text without regard to case', () => {
		const rows = [
			{ id: 'a', name: 'Zulu' },
			{ id: 'b', name: 'alpha' },
			{ id: 'c', name: 'Mike' }
		];
		expect(names(sortRows(rows, (r) => r.name, 'asc'))).toBe('b,c,a');
	});

	test('leaves tied rows in the order they arrived, descending too', () => {
		// The live roster re-sorts on every observation, so ties must not shuffle between ticks.
		const rows = [
			{ id: 'a', kills: 5 },
			{ id: 'b', kills: 5 },
			{ id: 'c', kills: 9 },
			{ id: 'd', kills: 5 }
		];
		expect(names(sortRows(rows, (r) => r.kills, 'desc'))).toBe('c,a,b,d');
	});

	test('does not disturb the array it was given', () => {
		const rows = [
			{ id: 'a', kills: 3 },
			{ id: 'b', kills: 11 }
		];
		sortRows(rows, (r) => r.kills, 'desc');
		expect(names(rows)).toBe('a,b');
	});
});

describe('nextDir', () => {
	test('clicking the column already sorted turns it around', () => {
		expect(nextDir('kills', 'desc', 'kills', 'desc')).toBe('asc');
		expect(nextDir('kills', 'asc', 'kills', 'desc')).toBe('desc');
	});

	test('clicking a different column starts at that column own default', () => {
		expect(nextDir('kills', 'asc', 'name', 'asc')).toBe('asc');
		expect(nextDir('name', 'desc', 'kills', 'desc')).toBe('desc');
	});
});
