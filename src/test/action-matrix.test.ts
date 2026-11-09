// Every game action (src/lib/server/actions.ts), asked by every member of the cast through the
// one route that runs them. The table is kept here, apart from the registry, on purpose: moving
// an action to another capability means changing both, and an action added without a line fails.
import { beforeAll, describe, expect, test } from 'bun:test';
import type { Env } from '$lib/server/env';
import type { Capability } from '$lib/capabilities';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { expected, outcomeOf } from './policy';
import { PRINCIPALS, seedWorld, type World } from './world';

const ACTION_CAPS: Record<string, Capability> = {
	capabilities: 'server.view',
	status: 'server.view',
	health: 'server.view',
	serverId: 'server.view',
	players: 'server.view',
	maps: 'server.view',
	lightings: 'server.view',
	experiences: 'server.view',
	alternators: 'server.view',
	catalog: 'server.view',
	rotation: 'server.view',
	bans: 'server.view',
	reserved: 'server.view',
	sponsor: 'server.view',

	broadcast: 'chat.send',
	whisper: 'chat.send',
	whisperMany: 'chat.send',
	kick: 'players.kick',
	kill: 'players.kill',
	changeTeam: 'players.move',
	endMatch: 'match.control',
	restartMatch: 'match.control',
	changeMap: 'match.control',
	setWeather: 'match.control',
	setNextMap: 'match.control',
	rotationAdd: 'rotation.edit',
	rotationRemove: 'rotation.edit',
	rotationMove: 'rotation.edit',
	rotationReorder: 'rotation.edit',

	ban: 'bans.manage',
	unban: 'bans.manage',
	reservedAdd: 'slots.manage',
	reservedRemove: 'slots.manage',
	rotationSave: 'rotation.save',
	rotationSettings: 'rotation.save',
	serverLog: 'audit.read',
	config: 'config.apply',
	feed: 'config.apply',
	settings: 'config.apply',
	configValidate: 'config.apply',
	configApply: 'config.apply',
	raw: 'rcon.raw'
};

const { ACTIONS } = await import('$lib/server/actions');

test('every action has a line in the table', () => {
	expect(Object.keys(ACTION_CAPS).sort()).toEqual(Object.keys(ACTIONS).sort());
});

describe.skipIf(!hasTestDb)('game action permission matrix', () => {
	let env: Env;
	let world: World;
	let gateway: ReturnType<typeof stubGateway>;

	beforeAll(async () => {
		env = await testEnv();
		world = await seedWorld(env);
	});

	for (const [action, cap] of Object.entries(ACTION_CAPS)) {
		test(`${action} needs ${cap}`, async () => {
			gateway = stubGateway();
			const { POST } = await import('../routes/api/servers/[id]/rcon/[action]/+server');
			const got: Record<string, unknown> = {};
			const want: Record<string, unknown> = {};
			const reached: string[] = [];
			for (const who of PRINCIPALS) {
				want[who] = expected(`cap:${cap}`, who);
				const before = gateway.runs.length;
				const answer = await callApi(POST, world.users[who], {
					method: 'POST',
					params: { id: world.server.id, action }
				});
				got[who] = outcomeOf(answer);
				if (gateway.runs.length > before) reached.push(who);
			}
			expect(got).toEqual(want);
			// A refusal must stop the request before the game hears of it.
			expect(reached).toEqual(PRINCIPALS.filter((who) => want[who] === 'ok'));
		});
	}

	test('a read may not be used to run a mutating action', async () => {
		stubGateway();
		const { GET } = await import('../routes/api/servers/[id]/rcon/[action]/+server');
		const answer = await callApi(GET, world.users.owner, {
			params: { id: world.server.id, action: 'kick' }
		});
		expect(answer.status).toBe(405);
	});

	test("the listener's log names its peers to the site owner only", async () => {
		stubGateway({ entries: [{ peer: '203.0.113.7:51022', event: 'AUTH_OK', detail: '-' }] });
		const { GET } = await import('../routes/api/servers/[id]/rcon/[action]/+server');
		const peers = async (who: 'site' | 'owner' | 'admin') => {
			const answer = await callApi(GET, world.users[who], {
				params: { id: world.server.id, action: 'serverLog' }
			});
			return JSON.stringify(answer.body);
		};
		expect(await peers('site')).toContain('203.0.113.7');
		for (const who of ['owner', 'admin'] as const) {
			expect(await peers(who)).toContain('AUTH_OK');
			expect(await peers(who)).not.toContain('203.0.113.7');
		}
	});
});
