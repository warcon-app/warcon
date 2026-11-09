import { describe, expect, test } from 'bun:test';
import {
	bountyReplay,
	bountyState,
	bountyStep,
	bountyTrack,
	bountyVersion,
	claims,
	forgetBounties,
	fromEarlierMatch,
	keepBounties,
	lapseWords,
	rewardWords,
	savedBounty,
	validateBounty,
	type BountyKill,
	type BountyPlayer,
	type BountyTrack
} from './bounty';

const RED = 'Valkyra';
const BLUE = 'Lonestar';
const p = (n: number, faction: string | null = RED): BountyPlayer => ({
	steamId: `7656119800000${String(n).padStart(4, '0')}`,
	name: `Player ${n}`,
	faction
});
const A = p(1, RED);
const B = p(2, BLUE);
const C = p(3, BLUE);
const D = p(4, RED);
let seq = 0;
const kill = (
	killer: BountyPlayer | null,
	victim: BountyPlayer,
	o: { suicide?: boolean; teamKill?: boolean } = {}
): BountyKill => ({
	eventId: `e${++seq}`,
	killer,
	victim,
	suicide: !!o.suicide,
	teamKill: !!o.teamKill
});
const fresh = (): BountyTrack => ({ runs: new Map(), open: null });
const step = (track: BountyTrack, kills: BountyKill[], canMark = true, streak = 3) =>
	bountyStep({ streak }, track, kills, { canMark, now: 1000 });

describe('the Bounty rule, settings', () => {
	test('defaults, clamps and the announcement a blank one gets', () => {
		const d = validateBounty({});
		expect(d).toEqual({
			streak: 15,
			minPlayers: 20,
			reward: 'slot',
			slotDays: 1,
			scope: 'server',
			setMessage: 'BOUNTY on {name}: {streak} kills without dying. Kill them for {reward}.',
			claimMessage: '',
			whisper: ''
		});
		const c = validateBounty({
			streak: 1,
			minPlayers: -5,
			reward: 'none',
			slotDays: 9999,
			scope: 'org',
			setMessage: ' ',
			claimMessage: 'x'.repeat(400)
		});
		expect([c.streak, c.minPlayers, c.reward, c.slotDays, c.scope]).toEqual([
			3,
			0,
			'none',
			365,
			'org'
		]);
		expect(c.setMessage).toBe('BOUNTY on {name}: {streak} kills without dying. Who ends the run?');
		expect(c.claimMessage).toHaveLength(256);
		// anything but 'none' is a slot, anything but 'org' this server's list
		expect(validateBounty({ reward: 'role', scope: 'all' })).toMatchObject({
			reward: 'slot',
			scope: 'server'
		});
	});

	test('the reward in words', () => {
		expect(rewardWords({ reward: 'slot', slotDays: 1 })).toBe('a reserved slot for 1 day');
		expect(rewardWords({ reward: 'slot', slotDays: 3 })).toBe('a reserved slot for 3 days');
		expect(rewardWords({ reward: 'none', slotDays: 3 })).toBe('');
	});
});

