import { describe, expect, test } from 'bun:test';
import {
	clanTag,
	emptyTwoTeamsState,
	TWO_TEAMS_ASK_WINDOW_MS,
	TWO_TEAMS_CLOSED_REASK_MS,
	TWO_TEAMS_FORGET_MS,
	TWO_TEAMS_MAX_ASKS,
	TWO_TEAMS_PICK_HOLD_MS,
	TWO_TEAMS_RETRY_MS,
	TWO_TEAMS_SIDE_FORGET_MS,
	TWO_TEAMS_STAFF_MOVE_MS,
	teamName,
	twoTeamsSettingsKey,
	twoTeamsStep,
	validateTwoTeams,
	type TwoTeamsConfig,
	type TwoTeamsState
} from './two-teams';

const cfg: TwoTeamsConfig = {
	closedFaction: 'Lonestar',
	names: { Valkyra: 'Red', Manticore: 'Green' },
	message: 'You are on {team}.'
};
const OPEN = ['Valkyra', 'Manticore'];
const ALL = 100;
const p = (id: string, faction: string | null) => ({ steamId: id, name: `P${id}`, faction });
const first = () => 0;
const step = (
	state: TwoTeamsState,
	players: ReturnType<typeof p>[],
	now: number,
	maxMoves = ALL,
	c = cfg
) => twoTeamsStep(c, state, players, OPEN, now, maxMoves, {}, first);

describe('validateTwoTeams', () => {
	test('needs a closed faction, balancing, or both', () => {
		expect(() => validateTwoTeams({})).toThrow('Close a faction, keep the sides even, or both.');
		expect(validateTwoTeams({ balance: true }).closedFaction).toBe('');
	});
	test('keeps names for the open factions only, and an empty message', () => {
		expect(
			validateTwoTeams({
				closedFaction: 'Lonestar',
				names: { Lonestar: 'Blue', Valkyra: 'Red', Manticore: '' }
			})
		).toEqual({
			closedFaction: 'Lonestar',
			names: { Valkyra: 'Red' },
			message: '',
			balance: false,
			gap: 3,
			clans: false,
			exempt: [],
			watchOnly: false
		});
	});
	test('a gap of 1 to 20, and players left alone by SteamID64', () => {
		for (const gap of [0, 21, 2.5, '3', -1])
			expect(() => validateTwoTeams({ balance: true, gap })).toThrow('1 to 20');
		expect(validateTwoTeams({ balance: true, gap: 1 }).gap).toBe(1);
		// without balancing the gap is unused: a blank or stray one keeps the default
		expect(validateTwoTeams({ closedFaction: 'Lonestar', gap: 0 }).gap).toBe(3);
		expect(
			validateTwoTeams({ balance: true, exempt: [' 76561198000000001', '76561198000000001'] })
				.exempt
		).toEqual(['76561198000000001']);
		expect(() => validateTwoTeams({ balance: true, exempt: ['someadmin'] })).toThrow(
			'"someadmin" is not a SteamID64'
		);
		expect(() => validateTwoTeams({ balance: true, exempt: '76561198000000001' })).toThrow(
			'exempt must be a list'
		);
		const many = Array.from({ length: 101 }, (_, i) => String(76561198000000000n + BigInt(i)));
		expect(() => validateTwoTeams({ balance: true, exempt: many })).toThrow('At most 100');
	});
});

