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

// The route list live build ++Wardogs+Live-CL-499480 advertised on 2026-09-11: no reserved-slot or
// rotation write routes, no PATCH /v1/settings, no PUT /v1/sponsor, but a config document.
const LIVE_ROUTES = [
	'DELETE /v1/bans/{steamId}',
	'GET /v1/audit',
	'GET /v1/bans',
	'GET /v1/capabilities',
	'GET /v1/catalog/experiences',
	'GET /v1/catalog/lightings',
	'GET /v1/catalog/maps',
	'GET /v1/catalog/maps/{map}/alternators',
	'GET /v1/catalog/maps/{map}/experiences',
	'GET /v1/config',
	'GET /v1/health',
	'GET /v1/players',
	'GET /v1/reserved-slots',
	'GET /v1/rotation',
	'GET /v1/sponsor',
	'GET /v1/status',
	'PATCH /v1/players/{id}',
	'POST /v1/bans',
	'POST /v1/broadcast',
	'POST /v1/config/validate',
	'POST /v1/match/end',
	'POST /v1/match/map',
	'POST /v1/match/restart',
	'POST /v1/players/{id}/kick',
	'POST /v1/players/{id}/kill',
	'POST /v1/players/{id}/message',
	'PUT /v1/config',
	'PUT /v1/world/lighting'
];

test('capabilities reads the live build CL-499480 route list into feature flags', async () => {
	const client: any = {
		json: async () => ({ routes: LIVE_ROUTES, config: { writable: true, document: '/v1/config' } })
	};
	const r: any = await ACTIONS.capabilities.run(client, {});
	expect(r.features).toEqual({
		changeTeam: true,
		configDocument: true,
		reservedSlots: false,
		rotationEdit: false,
		rotationSave: false,
		liveSettings: false
	});
});

test('capabilities keeps every flag on for a build that serves the full console route set', async () => {
	const full = [
		...LIVE_ROUTES,
		'POST /v1/reserved-slots',
		'DELETE /v1/reserved-slots/{steamId}',
		'POST /v1/rotation/entries',
		'DELETE /v1/rotation/entries/{index}',
		'POST /v1/rotation/entries/{index}/move',
		'POST /v1/rotation/save',
		'PATCH /v1/settings'
	];
	const client: any = { json: async () => ({ routes: full, config: { writable: true } }) };
	const r: any = await ACTIONS.capabilities.run(client, {});
	expect(Object.values(r.features).every(Boolean)).toBe(true);
});
