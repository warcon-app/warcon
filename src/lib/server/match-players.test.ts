import { describe, expect, test } from 'bun:test';
import {
	closeTallies,
	feedRecord,
	tallyLook,
	tallyRow,
	type FeedKill,
	type Tallies
} from './match-players';
import type { Player } from '$lib/types';

const player = (steamId: string, kills: number, deaths: number, cash = 0): Player => ({
	name: steamId,
	steamId,
	faction: 'Red',
	kills,
	deaths,
	cash,
	ping: null
});
const TEAMS = ['Red', 'Blue', 'Green'];
// Each look's gap is the time since the look before it, as the worker measures it.
let prevNow = 0;
const look = (
	t: Tallies,
	players: Player[],
	now: number,
	stayed: string[] = [],
	scored?: boolean
) => {
	tallyLook(t, players, {
		now,
		gapMs: now - prevNow,
		stayed: new Set(stayed),
		teams: TEAMS,
		scored
	});
	prevNow = now;
};

describe('a match tally', () => {
	test('starts from the counters as they stand and follows them', () => {
		const t: Tallies = new Map();
		look(t, [player('a', 3, 1, 500)], 1000);
		look(t, [player('a', 5, 2, 650)], 3000, ['a']);
		expect(tallyRow(t.get('a')!)).toEqual({
			steamId: 'a',
			name: 'a',
			faction: 'Red',
			seconds: 2,
			idleSeconds: 0,
			kills: 5,
			deaths: 2,
			cashDelta: 150
		});
	});

	test('banks what was reached when a counter drops, cash included', () => {
		const t: Tallies = new Map();
		look(t, [player('a', 3, 1, 200)], 500);
		look(t, [player('a', 5, 2, 1000)], 1000, ['a']);
		// the counters start again: the 800 earned so far is banked, the 50 is the new start
		look(t, [player('a', 1, 0, 50)], 3000, ['a']);
		look(t, [player('a', 2, 0, 150)], 5000, ['a']);
		const row = tallyRow(t.get('a')!);
		expect(row.kills).toBe(7);
		expect(row.deaths).toBe(2);
		expect(row.cashDelta).toBe(900);
		expect(t.get('a')!.droppedAt).toBe(3000);
	});

	test('only a player on at the previous trusted look earns the gap', () => {
		const t: Tallies = new Map();
		look(t, [player('a', 0, 0), player('b', 0, 0)], 1000);
		look(t, [player('a', 0, 0), player('b', 0, 0)], 3000, ['a']);
		expect(t.get('a')!.ms).toBe(2000);
		expect(t.get('b')!.ms).toBe(0);
	});

	test('time on before any side has scored is idle time too; unknown scores make none', () => {
		const t: Tallies = new Map();
		look(t, [player('a', 0, 0)], 1000, [], false);
		look(t, [player('a', 0, 0)], 61_000, ['a'], false); // waiting for players
		look(t, [player('a', 2, 0)], 91_000, ['a'], true); // a side has scored
		look(t, [player('a', 2, 0)], 101_000, ['a']); // no status to read the scores from
		expect(tallyRow(t.get('a')!)).toMatchObject({ seconds: 100, idleSeconds: 60 });
	});

	test('keeps the last side that was a team, and the last name', () => {
		const t: Tallies = new Map();
		look(t, [{ ...player('a', 0, 0), faction: 'White', name: 'a' }], 1000);
		expect(t.get('a')!.faction).toBeNull();
		look(t, [{ ...player('a', 0, 0), faction: 'Blue', name: '[TAG] a' }], 3000, ['a']);
		look(t, [{ ...player('a', 0, 0), faction: null, name: '[TAG] a' }], 5000, ['a']);
		expect(t.get('a')!.faction).toBe('Blue');
		expect(t.get('a')!.name).toBe('[TAG] a');
	});
});

describe('closing a match', () => {
	test('writes everything reached and ends the tallies', () => {
		const t: Tallies = new Map();
		look(t, [player('a', 4, 1, 100)], 1000);
		look(t, [player('a', 0, 0, 100)], 2000, ['a']); // a reconnect early in the match
		look(t, [player('a', 6, 3, 400)], 9000, ['a']);
		const { rows, carried } = closeTallies(t, 8000);
		expect(rows).toEqual([
			{
				steamId: 'a',
				name: 'a',
				faction: 'Red',
				seconds: 8,
				idleSeconds: 0,
				kills: 10,
				deaths: 4,
				cashDelta: 300
			}
		]);
		expect(carried.size).toBe(0);
	});

	test('a drop seen since the previous status look was the next match: the row stops at the bank and the tally carries', () => {
		const t: Tallies = new Map();
		look(t, [player('a', 9, 4, 1000)], 1000);
		look(t, [player('a', 9, 4, 1200)], 5000, ['a']);
		// the status looked at 6000 and saw the old match; the list at 7000 already shows the new one
		look(t, [player('a', 1, 0, 50)], 7000, ['a']);
		const { rows, carried } = closeTallies(t, 6000);
		expect(rows).toEqual([
			{
				steamId: 'a',
				name: 'a',
				faction: 'Red',
				seconds: 6,
				idleSeconds: 0,
				kills: 9,
				deaths: 4,
				cashDelta: 200
			}
		]);
		const next = carried.get('a')!;
		expect(next.banked).toEqual({ kills: 0, deaths: 0, cash: 0 });
		expect(next.last).toEqual({ kills: 1, deaths: 0 });
		expect(next.cashFirst).toBe(50);
		expect(next.droppedAt).toBe(0);
		expect(tallyRow(next)).toMatchObject({ kills: 1, deaths: 0, cashDelta: 0 });
	});
});

describe("the feed's record of a match", () => {
	const kill = (
		killer: string | null,
		victim: string,
		extra: Partial<FeedKill> = {}
	): FeedKill => ({
		killerSteamId: killer,
		victimSteamId: victim,
		headshot: false,
		suicide: false,
		teamKill: false,
		cause: 'Id.Item.AK74M',
		distanceM: 40,
		...extra
	});

	test('streaks, headshots, vehicle kills, the longest shot, team kills and suicides', () => {
		const r = feedRecord([
			kill('a', 'b', { headshot: true, distanceM: 120 }),
			kill('a', 'c', { cause: 'Vehicle.Variant.Land.Wheeled.Kodiak.Pickup', distanceM: 5 }),
			kill('a', 'b', { distanceM: null }),
			kill('b', 'a'),
			kill('a', 'a', { suicide: true, cause: null }),
			kill('a', 'd', { teamKill: true }),
			kill('c', 'a'),
			kill(null, 'a', { cause: null, distanceM: null })
		]);
		expect(r.get('a')).toEqual({
			headshots: 1,
			teamKills: 1,
			suicides: 1,
			vehicleKills: 1,
			longestM: 120,
			killStreak: 3,
			deathStreak: 4
		});
		expect(r.get('b')).toMatchObject({ killStreak: 1, deathStreak: 2, headshots: 0 });
		expect(r.get('d')).toMatchObject({ deathStreak: 1, killStreak: 0 });
	});

	test('a team kill breaks neither of its killer’s runs', () => {
		const r = feedRecord([kill('a', 'b'), kill('a', 'x', { teamKill: true }), kill('a', 'b')]);
		expect(r.get('a')!.killStreak).toBe(2);
		expect(r.get('a')!.teamKills).toBe(1);
	});

	test('nothing at all is an empty record', () => {
		expect(feedRecord([]).size).toBe(0);
	});
});