describe('the Bounty rule, runs and bounties', () => {
	test('a run of kills without dying puts a bounty on the player at the count', () => {
		const t = fresh();
		expect(step(t, [kill(A, B), kill(A, C)])).toEqual([]);
		expect(t.runs.get(A.steamId)).toBe(2);
		const [set] = step(t, [kill(A, B)]);
		expect(set).toMatchObject({ kind: 'set', bounty: { steamId: A.steamId, streak: 3, best: 3 } });
		expect(t.open?.steamId).toBe(A.steamId);
		// more kills while marked grow the run the claim will name
		step(t, [kill(A, C), kill(A, B)]);
		expect(t.open).toMatchObject({ streak: 3, best: 5 });
	});

	test('any death ends a run; a team kill or a suicide adds nothing to one', () => {
		const t = fresh();
		step(t, [kill(A, B), kill(A, C)]);
		step(t, [kill(A, D, { teamKill: true })]);
		expect(t.runs.get(A.steamId)).toBe(2);
		step(t, [kill(null, A)]);
		expect(t.runs.has(A.steamId)).toBe(false);
		step(t, [kill(A, B), kill(A, C), kill(D, A, { teamKill: true })]);
		expect(t.runs.has(A.steamId)).toBe(false);
		step(t, [kill(A, B), kill(A, A, { suicide: true })]);
		expect(t.runs.has(A.steamId)).toBe(false);
		expect(t.open).toBeNull();
	});

	test('nobody is marked while too few are on; the run counts all the same', () => {
		const t = fresh();
		expect(step(t, [kill(A, B), kill(A, C), kill(A, B)], false)).toEqual([]);
		expect(t.open).toBeNull();
		// enough on now: marked at their next kill
		expect(step(t, [kill(A, C)])[0]).toMatchObject({ kind: 'set', bounty: { streak: 4 } });
	});

	test('one bounty at a time: the next player on a run is marked at their next kill', () => {
		const t = fresh();
		step(t, [kill(A, B), kill(A, C), kill(A, B)]);
		expect(step(t, [kill(B, D), kill(B, D), kill(B, D)])).toEqual([]);
		expect(t.open?.steamId).toBe(A.steamId);
		// C claims A's; B, on a run of 3 already, is marked at their next kill
		const ended = step(t, [kill(C, A)]);
		expect(ended.map((e) => e.kind)).toEqual(['claim']);
		expect(step(t, [kill(B, D)])[0]).toMatchObject({
			kind: 'set',
			bounty: { steamId: B.steamId, streak: 4 }
		});
	});

	test('only an enemy whose side is known claims it: not a teammate, a suicide or the environment', () => {
		const t = fresh();
		step(t, [kill(A, B), kill(A, C), kill(A, B)]);
		const open = t.open!;
		expect(step(t, [kill(D, A, { teamKill: true })])).toEqual([]);
		expect(step(t, [kill(A, A, { suicide: true })])).toEqual([]);
		expect(step(t, [kill(null, A)])).toEqual([]);
		// a kill between players whose sides the panel has not seen is no claim
		expect(step(t, [kill(p(9, null), A)])).toEqual([]);
		expect(step(t, [kill(B, { ...A, faction: null })])).toEqual([]);
		// a player the panel takes for an enemy (no team kill) but on the same side is no claim either
		expect(claims(kill(D, A), open)).toBe(false);
		expect(t.open).toBe(open);
		const [claim] = step(t, [kill(B, A)]);
		expect(claim).toMatchObject({ kind: 'claim', claimer: B, bounty: { steamId: A.steamId } });
		expect(t.open).toBeNull();
	});

	test('the kill that claims it can put the next bounty on the claimer', () => {
		const t = fresh();
		step(t, [kill(A, B), kill(A, C), kill(A, B), kill(B, D), kill(B, D)]);
		const out = step(t, [kill(B, A)]);
		expect(out.map((e) => e.kind)).toEqual(['claim', 'set']);
		expect(t.open).toMatchObject({ steamId: B.steamId, streak: 3 });
	});
});

describe('the Bounty rule, lapses', () => {
	test('what the panel says of each', () => {
		const b = { name: 'Player 1', best: 17 };
		expect(lapseWords(b, 'left')).toBe(
			'The bounty on Player 1 lapsed: they left the server (a run of 17).'
		);
		expect(lapseWords(b, 'match')).toBe(
			'The bounty on Player 1 lapsed: the match ended (a run of 17).'
		);
		expect(lapseWords(b, 'lost')).toBe(
			'The bounty on Player 1 lapsed: the server was out of reach (a run of 17).'
		);
	});

	test('a bounty is from an earlier match only when both are matches the panel opened', () => {
		expect(fromEarlierMatch('m12', 'm13')).toBe(true);
		expect(fromEarlierMatch('m12', 'm12')).toBe(false);
		// set or claimed while no match was open (a server's first seconds): it stands
		expect(fromEarlierMatch('h480000', 'm13')).toBe(false);
		expect(fromEarlierMatch('m12', 'h480001')).toBe(false);
		expect(fromEarlierMatch('', 'm13')).toBe(false);
	});
});

