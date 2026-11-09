// The Players tab's Teams view: which side each player goes to when someone shuffles or evens up
// the teams. Pure: the page keeps the plan, and nobody moves until it is saved, one changeTeam per
// player.
import { clanTag } from './clan';

export interface PlanPlayer {
	steamId: string;
	name: string;
	/** the side the player is on now; null when the game has them on none */
	side: string | null;
}

/** How Shuffle deals the teams: at random, or spread by each player's K/D on record here. */
export type ShuffleMode = 'random' | 'record';

/**
 * The kills and deaths a K/D on record starts from, so a player with little history counts as
 * about 1 and one good match does not make anyone the strongest on the server.
 */
export const RECORD_PRIOR = 10;

/** A player's K/D over the matches they finished on this server, smoothed by RECORD_PRIOR. */
export function recordRating(record: { kills: number; deaths: number } | null | undefined): number {
	return ((record?.kills ?? 0) + RECORD_PRIOR) / ((record?.deaths ?? 0) + RECORD_PRIOR);
}

function shuffled<T>(xs: T[], random: () => number): T[] {
	const a = xs.slice();
	for (let i = a.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[a[i], a[j]] = [a[j], a[i]];
	}
	return a;
}

/** Every order of a few sides (WARDOGS has three, so six). */
function orders<T>(xs: T[]): T[][] {
	if (xs.length <= 1) return [xs.slice()];
	return xs.flatMap((x, i) =>
		orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map((o) => [x, ...o])
	);
}

/**
 * Everyone dealt onto `sides` in even numbers, no side more than one player ahead of another.
 * Clanmates (two or more players on one tag) go together while their side has room, biggest clan
 * first. The strongest player left goes to the side whose players add up weakest so far; without
 * a rating each player's strength is a random number, which makes the deal random. Each team then
 * takes the side most of it is on already, so as few players move as the deal allows. Returns
 * every player's side.
 */
export function deal(
	players: PlanPlayer[],
	sides: string[],
	opts: { clans: boolean; rating?: (p: PlanPlayer) => number; random?: () => number }
): Map<string, string> {
	const random = opts.random ?? Math.random;
	const out = new Map<string, string>();
	const k = sides.length;
	if (!k || !players.length) return out;
	const strength = new Map(
		players.map((p) => [p.steamId, opts.rating ? opts.rating(p) : random()])
	);
	const tie = new Map(players.map((p) => [p.steamId, random()]));
	const of = (p: PlanPlayer) => strength.get(p.steamId)!;
	const stronger = (a: PlanPlayer, b: PlanPlayer) =>
		of(b) - of(a) || tie.get(a.steamId)! - tie.get(b.steamId)!;

	const byTag = new Map<string, PlanPlayer[]>();
	const units: PlanPlayer[][] = [];
	for (const p of players) {
		const tag = opts.clans ? clanTag(p.name) : null;
		if (!tag) units.push([p]);
		else if (byTag.has(tag)) byTag.get(tag)!.push(p);
		else byTag.set(tag, [p]);
	}
	for (const members of byTag.values()) units.push(members.sort(stronger));
	const total = (u: PlanPlayer[]) => u.reduce((s, p) => s + of(p), 0);
	units.sort((a, b) => b.length - a.length || total(b) - total(a) || stronger(a[0], b[0]));

	// Teams 0..k-1: `base` players each, and `bigger` of them one more.
	const base = Math.floor(players.length / k);
	let bigger = players.length % k;
	const size = new Array<number>(k).fill(0);
	const sum = new Array<number>(k).fill(0);
	const room = (t: number) => size[t] < base || (size[t] === base && bigger > 0);
	const weakest = () => {
		let best = -1;
		for (let t = 0; t < k; t++)
			if (
				room(t) &&
				(best < 0 || sum[t] < sum[best] || (sum[t] === sum[best] && size[t] < size[best]))
			)
				best = t;
		return best;
	};
	const team = new Map<string, number>();
	for (const unit of units) {
		let t = -1;
		for (const p of unit) {
			if (t < 0 || !room(t)) t = weakest();
			if (size[t] === base) bigger--;
			size[t]++;
			sum[t] += of(p);
			team.set(p.steamId, t);
		}
	}

	// Name the teams: of the ways to give each team a side, the one that leaves the most players
	// where they are (ties at random). More sides than WARDOGS has keep the order they came in.
	let label = sides.slice();
	if (k <= 6) {
		let best = -1;
		for (const o of shuffled(orders(sides), random)) {
			let stay = 0;
			for (const p of players) if (p.side === o[team.get(p.steamId)!]) stay++;
			if (stay > best) {
				best = stay;
				label = o;
			}
		}
	}
	for (const p of players) out.set(p.steamId, label[team.get(p.steamId)!]);
	return out;
}

/**
 * The fewest moves that bring `sides` within one player of each other. Players on a side that is
 * not one of `sides`, or on none, go to the smallest; then players leave the biggest side for the
 * smallest one at a time, players without a clan tag first when clans are kept together. Returns
 * every player's side.
 */
export function evenUp(
	players: PlanPlayer[],
	sides: string[],
	opts: { clans: boolean; random?: () => number }
): Map<string, string> {
	const random = opts.random ?? Math.random;
	const out = new Map<string, string>();
	if (!sides.length) return out;
	const count = new Map(sides.map((s) => [s, 0]));
	const order = new Map(sides.map((s) => [s, random()]));
	const n = (s: string) => count.get(s)!;
	const smallest = () =>
		sides.reduce((a, b) =>
			n(b) < n(a) || (n(b) === n(a) && order.get(b)! < order.get(a)!) ? b : a
		);
	const biggest = () =>
		sides.reduce((a, b) =>
			n(b) > n(a) || (n(b) === n(a) && order.get(b)! < order.get(a)!) ? b : a
		);
	const put = (p: PlanPlayer, to: string) => {
		const from = out.get(p.steamId);
		if (from !== undefined) count.set(from, n(from) - 1);
		out.set(p.steamId, to);
		count.set(to, n(to) + 1);
	};
	const pick = (xs: PlanPlayer[]) => (xs.length ? xs[Math.floor(random() * xs.length)] : undefined);

	for (const p of players) if (p.side !== null && count.has(p.side)) put(p, p.side);
	for (const p of shuffled(players, random)) if (!out.has(p.steamId)) put(p, smallest());
	for (;;) {
		const hi = biggest();
		const lo = smallest();
		if (n(hi) - n(lo) <= 1) break;
		const there = players.filter((p) => out.get(p.steamId) === hi);
		put((opts.clans && pick(there.filter((p) => !clanTag(p.name)))) || pick(there)!, lo);
	}
	return out;
}
