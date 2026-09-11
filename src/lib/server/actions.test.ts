import { test, expect, mock } from 'bun:test';

// actions.ts reaches env.ts, which imports SvelteKit's env alias; outside the app that alias does
// not resolve, so it is stubbed before the registry is loaded.
mock.module('$env/dynamic/private', () => ({ env: process.env }));
const { ACTIONS } = await import('./actions');
const { GameError } = await import('./rcon');

// The official console moves the faction and then kills the player so they respawn on the new
// side; a kill that fails (no living character) is not an error.
function fakeClient(killFails: boolean) {
	const calls: string[] = [];
	const client: any = {
		json: async (method: string, path: string) => {
			calls.push(`${method} ${path}`);
			if (path.endsWith('/kill') && killFails)
				throw new GameError(404, 'No living character.', 'not_alive');
			return { message: 'Moved X to Valkyra.' };
		}
	};
	return { client, calls };
}

test('changeTeam moves the faction then kills the player', async () => {
	const { client, calls } = fakeClient(false);
	const r: any = await ACTIONS.changeTeam.run(client, {
		steamId: '76561198000000001',
		faction: 'Valkyra'
	});
	expect(calls).toEqual([
		'PATCH /v1/players/76561198000000001',
		'POST /v1/players/76561198000000001/kill'
	]);
	expect(r.respawned).toBe(true);
	expect(r.message).toContain('respawn');
});

test('changeTeam tolerates a failed kill', async () => {
	const { client, calls } = fakeClient(true);
	const r: any = await ACTIONS.changeTeam.run(client, {
		steamId: '76561198000000001',
		faction: 'Valkyra'
	});
	expect(calls.length).toBe(2);
	expect(r.respawned).toBe(false);
	expect(r.message).toContain('No living character');
});

test('changeTeam requires a faction', async () => {
	const { client, calls } = fakeClient(false);
	await expect(
		ACTIONS.changeTeam.run(client, { steamId: '76561198000000001', faction: '' })
	).rejects.toThrow('faction is required');
	expect(calls.length).toBe(0);
});
