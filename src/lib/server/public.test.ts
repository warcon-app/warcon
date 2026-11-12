import { describe, expect, test } from 'bun:test';
import { publicKill, publicMatch, publicStatus, type PublicServer } from './public';
import { awardsFor, type MatchLine, type MatchView } from '$lib/matches';
import type { KillView, LiveView } from '$lib/types';

const kill: KillView = {
	eventId: 'e1',
	ts: '2026-09-17T20:00:00.000Z',
	map: 'Kavkazi',
	eventTime: 412.5,
	killer: { steamId: '76561198100000101', name: 'Ghostpepper', faction: 'Valkyra' },
	victim: { steamId: '76561198100000105', name: 'Nomad', faction: 'Lonestar' },
	cause: 'Id.Item.AK74M',
	distanceM: 61.2,
	headshot: true,
	suicide: false,
	teamKill: false,
	tags: ['Penetration']
};

describe('publicKill', () => {
	test('keeps names, factions, weapon and distance and drops both SteamIDs', () => {
		const k = publicKill(kill);
		expect(k).toEqual({
			eventId: 'e1',
			ts: '2026-09-17T20:00:00.000Z',
			eventTime: 412.5,
			killer: { name: 'Ghostpepper', faction: 'Valkyra' },
			victim: { name: 'Nomad', faction: 'Lonestar' },
			cause: 'Id.Item.AK74M',
			distanceM: 61.2,
			headshot: true,
			suicide: false,
			teamKill: false,
			tags: ['Penetration']
		});
		expect(JSON.stringify(k)).not.toContain('7656119');
	});
	test('an environment kill has no killer', () => {
		expect(publicKill({ ...kill, killer: null }).killer).toBeNull();
	});
});

const live = {
	serverId: 's1',
	ok: true,
	error: '',
	tier: 'hot',
	build: '',
	gameServerId: 'abc',
	startedAt: null,
	reservedSlots: null,
	status: {
		serverName: 'x',
		map: 'Kavkazi',
		experiences: [],
		lighting: 'DayClear',
		alternator: '',
		scoreTick: null,
		scoreTickMin: null,
		scoreTickMax: null,
		scoreCap: 100,
		matchSeconds: null,
		playerCount: 1,
		maxPlayers: 32,
		scores: [],
		rotationNow: 0,
		rotationNext: 0
	},
	players: [
		{
			name: 'Nomad',
			steamId: '76561198100000105',
			faction: 'Lonestar',
			kills: 3,
			deaths: 1,
			cash: 0,
			ping: 20
		}
	],
	statusAt: null,
	playersAt: null,
	observedAt: '2026-09-17T20:00:00.000Z'
} as unknown as LiveView;
const server = (leaderboards: boolean) =>
	({
		server: { id: 's1', name: 'One', publicKills: false },
		org: { name: 'Org', discordInviteUrl: '' },
		features: { status: true, leaderboards }
	}) as unknown as PublicServer;

describe('publicStatus roster', () => {
	test('carries the SteamID as a link only while the career pages are open', () => {
		expect(publicStatus(server(true), live, null).roster[0].steamId).toBe('76561198100000105');
		expect(publicStatus(server(false), live, null).roster[0].steamId).toBeNull();
	});

	test('a player in anonymous mode is there as the game shows them, with no way on to who they are', () => {
		const withAnon = {
			...live,
			players: [
				...live.players,
				{
					name: 'Mad Marmalade',
					hiddenName: 'Falcon',
					steamId: '76561198100000102',
					faction: 'Valkyra',
					kills: 9,
					deaths: 2,
					cash: 0,
					ping: 31
				}
			]
		} as unknown as LiveView;
		const page = publicStatus(server(true), withAnon, null);
		expect(page.roster).toEqual([
			{ name: 'Falcon', faction: 'Valkyra', kills: 9, deaths: 2, steamId: null },
			{ name: 'Nomad', faction: 'Lonestar', kills: 3, deaths: 1, steamId: '76561198100000105' }
		]);
		const sent = JSON.stringify(page);
		expect(sent).not.toContain('Mad Marmalade');
		expect(sent).not.toContain('76561198100000102');
	});

	test('the last kills name a player in anonymous mode the same way', () => {
		const kills = [kill, { ...kill, eventId: 'e2', killer: kill.victim, victim: kill.killer! }];
		const hidden = new Map([['76561198100000101', 'Heron']]);
		const page = publicStatus({ ...server(true) }, live, kills, hidden);
		expect(page.kills!.map((k) => [k.killer?.name, k.victim.name])).toEqual([
			['Heron', 'Nomad'],
			['Nomad', 'Heron']
		]);
		expect(JSON.stringify(page.kills)).not.toContain('Ghostpepper');
		// nobody hidden: as fed
		expect(publicStatus(server(true), live, kills).kills![0].killer?.name).toBe('Ghostpepper');
		expect(publicKill(kill, new Map()).killer?.name).toBe('Ghostpepper');
	});
});