describe('twoTeamsStep', () => {
	test('moves everyone on the closed faction, filling the smaller side first', () => {
		const players = [
			p('1', 'Valkyra'),
			p('2', 'Valkyra'),
			p('3', 'Lonestar'),
			p('4', 'Lonestar'),
			p('5', 'Lonestar')
		];
		const r = step(emptyTwoTeamsState(), players, 0);
		expect(r.moves.map((m) => m.to)).toEqual(['Manticore', 'Manticore', 'Valkyra']);
	});

	test('does nothing with fewer than two open factions', () => {
		const r = twoTeamsStep(cfg, emptyTwoTeamsState(), [p('1', 'Lonestar')], ['Valkyra'], 0, ALL);
		expect(r.moves).toEqual([]);
		const balancing = { ...cfg, balance: true };
		const one = twoTeamsStep(
			balancing,
			emptyTwoTeamsState(),
			[p('1', 'Lonestar'), p('2', 'Valkyra')],
			['Valkyra'],
			0,
			ALL
		);
		expect(one.moves).toEqual([]);
		// nothing was taken as placed against a scoreboard it could not read
		expect(one.state.seeded).toBe(false);
	});

	test('leaves unplaced players and the open sides alone', () => {
		const r = step(
			emptyTwoTeamsState(),
			[p('1', null), p('2', 'Valkyra'), p('3', 'Valkyra'), p('4', 'Valkyra')],
			0
		);
		expect(r.moves).toEqual([]);
	});

	test('a move in flight is not asked for again, and counts toward its side', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		expect(a.moves).toHaveLength(1);
		const to = a.moves[0].to;
		const b = step(a.state, [p('1', 'Lonestar'), p('2', 'Lonestar')], 5000);
		expect(b.moves).toEqual([expect.objectContaining({ steamId: '2' })]);
		expect(b.moves[0].to).not.toBe(to);
	});

	test('a move that has not landed is retried', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		const b = step(a.state, [p('1', 'Lonestar')], TWO_TEAMS_RETRY_MS);
		expect(b.moves).toHaveLength(1);
	});

	test('a landed player is whispered once, and not again after the next match re-sort', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		const b = step(a.state, [p('1', a.moves[0].to)], 5000);
		expect(b.whispers).toEqual([{ steamId: '1', name: 'P1', faction: a.moves[0].to }]);
		const c = step(b.state, [p('1', 'Lonestar')], 60_000);
		const d = step(c.state, [p('1', c.moves[0].to)], 65_000);
		expect(d.whispers).toEqual([]);
	});

	test('no whisper and nothing remembered without a message, and none for players it never moved', () => {
		const quiet = { ...cfg, message: '' };
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0, ALL, quiet);
		const b = step(a.state, [p('1', 'Valkyra')], 5000, ALL, quiet);
		expect(b.whispers).toEqual([]);
		expect(b.state.told.size).toBe(0);
		expect(step(emptyTwoTeamsState(), [p('2', 'Valkyra')], 0).whispers).toEqual([]);
	});

	test('a told player is forgotten after long enough away', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		const b = step(a.state, [p('1', 'Valkyra')], 1000);
		expect(b.state.told.has('1')).toBe(true);
		const gone = step(b.state, [], 1000 + TWO_TEAMS_FORGET_MS + 1);
		expect(gone.state.told.size).toBe(0);
	});

	test('asks for at most the given number of moves per look; the rest go at the next looks', () => {
		const everyone = Array.from({ length: 10 }, (_, i) => p(String(i), 'Lonestar'));
		const a = step(emptyTwoTeamsState(), everyone, 0, 4);
		expect(a.moves.map((m) => m.steamId)).toEqual(['0', '1', '2', '3']);
		// the four asked are still on their way; the next four are placed against them
		const b = step(a.state, everyone, 1000, 4);
		expect(b.moves.map((m) => m.steamId)).toEqual(['4', '5', '6', '7']);
		const sides = [...a.moves, ...b.moves].map((m) => m.to);
		expect(sides.filter((s) => s === 'Valkyra')).toHaveLength(4);
	});

	test('a player back on the closed faction again and again is still moved off it, once a minute after the third ask', () => {
		let state = emptyTwoTeamsState();
		const asked: number[] = [];
		const stopped: string[] = [];
		// every look: back on the closed faction, as a player picking it again does
		for (let look = 0; look < 100; look++) {
			const now = look * 2000;
			const faction = look % 2 === 0 ? 'Lonestar' : 'Valkyra';
			const r = step(state, [p('1', faction)], now);
			state = r.state;
			if (r.moves.length) asked.push(now);
			stopped.push(...r.stopped.map((s) => s.steamId));
		}
		// three at once, then one for each TWO_TEAMS_CLOSED_REASK_MS since the last
		expect(asked).toEqual([0, 4000, 8000, 68_000, 128_000, 188_000]);
		expect(asked[3] - asked[2]).toBe(TWO_TEAMS_CLOSED_REASK_MS);
		// never left on the closed faction, so never said to be
		expect(stopped).toEqual([]);
		expect(state.capped.has('1')).toBe(false);
		// once the window has passed, the rule asks at its usual pace again
		const later = step(state, [p('1', 'Lonestar')], 188_000 + TWO_TEAMS_ASK_WINDOW_MS);
		expect(later.moves).toHaveLength(1);
	});
});

