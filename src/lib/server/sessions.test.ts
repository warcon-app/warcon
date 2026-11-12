import { describe, expect, test } from 'bun:test';
import {
	diffPresence,
	followPlayer,
	LEAVE_GRACE_MS,
	modeMoved,
	modeOf,
	newPresence,
	type OpenSession
} from './sessions';
import type { Player } from '$lib/types';

const player = (steamId: string, name = steamId): Player => ({
	name,
	steamId,
	faction: null,
	kills: 0,
	deaths: 0,
	cash: 0,
	ping: null
});
const open = (steamId: string): OpenSession => ({
	id: Number(steamId.slice(-3)),
	steamId,
	name: steamId,
	hiddenName: null,
	anonymous: false,
	faction: null,
	kills: 0,
	deaths: 0,
	cash: 0,
	game: { kills: 0, deaths: 0, cash: 0 },
	seedMs: 0,
	pendingSeedMs: 0,
	joinedAt: 1000,
	lastSeen: 2000,
	writtenAt: 2000,
	writtenTeam: null,
	writtenMode: '0:',
	firstVisit: false,
	lastFaction: null,
	team: null
});

// The open sessions were last seen at 2000; this look is long after the leave grace.
const LATER = 2000 + LEAVE_GRACE_MS + 1;

describe('diffPresence', () => {
	test('splits the observed list into joined, stayed and left', () => {
		const p = newPresence();
		for (const id of ['76561198100000001', '76561198100000002']) p.open.set(id, open(id));
		const d = diffPresence(p, [player('76561198100000002'), player('76561198100000003')], LATER);
		expect(d.joined.map((x) => x.steamId)).toEqual(['76561198100000003']);
		expect(d.stayed.map((x) => x.session.steamId)).toEqual(['76561198100000002']);
		expect(d.left.map((x) => x.steamId)).toEqual(['76561198100000001']);
	});

	test('reports a player still on under a name the session does not hold', () => {
		const p = newPresence();
		for (const id of ['76561198100000001', '76561198100000002'])
			p.open.set(id, { ...open(id), name: 'Player' });
		const d = diffPresence(
			p,
			[
				player('76561198100000001', '[TAG] Player'),
				player('76561198100000002', 'Player'),
				player('76561198100000003', '[TAG] New')
			],
			LATER
		);
		expect(d.renamed.map((x) => [x.steamId, x.name])).toEqual([
			['76561198100000001', '[TAG] Player']
		]);
		expect(d.joined.map((x) => x.steamId)).toEqual(['76561198100000003']);
	});

	test('ignores duplicates and players without a SteamID', () => {
		const p = newPresence();
		const d = diffPresence(
			p,
			[player('76561198100000009'), player('76561198100000009'), player('')],
			LATER
		);
		expect(d.joined).toHaveLength(1);
		expect(d.stayed).toHaveLength(0);
	});

	test('reports players who have just picked or changed faction', () => {
		const p = newPresence();
		p.open.set('76561198100000001', open('76561198100000001'));
		p.open.set('76561198100000002', {
			...open('76561198100000002'),
			faction: 'Valkyra',
			lastFaction: 'Valkyra'
		});
		const d = diffPresence(
			p,
			[
				{ ...player('76561198100000001'), faction: 'Valkyra' },
				{ ...player('76561198100000002'), faction: 'Kessler' },
				{ ...player('76561198100000003'), faction: 'Valkyra' }
			],
			LATER
		);
		expect(d.factioned.map((x) => [x.player.steamId, x.from])).toEqual([
			['76561198100000001', null],
			['76561198100000002', 'Valkyra']
		]);
		expect(d.joined.map((x) => x.steamId)).toEqual(['76561198100000003']);
	});

	test('a side cleared at match start and picked again is not a new pick', () => {
		const p = newPresence();
		p.open.set('76561198100000001', {
			...open('76561198100000001'),
			faction: null,
			lastFaction: 'Valkyra'
		});
		p.open.set('76561198100000002', {
			...open('76561198100000002'),
			faction: null,
			lastFaction: 'Valkyra'
		});
		const d = diffPresence(
			p,
			[
				{ ...player('76561198100000001'), faction: 'Valkyra' },
				{ ...player('76561198100000002'), faction: 'Kessler' }
			],
			LATER
		);
		expect(d.factioned.map((x) => [x.player.steamId, x.from])).toEqual([
			['76561198100000002', 'Valkyra']
		]);
	});

	test('an empty list means everyone left once the grace has passed', () => {
		const p = newPresence();
		p.open.set('76561198100000001', open('76561198100000001'));
		const d = diffPresence(p, [], LATER);
		expect(d.left).toHaveLength(1);
		expect(d.joined).toHaveLength(0);
	});

	test('a player missing for less than the grace has neither left nor stayed', () => {
		const p = newPresence();
		p.open.set('76561198100000001', open('76561198100000001'));
		const d = diffPresence(p, [], 2000 + LEAVE_GRACE_MS);
		expect(d.left).toHaveLength(0);
		expect(d.stayed).toHaveLength(0);
		expect(d.joined).toHaveLength(0);
	});

	test('the list emptied at a map change and refilled is the same sessions, not joins', () => {
		const p = newPresence();
		for (const id of ['76561198100000001', '76561198100000002']) p.open.set(id, open(id));
		// the game reports nobody while the next map loads
		expect(diffPresence(p, [], 2000 + 35_000).left).toHaveLength(0);
		// the same players are back, with the sides they picked
		const d = diffPresence(
			p,
			[
				{ ...player('76561198100000001'), faction: 'Valkyra' },
				{ ...player('76561198100000002'), faction: 'Kessler' }
			],
			2000 + 36_000
		);
		expect(d.joined).toHaveLength(0);
		expect(d.left).toHaveLength(0);
		expect(d.stayed.map((x) => x.session.steamId)).toEqual([
			'76561198100000001',
			'76561198100000002'
		]);
	});

	test('a player back inside the grace after missing a look has returned (a kick and a reconnect)', () => {
		const p = newPresence();
		for (const id of ['76561198100000001', '76561198100000002']) p.open.set(id, open(id));
		// the previous look, at 5000, saw only ...002 (followed to 5000); ...001 was kicked at 2000
		p.open.get('76561198100000002')!.lastSeen = 5000;
		const d = diffPresence(
			p,
			[player('76561198100000001'), player('76561198100000002')],
			6000,
			LEAVE_GRACE_MS,
			5000
		);
		expect(d.joined).toHaveLength(0);
		expect(d.stayed).toHaveLength(2);
		expect(d.returned.map((x) => x.steamId)).toEqual(['76561198100000001']);
		// without a previous look nobody counts as returned
		expect(
			diffPresence(p, [player('76561198100000001')], 6000, LEAVE_GRACE_MS).returned
		).toHaveLength(0);
	});

	test("the game's holding team between matches is no pick of a side, nor a switch", () => {
		const teams = ['Valkyra', 'Lonestar'];
		const p = newPresence();
		p.open.set('76561198100000001', {
			...open('76561198100000001'),
			faction: 'Valkyra',
			lastFaction: 'Valkyra'
		});
		const white = diffPresence(
			p,
			[{ ...player('76561198100000001'), faction: 'White' }],
			LATER,
			LEAVE_GRACE_MS,
			0,
			teams
		);
		expect(white.factioned).toEqual([]);
		followPlayer(
			p.open.get('76561198100000001')!,
			{ ...player('76561198100000001'), faction: 'White' },
			LATER,
			teams
		);
		expect(p.open.get('76561198100000001')!.lastFaction).toBe('Valkyra');
		// the next match: a new side is a switch from the last team, not from White
		const next = diffPresence(
			p,
			[{ ...player('76561198100000001'), faction: 'Lonestar' }],
			LATER + 1000,
			LEAVE_GRACE_MS,
			0,
			teams
		);
		expect(next.factioned.map((x) => [x.player.faction, x.from])).toEqual([
			['Lonestar', 'Valkyra']
		]);
	});

	test('a leave after the grace keeps the last time the player was seen', () => {
		const p = newPresence();
		p.open.set('76561198100000001', open('76561198100000001'));
		const d = diffPresence(p, [], LATER);
		expect(d.left[0].lastSeen).toBe(2000);
	});
});

