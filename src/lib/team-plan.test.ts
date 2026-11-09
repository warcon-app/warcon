import { describe, expect, test } from 'bun:test';
import { deal, evenUp, recordRating, type PlanPlayer } from './team-plan';

/** mulberry32: the same deals for the same seed */
function rng(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const V = 'Valkyra';
const M = 'Manticore';
const L = 'Lonestar';
const on = (id: string, side: string | null, name = `Player ${id}`): PlanPlayer => ({
	steamId: id,
	name,
	side
});
const many = (prefix: string, n: number, side: string | null, tag = '') =>
	Array.from({ length: n }, (_, i) => on(`${prefix}${i}`, side, `${tag}Player ${prefix}${i}`));
const sizes = (out: Map<string, string>, sides: string[]) =>
	sides.map((s) => [...out.values()].filter((v) => v === s).length);
const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
const moved = (players: PlanPlayer[], out: Map<string, string>) =>
	players.filter((p) => out.get(p.steamId) !== p.side);

describe('deal', () => {
	test('puts everyone on one of the sides, none more than one ahead, whatever the numbers', () => {
		const random = rng(1);
		for (const sides of [
			[V, M],
			[V, M, L]
		])
			for (let n = 0; n <= 41; n++) {
				const players = [...many('v', Math.ceil(n / 2), V), ...many('l', Math.floor(n / 2), L)];
				for (const clans of [false, true]) {
					const out = deal(players, sides, { clans, random });
					expect(out.size).toBe(n);
					expect([...out.values()].every((s) => sides.includes(s))).toBe(true);
					if (n) expect(spread(sizes(out, sides))).toBeLessThanOrEqual(1);
				}
			}
	});

	test('takes everyone off a side left out of the shuffle, and those on no side', () => {
		const players = [
			...many('v', 9, V),
			...many('m', 6, M),
			...many('l', 4, L),
			...many('x', 3, null)
		];
		const out = deal(players, [V, M], { clans: false, random: rng(2) });
		expect(sizes(out, [V, M]).sort()).toEqual([11, 11]);
		expect([...out.values()].includes(L)).toBe(false);
	});

	test('keeps a clan on one side while it has room, and only the overflow goes elsewhere', () => {
		const random = rng(3);
		const players = [...many('v', 10, V), ...many('m', 6, M), ...many('c', 4, M, '[ABC] ')];
		for (let i = 0; i < 20; i++) {
			const out = deal(players, [V, M], { clans: true, random });
			expect(
				new Set(players.filter((p) => p.steamId[0] === 'c').map((p) => out.get(p.steamId))).size
			).toBe(1);
		}
		// twelve of a clan on a twenty-player server: ten together, the other two across
		const big = [...many('c', 12, V, '[ABC] '), ...many('m', 8, M)];
		const out = deal(big, [V, M], { clans: true, random });
		expect(
			sizes(
				new Map(
					big.filter((p) => p.steamId[0] === 'c').map((p) => [p.steamId, out.get(p.steamId)!])
				),
				[V, M]
			).sort((a, b) => a - b)
		).toEqual([2, 10]);
		// and with clans not kept, tags mean nothing
		const loose = deal(players, [V, M], { clans: false, random: rng(4) });
		expect(spread(sizes(loose, [V, M]))).toBe(0);
	});

	test('by a rating, the strong are shared out and the sides add up about the same', () => {
		const players = Array.from({ length: 20 }, (_, i) => on(`p${i}`, i < 14 ? V : M));
		const rating = (p: PlanPlayer) => Number(p.steamId.slice(1)) + 1;
		for (let seed = 0; seed < 20; seed++) {
			const out = deal(players, [V, M], { clans: false, rating, random: rng(seed) });
			const sum = (s: string) =>
				players.filter((p) => out.get(p.steamId) === s).reduce((t, p) => t + rating(p), 0);
			expect(Math.abs(sum(V) - sum(M))).toBeLessThanOrEqual(2);
			expect(out.get('p19')).not.toBe(out.get('p18'));
		}
	});

	test('moves no more players than it must: each team takes the side most of it is on', () => {
		const random = rng(5);
		// already dealt by strength: the deal comes out the same, and nobody moves
		const players = Array.from({ length: 8 }, (_, i) =>
			on(`p${i}`, [0, 3, 4, 7].includes(i) ? M : V)
		);
		const rating = (p: PlanPlayer) => Number(p.steamId.slice(1));
		expect(moved(players, deal(players, [V, M], { clans: false, rating, random }))).toEqual([]);
		// at random, at most half of a two-sided server moves
		const mixed = [...many('v', 13, V), ...many('m', 11, M)];
		for (let i = 0; i < 50; i++)
			expect(
				moved(mixed, deal(mixed, [V, M], { clans: false, random })).length
			).toBeLessThanOrEqual(12);
	});
});

describe('evenUp', () => {
	test('moves the fewest players, those off the sides first, and no clan players while others can go', () => {
		const random = rng(6);
		const players = [
			...many('t', 3, V, '[RDX] '),
			...many('v', 11, V),
			...many('m', 9, M),
			on('l0', L)
		];
		for (let i = 0; i < 20; i++) {
			const out = evenUp(players, [V, M], { clans: true, random });
			expect(sizes(out, [V, M])).toEqual([12, 12]);
			const gone = moved(players, out);
			expect(gone.length).toBe(3);
			expect(gone.some((p) => p.steamId === 'l0')).toBe(true);
			expect(gone.some((p) => p.name.startsWith('[RDX]'))).toBe(false);
		}
	});

	test('leaves sides within one alone, and places a player on no side', () => {
		const players = [...many('v', 7, V), ...many('m', 6, M), on('x', null)];
		const out = evenUp(players, [V, M], { clans: false, random: rng(7) });
		expect(moved(players, out).map((p) => [p.steamId, out.get(p.steamId)])).toEqual([['x', M]]);
	});

	test('with clans kept and only clan players on the big side, still evens up', () => {
		const players = [...many('t', 6, V, '[RDX] '), ...many('m', 2, M)];
		const out = evenUp(players, [V, M], { clans: true, random: rng(8) });
		expect(sizes(out, [V, M])).toEqual([4, 4]);
	});
});

test('recordRating counts a player with no record as 1 and grows with kills over deaths', () => {
	expect(recordRating(null)).toBe(1);
	expect(recordRating({ kills: 0, deaths: 0 })).toBe(1);
	expect(recordRating({ kills: 30, deaths: 10 })).toBe(2);
	expect(recordRating({ kills: 3, deaths: 0 })).toBeLessThan(
		recordRating({ kills: 60, deaths: 20 })
	);
});
