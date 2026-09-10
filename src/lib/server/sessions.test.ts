import { describe, expect, test } from 'bun:test';
import { diffPresence, newPresence, type OpenSession } from './sessions';
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
	faction: null,
	kills: 0,
	deaths: 0,
	cash: 0,
	joinedAt: 1000,
	lastSeen: 2000,
	writtenAt: 2000
});

describe('diffPresence', () => {
	test('splits the observed list into joined, stayed and left', () => {
		const p = newPresence();
		for (const id of ['76561198100000001', '76561198100000002']) p.open.set(id, open(id));
		const d = diffPresence(p, [player('76561198100000002'), player('76561198100000003')]);
		expect(d.joined.map((x) => x.steamId)).toEqual(['76561198100000003']);
		expect(d.stayed.map((x) => x.session.steamId)).toEqual(['76561198100000002']);
		expect(d.left.map((x) => x.steamId)).toEqual(['76561198100000001']);
	});

	test('ignores duplicates and players without a SteamID', () => {
		const p = newPresence();
		const d = diffPresence(p, [
			player('76561198100000009'),
			player('76561198100000009'),
			player('')
		]);
		expect(d.joined).toHaveLength(1);
		expect(d.stayed).toHaveLength(0);
	});

	test('an empty list means everyone left', () => {
		const p = newPresence();
		p.open.set('76561198100000001', open('76561198100000001'));
		const d = diffPresence(p, []);
		expect(d.left).toHaveLength(1);
		expect(d.joined).toHaveLength(0);
	});
});