describe('followPlayer', () => {
	const at = (kills: number, deaths: number, cash: number): Player => ({
		...player('76561198000000001'),
		faction: 'Lonestar',
		kills,
		deaths,
		cash
	});
	const totals = (s: OpenSession) => [s.kills, s.deaths, s.cash];

	test('a session over two matches keeps the first match when the counters start again, cash included', () => {
		const s = open('76561198000000001');
		followPlayer(s, at(37, 7, 90_000), 3000);
		// the match ends: the game clears the side, the counters and the cash
		followPlayer(s, { ...at(0, 0, 0), faction: null }, 4000);
		expect(totals(s)).toEqual([37, 7, 90_000]);
		followPlayer(s, at(57, 9, 120_000), 5000);
		expect(totals(s)).toEqual([94, 16, 210_000]);
		expect(s.lastSeen).toBe(5000);
	});

	test('a session keeps the hidden name once its player was seen in anonymous mode, and whether it is in use', () => {
		const s = open('76561198000000001');
		followPlayer(s, at(1, 0, 0), 1000);
		expect([s.hiddenName, s.anonymous, modeMoved(s)]).toEqual([null, false, false]);
		followPlayer(s, { ...at(2, 0, 0), hiddenName: 'Falcon' }, 2000);
		// a change of mode is one the row does not hold yet
		expect([s.hiddenName, s.anonymous, modeMoved(s)]).toEqual(['Falcon', true, true]);
		s.writtenMode = modeOf(s);
		// the mode switched off again: the session still says it was played under that name, and
		// that the name is no longer the one the others see
		followPlayer(s, at(3, 0, 0), 3000);
		expect([s.hiddenName, s.anonymous, modeMoved(s)]).toEqual(['Falcon', false, true]);
		s.writtenMode = modeOf(s);
		// and on again under another name: the last one seen
		followPlayer(s, { ...at(4, 0, 0), hiddenName: 'Heron' }, 4000);
		expect([s.hiddenName, s.anonymous, modeMoved(s)]).toEqual(['Heron', true, true]);
		s.writtenMode = modeOf(s);
		followPlayer(s, { ...at(5, 0, 0), hiddenName: 'Heron' }, 5000);
		expect(modeMoved(s)).toBe(false);
		expect(s.name).toBe('76561198000000001');
	});

	test('the team played is kept when the player ends on the holding team or no side', () => {
		const teams = ['Lonestar', 'Wagner'];
		const s = open('76561198000000001');
		followPlayer(s, at(3, 1, 0), 3000, teams);
		followPlayer(s, { ...at(0, 0, 0), faction: 'White' }, 4000, teams);
		expect([s.faction, s.team]).toEqual(['White', 'Lonestar']);
		followPlayer(s, { ...at(0, 0, 0), faction: null }, 5000, teams);
		expect(s.team).toBe('Lonestar');
		// without a scoreboard any side is a team
		followPlayer(s, { ...at(0, 0, 0), faction: 'Wagner' }, 6000, []);
		expect(s.team).toBe('Wagner');
	});

	test('the same look twice counts once, and cash spent within a match comes off', () => {
		const s = open('76561198000000001');
		followPlayer(s, at(5, 1, 20_000), 3000);
		followPlayer(s, at(5, 1, 20_000), 3000);
		followPlayer(s, at(6, 1, 8_000), 4000);
		expect(totals(s)).toEqual([6, 1, 8_000]);
	});

	test('deaths falling alone is a new match too', () => {
		const s = open('76561198000000001');
		followPlayer(s, at(0, 4, 0), 3000);
		followPlayer(s, at(0, 1, 0), 4000);
		expect(totals(s)).toEqual([0, 5, 0]);
	});

	test('a session reloaded after a restart keeps what earlier matches reached', () => {
		const s = { ...open('76561198000000001'), kills: 94, deaths: 16, cash: 210_000, game: null };
		followPlayer(s, at(58, 9, 121_000), 3000);
		expect(totals(s)).toEqual([94, 16, 210_000]);
		followPlayer(s, at(60, 9, 125_000), 4000);
		expect(totals(s)).toEqual([96, 16, 214_000]);
		// a single-match session reloaded simply follows the game
		const one = { ...open('76561198000000001'), kills: 10, deaths: 2, cash: 5_000, game: null };
		followPlayer(one, at(12, 2, 6_000), 3000);
		expect(totals(one)).toEqual([12, 2, 6_000]);
	});
});