describe('publicMatch', () => {
	const line = (steamId: string, name: string, kills: number, extra: Partial<MatchLine> = {}) =>
		({
			steamId,
			name,
			faction: 'Valkyra',
			seconds: 1800,
			kills,
			deaths: 2,
			cashDelta: kills * 150,
			headshots: 0,
			teamKills: 0,
			suicides: 0,
			vehicleKills: 0,
			longestM: kills * 10,
			killStreak: kills,
			deathStreak: 0,
			result: 'win',
			...extra
		}) satisfies MatchLine;
	const viewOf = (lines: MatchLine[]): MatchView => ({
		match: {
			id: 7,
			startedAt: '2026-11-12T18:00:00.000Z',
			endedAt: '2026-11-12T18:30:00.000Z',
			map: 'Kavkazi',
			experiences: null,
			lighting: null,
			peakPlayers: lines.length,
			players: lines.length,
			finalScores: [{ name: 'Valkyra', score: 100 }],
			winner: 'Valkyra'
		},
		factions: [{ name: 'Valkyra', colorHex: null }],
		lines,
		timeline: [],
		awards: awardsFor(lines, 1800),
		kills: 3,
		hasFeed: true
	});
	const A = '76561198100000101';
	const B = '76561198100000102';
	const C = '76561198100000103';
	const staff = viewOf([
		line(A, 'Ghostpepper', 30, { hiddenName: 'Heron' }),
		line(B, 'Mad Marmalade', 12),
		line(C, 'T0XIC', 4, { hiddenName: 'Heron' })
	]);

	test('a player who played the match in anonymous mode is on it under the hidden name alone', () => {
		// the staff's view holds what there is to hide: the awards go to the top line
		expect(staff.awards.length).toBeGreaterThan(0);
		expect(staff.awards.every((a) => a.steamId === A && a.name === 'Ghostpepper')).toBe(true);
		const { view, hidden } = publicMatch(staff);
		expect(view.lines.map((l) => [l.steamId, l.name, l.kills])).toEqual([
			['anon-1', 'Heron', 30],
			[B, 'Mad Marmalade', 12],
			// two players can share a hidden name; their lines stay two
			['anon-2', 'Heron', 4]
		]);
		expect(view.awards.map((a) => [a.steamId, a.name])).toEqual(
			staff.awards.map(() => ['anon-1', 'Heron'])
		);
		// nothing of either player is left anywhere in what is sent
		const sent = JSON.stringify(view);
		for (const gone of [A, C, 'Ghostpepper', 'T0XIC', 'hiddenName'])
			expect(sent).not.toContain(gone);
		// the kills of the match are named from the same lines
		expect([...hidden]).toEqual([
			[A, 'Heron'],
			[C, 'Heron']
		]);
		const fed = { ...kill, killer: { steamId: A, name: 'Ghostpepper', faction: 'Valkyra' } };
		expect(publicKill(fed, hidden).killer?.name).toBe('Heron');
		// the staff's own view is left as it was
		expect(staff.lines[0]).toMatchObject({ steamId: A, name: 'Ghostpepper', hiddenName: 'Heron' });
	});

	test('a match nobody played hidden goes as it is', () => {
		const open = viewOf([line(A, 'Ghostpepper', 30), line(B, 'Mad Marmalade', 12)]);
		const { view, hidden } = publicMatch(open);
		expect(view).toBe(open);
		expect(hidden.size).toBe(0);
	});
});