describe('twoTeamsStep balancing', () => {
	const V = 'Valkyra';
	const M = 'Manticore';
	const B: TwoTeamsConfig = {
		closedFaction: 'Lonestar',
		names: {},
		message: '',
		balance: true,
		gap: 3,
		clans: false,
		exempt: [],
		watchOnly: false
	};
	const named = (id: string, name: string, faction: string | null) => ({
		steamId: id,
		name,
		faction
	});
	const side = (prefix: string, n: number, faction: string) =>
		Array.from({ length: n }, (_, i) => p(`${prefix}${i}`, faction));
	const bal = (
		state: TwoTeamsState,
		players: ReturnType<typeof p>[],
		now: number,
		look: Parameters<typeof twoTeamsStep>[6] = {},
		c: TwoTeamsConfig = B,
		maxMoves = ALL,
		open = OPEN
	) => twoTeamsStep(c, state, players, open, now, maxMoves, look, first);
	/** the list once these moves have landed */
	const land = (players: ReturnType<typeof p>[], moves: { steamId: string; to: string }[]) =>
		players.map((x) => {
			const m = moves.find((y) => y.steamId === x.steamId);
			return m ? { ...x, faction: m.to } : x;
		});
	const count = (players: ReturnType<typeof p>[], f: string) =>
		players.filter((x) => x.faction === f).length;
	/** a rule that has seen these players once, as placed */
	const seeded = (players: ReturnType<typeof p>[], c = B) =>
		bal(emptyTwoTeamsState(), players, 0, {}, c).state;

	test('takes whoever is on when it starts as placed, however uneven', () => {
		const r = bal(emptyTwoTeamsState(), [...side('v', 12, V), ...side('m', 2, M)], 0);
		expect(r.moves).toEqual([]);
		expect(r.state.seeded).toBe(true);
		// and moves none of them at the next look either
		expect(bal(r.state, [...side('v', 12, V), ...side('m', 2, M)], 2000).moves).toEqual([]);
	});

	test('an arrival stays on their side while it keeps within the gap, else goes to the lighter', () => {
		let players = [...side('v', 5, V), ...side('m', 5, M)];
		let state = seeded(players);
		for (const [i, id] of ['a', 'b', 'c'].entries()) {
			players = [...players, p(id, V)];
			const r = bal(state, players, 1000 * (i + 1));
			expect(r.moves).toEqual([]);
			state = r.state;
		}
		// 8 v 5: one more on Valkyra would be four ahead
		const r = bal(state, [...players, p('d', V)], 5000);
		expect(r.moves).toEqual([{ steamId: 'd', name: 'Pd', from: V, to: M, why: 'placed' }]);
	});

	test('a player who switches onto the bigger side is put back; onto the smaller, it sticks', () => {
		const players = [...side('v', 7, V), ...side('m', 5, M)];
		const state = seeded(players);
		const stacker = bal(
			state,
			players.map((x) => (x.steamId === 'm0' ? { ...x, faction: V } : x)),
			2000
		);
		expect(stacker.moves).toEqual([{ steamId: 'm0', name: 'Pm0', from: V, to: M, why: 'back' }]);
		const helper = bal(
			state,
			players.map((x) => (x.steamId === 'v0' ? { ...x, faction: M } : x)),
			2000
		);
		expect(helper.moves).toEqual([]);
		expect(helper.state.sides.get('v0')?.side).toBe(M);
	});

	test('a player who keeps switching onto the bigger side is put back at most three times in ten minutes', () => {
		const players = [...side('v', 7, V), ...side('m', 5, M)];
		let state = seeded(players);
		let asks = 0;
		const stopped: string[] = [];
		for (let look = 1; look <= 30; look++) {
			const faction = look % 2 === 1 ? V : M;
			const list = players.map((x) => (x.steamId === 'm0' ? { ...x, faction } : x));
			const r = bal(state, list, look * 2000);
			state = r.state;
			asks += r.moves.length;
			stopped.push(...r.stopped.map((s) => s.steamId));
		}
		expect(asks).toBe(TWO_TEAMS_MAX_ASKS);
		expect(stopped).toEqual(['m0']);
		// once the window has passed, the rule puts them back again
		const list = players.map((x) => (x.steamId === 'm0' ? { ...x, faction: V } : x));
		const later = bal(state, list, TWO_TEAMS_ASK_WINDOW_MS + 60_000);
		expect(later.moves.map((m) => m.why)).toEqual(['back']);
		expect(later.state.capped.has('m0')).toBe(false);
	});

	test('a player who leaves and rejoins on the bigger side is still put back, until forgotten', () => {
		const players = [...side('v', 7, V), ...side('m', 5, M)];
		const others = players.filter((x) => x.steamId !== 'm0');
		const away = bal(seeded(players), others, 60_000).state;
		const back = [...others, p('m0', V)];
		expect(bal(away, back, 5 * 60_000).moves.map((m) => m.why)).toEqual(['back']);
		// long enough away and they are a new arrival, placed by the same numbers
		const stillAway = bal(away, others, TWO_TEAMS_SIDE_FORGET_MS).state;
		const later = bal(stillAway, back, TWO_TEAMS_SIDE_FORGET_MS + 1000).moves;
		expect(later.map((m) => [m.steamId, m.to, m.why])).toEqual([['m0', M, 'placed']]);
	});

	test('a new match evens the sides from the bigger side only, a few moves at a time', () => {
		let players = [...side('v', 14, V), ...side('m', 4, M)];
		let state = seeded(players);
		const first3 = bal(state, players, 1000, { newMatch: true }, B, 3);
		expect(first3.moves.map((m) => m.steamId)).toEqual(['v0', 'v1', 'v2']);
		// still in flight at the next look: counted on their way, not asked for again
		const next = bal(first3.state, players, 2000, {}, B, 3);
		expect(next.moves.map((m) => m.steamId)).toEqual(['v3']);
		expect(next.state.moving.has('v0')).toBe(true);
		players = land(players, [...first3.moves, ...next.moves]);
		const settled = bal(next.state, players, 3000, {}, B, 3);
		expect(settled.moves).toEqual([]);
		expect([count(players, V), count(players, M)]).toEqual([10, 8]);
		expect([...first3.moves, ...next.moves].every((m) => m.from === V && m.to === M)).toBe(true);
	});

	test('a match end puts no one back: a switch at a new match is a placement', () => {
		const players = [...side('v', 7, V), ...side('m', 5, M)];
		const moved = players.map((x) => (x.steamId === 'm0' ? { ...x, faction: V } : x));
		const r = bal(seeded(players), moved, 2000, { newMatch: true });
		expect(r.moves.map((m) => m.why)).not.toContain('back');
	});

	test('a squad switching onto the bigger side together is put back; nobody else is moved', () => {
		const players = [...side('v', 6, V), ...side('m', 6, M)];
		// four of Manticore show up on Valkyra in one look: 10 v 2
		const stacked = players.map((x) =>
			['m0', 'm1', 'm2', 'm3'].includes(x.steamId) ? { ...x, faction: V } : x
		);
		const r = bal(seeded(players), stacked, 2000);
		// three put back makes it 7 v 5, within the gap, so the fourth's switch sticks
		expect(r.moves.map((m) => [m.steamId, m.to, m.why])).toEqual([
			['m0', M, 'back'],
			['m1', M, 'back'],
			['m2', M, 'back']
		]);
		expect(r.state.sides.get('m3')?.side).toBe(V);
	});

	test('a new match drops the moves decided before it and decides afresh', () => {
		const players = [...side('v', 8, V), ...side('m', 5, M)];
		const a = bal(seeded(players), [...players, p('new', V)], 1000);
		expect(a.state.moving.has('new')).toBe(true);
		// the match ends before the move lands; the new match's counts are even with them on Valkyra
		const even = [...side('v', 6, V), ...side('m', 7, M), p('new', V)];
		const b = bal(a.state, even, 2000, { newMatch: true });
		expect(b.state.moving.has('new')).toBe(false);
		expect(b.moves).toEqual([]);
	});

	test('right after a match end, placing waits while a quarter or more have not picked a side', () => {
		const players = [...side('v', 8, V), ...side('m', 8, M)];
		// the match end is seen while the list is empty, as the next map loads
		const loading = bal(seeded(players), [], 1000, { newMatch: true });
		// back 35 s later: five have picked Valkyra, eleven are still on the game's holding side
		const picking = [...side('v', 5, V), ...side('w', 11, 'White')];
		const a = bal(loading.state, picking, 36_000);
		expect(a.moves).toEqual([]);
		// most have picked: placing goes on from the fuller picture
		const picked = [...side('v', 9, V), ...side('m', 3, M), ...side('w', 2, 'White')];
		expect(bal(a.state, picked, 38_000).moves.length).toBeGreaterThan(0);
		// and the hold ends on its own, counted from the list being back, however many are picking
		expect(bal(a.state, picking, 36_000 + TWO_TEAMS_PICK_HOLD_MS).moves.length).toBeGreaterThan(0);
	});

	test('a rule starting over while a match starts holds the same way', () => {
		const picking = [...side('v', 2, V), ...side('w', 14, 'White')];
		const a = bal(emptyTwoTeamsState(), picking, 0);
		expect(a.state.seeded).toBe(true);
		const more = [...side('v', 4, V), ...side('w', 12, 'White')];
		expect(bal(a.state, more, 2000).moves).toEqual([]);
	});

	test('no whisper on a match end look: the new match may move the player again at once', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		const landed = [p('1', a.moves[0].to)];
		expect(step(a.state, landed, 1000).whispers).toHaveLength(1);
		const b = twoTeamsStep(cfg, a.state, landed, OPEN, 1000, ALL, { newMatch: true }, first);
		expect(b.whispers).toEqual([]);
	});

	test('a match end drops the moves in flight on a rule that only closes a faction', () => {
		const a = step(emptyTwoTeamsState(), [p('1', 'Lonestar')], 0);
		expect(a.state.moving.size).toBe(1);
		const b = twoTeamsStep(cfg, a.state, [], OPEN, 1000, ALL, { newMatch: true }, first);
		expect(b.state.moving.size).toBe(0);
	});

	test('seeds only once someone is on a side', () => {
		const empty = bal(emptyTwoTeamsState(), [p('w0', 'White')], 0);
		expect(empty.state.seeded).toBe(false);
		const players = [...side('v', 12, V), ...side('m', 4, M)];
		const r = bal(empty.state, players, 1000);
		expect(r.moves).toEqual([]);
		expect(r.state.seeded).toBe(true);
	});

	test('the players moved to even a new match are not picked by list order', () => {
		const players = [...side('v', 14, V), ...side('m', 4, M)];
		// the last in the list comes first
		let k = 1;
		const reverse = () => (k -= 0.001);
		const r = twoTeamsStep(
			B,
			seeded(players),
			players,
			OPEN,
			1000,
			ALL,
			{ newMatch: true },
			reverse
		);
		expect(r.moves[0].steamId).toBe('v13');
	});

	test('clan tags: an arrival joins their clan while the gap allows it', () => {
		const players = [
			named('t1', '[ABC] One', V),
			named('t2', '[abc]Two', V),
			named('t3', '[ABC] Three', V),
			...side('v', 3, V),
			...side('m', 6, M)
		];
		const withClans = { ...B, clans: true };
		const arrival = named('t4', '[ABC] Four', M);
		const r = bal(seeded(players, withClans), [...players, arrival], 1000, {}, withClans);
		expect(r.moves).toEqual([{ steamId: 't4', name: '[ABC] Four', from: M, to: V, why: 'placed' }]);
		// without clans it stays where it picked
		expect(bal(seeded(players), [...players, arrival], 1000).moves).toEqual([]);
		// and never past the gap: 9 v 6, the clan's side would be four ahead
		const ahead = [...players, ...side('x', 3, V)];
		expect(bal(seeded(ahead, withClans), [...ahead, arrival], 1000, {}, withClans).moves).toEqual(
			[]
		);
	});

	test('clanmates arriving on opposite sides are put together with one move', () => {
		const withClans = { ...B, clans: true };
		const players = [...side('v', 4, V), ...side('m', 4, M)];
		const r = bal(
			seeded(players, withClans),
			[...players, named('a1', '[ABC] One', V), named('a2', '[ABC] Two', M)],
			1000,
			{},
			withClans
		);
		expect(r.moves).toEqual([{ steamId: 'a1', name: '[ABC] One', from: V, to: M, why: 'placed' }]);
	});

	test('clanmates arriving together on the closed faction go to the same side', () => {
		const withClans = { ...B, clans: true };
		const players = [...side('v', 4, V), ...side('m', 4, M)];
		const r = bal(
			seeded(players, withClans),
			[...players, named('c1', '[ABC] One', 'Lonestar'), named('c2', '[ABC] Two', 'Lonestar')],
			1000,
			{},
			withClans
		);
		expect(new Set(r.moves.map((m) => m.to)).size).toBe(1);
	});

	test('clanTag reads a short bracketed tag at the front, in one case', () => {
		expect(clanTag('[ABC] Name')).toBe('abc');
		expect(clanTag('  {Wolf}Name')).toBe('wolf');
		expect(clanTag('(TAG) x')).toBe('tag');
		expect(clanTag('Name [ABC]')).toBeNull();
		expect(clanTag('[] Name')).toBeNull();
		expect(clanTag('[a tag far too long to be one] Name')).toBeNull();
	});

	test('a move a person made from the panel is kept, not put back', () => {
		const players = [...side('v', 7, V), ...side('m', 5, M)];
		const state = seeded(players);
		const moved = players.map((x) => (x.steamId === 'm0' ? { ...x, faction: V } : x));
		const staffMoves = new Map([['m0', { faction: V, at: 1500 }]]);
		const r = bal(state, moved, 2000, { staffMoves });
		expect(r.moves).toEqual([]);
		expect(r.state.sides.get('m0')?.side).toBe(V);
		// once taken, it stays taken after the note has gone
		expect(bal(r.state, moved, 2000 + TWO_TEAMS_STAFF_MOVE_MS).moves).toEqual([]);
		// a note for another side, or an old one, does not cover a switch
		for (const note of [
			{ faction: M, at: 1500 },
			{ faction: V, at: 2000 - TWO_TEAMS_STAFF_MOVE_MS }
		])
			expect(bal(state, moved, 2000, { staffMoves: new Map([['m0', note]]) }).moves).toHaveLength(
				1
			);
	});

	test('players left alone by SteamID are never moved, and still count', () => {
		const exempt = { ...B, exempt: ['admin', 'blue'] };
		const players = [...side('v', 7, V), ...side('m', 5, M)];
		const state = seeded(players, exempt);
		const r = bal(
			state,
			[...players, p('admin', V), p('blue', 'Lonestar'), p('new', V)],
			2000,
			{},
			exempt
		);
		// the admin counts: Valkyra is 8 v 5 before the arrival, so the arrival goes to Manticore
		expect(r.moves).toEqual([{ steamId: 'new', name: 'Pnew', from: V, to: M, why: 'placed' }]);
	});

	test('watch only decides each move once and sends none', () => {
		const watch = { ...B, watchOnly: true, message: 'You are on {team}.' };
		const players = [...side('v', 8, V), ...side('m', 4, M)];
		const state = seeded(players, watch);
		const arrivals = [...players, p('new', V), p('blue', 'Lonestar')];
		const a = bal(state, arrivals, 1000, {}, watch);
		expect(a.moves.map((m) => [m.steamId, m.to])).toEqual([
			['blue', M],
			['new', M]
		]);
		expect(a.state.moving.size).toBe(0);
		// the same list again: taken as where it would have put them, nothing new, no whispers
		const b = bal(a.state, arrivals, 2000, {}, watch);
		expect(b.moves).toEqual([]);
		expect(b.whispers).toEqual([]);
		// the counts it decides from include them: one more on Valkyra is now fine
		expect(bal(b.state, [...arrivals, p('late', V)], 3000, {}, watch).moves).toEqual([]);
	});

	test('with no faction closed, three sides are kept even', () => {
		const three = ['Lonestar', V, M];
		const open = { ...B, closedFaction: '' };
		const players = [...side('l', 5, 'Lonestar'), ...side('v', 5, V), ...side('m', 2, M)];
		const state = bal(emptyTwoTeamsState(), players, 0, {}, open, ALL, three).state;
		const r = bal(state, [...players, p('new', V)], 1000, {}, open, ALL, three);
		expect(r.moves).toEqual([{ steamId: 'new', name: 'Pnew', from: V, to: M, why: 'placed' }]);
	});

	test('a balancing move is not landed until the player is off the side it moved them from', () => {
		const players = [...side('v', 8, V), ...side('m', 5, M)];
		const a = bal(seeded(players), [...players, p('new', V)], 1000);
		expect(a.moves).toHaveLength(1);
		// still on Valkyra at the next look: in flight, not asked again, and not placed there
		const b = bal(a.state, [...players, p('new', V)], 2000);
		expect(b.moves).toEqual([]);
		expect(b.state.sides.get('new')?.side).toBeNull();
		const c = bal(b.state, [...players, p('new', M)], 3000);
		expect(c.state.moving.has('new')).toBe(false);
		expect(c.state.sides.get('new')?.side).toBe(M);
	});
});

test('teamName falls back to the faction, never to an inherited property', () => {
	expect(teamName(cfg, 'Valkyra')).toBe('Red');
	expect(teamName({ ...cfg, names: {} }, 'Valkyra')).toBe('Valkyra');
	expect(teamName(cfg, 'constructor')).toBe('constructor');
});

test("a rule's settings fingerprint does not depend on key order, and changes with any setting", () => {
	const key = twoTeamsSettingsKey(cfg);
	expect(
		twoTeamsSettingsKey({
			message: cfg.message,
			names: { ...cfg.names },
			closedFaction: 'Lonestar'
		})
	).toBe(key);
	expect(twoTeamsSettingsKey({ ...cfg, names: { Manticore: 'Green', Valkyra: 'Red' } })).toBe(key);
	expect(twoTeamsSettingsKey({ ...cfg, closedFaction: 'Valkyra' })).not.toBe(key);
	expect(twoTeamsSettingsKey({ ...cfg, message: '' })).not.toBe(key);
});