describe('the Bounty rule, its memory', () => {
	test('an open bounty is read back only under the save it was set in', () => {
		const row = { config: { streak: 15 }, updatedAt: new Date(5000) };
		const version = bountyVersion(row);
		const open = { ...A, streak: 15, best: 17, setAt: 4000, match: 'm12' };
		const state = bountyState(version, open);
		expect(savedBounty(state, version)).toEqual(open);
		expect(savedBounty(state, bountyVersion({ ...row, updatedAt: new Date(6000) }))).toBeNull();
		expect(savedBounty(state, bountyVersion({ ...row, config: { streak: 20 } }))).toBeNull();
		expect(savedBounty(bountyState(version, null), version)).toBeNull();
		expect(savedBounty(null, version)).toBeNull();
		expect(savedBounty({ version, open: { steamId: 7 } }, version)).toBeNull();
	});

	test("a rule's track comes back from its row once, and starts over after a save", () => {
		forgetBounties();
		const row = {
			id: 'rule-1',
			serverId: 'server-1',
			config: { streak: 3 },
			updatedAt: new Date(1000),
			state: null as unknown
		};
		const open = { ...A, streak: 3, best: 3, setAt: 900, match: 'm3' };
		row.state = bountyState(bountyVersion(row), open);
		const first = bountyTrack(row).track;
		expect(first.open).toEqual(open);
		first.runs.set(B.steamId, 2);
		// the same rule: the memory, not the row
		row.state = null;
		expect(bountyTrack(row).track).toBe(first);
		// saved again: started over, the old state not read back
		row.updatedAt = new Date(2000);
		row.state = bountyState(bountyVersion({ ...row, updatedAt: new Date(1000) }), open);
		const after = bountyTrack(row).track;
		expect(after).not.toBe(first);
		expect(after.open).toBeNull();
		expect(after.runs.size).toBe(0);
		// a rule no longer on is dropped
		keepBounties('server-1', new Set());
		row.state = bountyState(bountyVersion(row), open);
		expect(bountyTrack(row).track.open).toEqual(open);
		forgetBounties('server-1');
	});
});

describe('the Bounty rule, replayed', () => {
	test('runs start over and an open bounty lapses at a new match; a leave lapses it too', () => {
		const batch = (at: number, match: string, kills: BountyKill[], players = 50) => ({
			kind: 'kills' as const,
			at,
			match,
			players,
			kills
		});
		const { outcomes, open } = bountyReplay({ streak: 3, minPlayers: 20 }, [
			batch(1, 'm1', [kill(A, B), kill(A, C)]),
			// a new match: A's run of 2 starts over
			batch(2, 'm2', [kill(A, B), kill(A, C)]),
			batch(3, 'm2', [kill(A, B)], 10),
			batch(4, 'm2', [kill(A, C)]),
			batch(5, 'm3', [kill(B, C)]),
			batch(6, 'm3', [kill(B, C), kill(B, D), kill(B, D)]),
			{ kind: 'left', at: 7, steamId: B.steamId },
			batch(8, 'm3', [kill(C, D), kill(C, D), kill(C, D), kill(C, D)]),
			batch(9, 'm3', [kill(A, C)])
		]);
		expect(outcomes.map((o) => [o.kind, o.at, o.bounty.steamId, 'why' in o ? o.why : ''])).toEqual([
			// too few on at 3; marked at the next kill
			['set', 4, A.steamId, ''],
			['lapse', 5, A.steamId, 'match'],
			['set', 6, B.steamId, ''],
			['lapse', 7, B.steamId, 'left'],
			['set', 8, C.steamId, ''],
			['claim', 9, C.steamId, '']
		]);
		expect(outcomes[0]).toMatchObject({ bounty: { streak: 4 }, players: 50 });
		expect(open).toBeNull();
	});
});
