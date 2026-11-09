// What the list sync keeps of a failure is a fixed phrase for its kind: the game's own words never
// reach a slot's stored error, the server's last sync error, the audit trail or the state route
// every viewer of the server reads. A game whose ban list names a player twice is no failure.
import { beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { getOrg, getServer } from '$lib/server/access';
import {
	auditLog,
	listEntries,
	serverBans,
	serverListState,
	serverListSync
} from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import { listOf } from '$lib/server/lists';
import { reconcileServer } from '$lib/server/lists-sync';
import { GameError, type WardogsClient } from '$lib/server/rcon';
import type { Features } from '$lib/types';
import { GET as stateRoute } from '../routes/api/servers/[id]/lists/state/+server';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';

const PLAYER = '76561198000000501';
const BANNED = '76561198000000502';
/** what a game might put in its refusal: an address, a token, anything */
const GAME_TEXT = 'listener on 198.20.4.4 refused bearer tok_live_abc';

const FEATURES: Features = {
	changeTeam: true,
	configDocument: true,
	reservedSlots: true,
	rotationEdit: true,
	rotationSave: true,
	liveSettings: true,
	serverId: true
};

/** A game that lists nothing and refuses every change with its own text. */
function refusingGame(status: number, code: string): WardogsClient {
	const json = async (method: string, path: string) => {
		if (method === 'GET' && path === '/v1/bans') return { bans: [] };
		if (method === 'GET' && path === '/v1/reserved-slots') return { reservedSlots: [] };
		throw new GameError(status, GAME_TEXT, code);
	};
	return { serverId: 'fake', json } as unknown as WardogsClient;
}

/** A game whose ban list holds one player twice, and that takes every reserved slot it is given. */
function doubledBanGame(): WardogsClient {
	const json = async (method: string, path: string) => {
		if (method === 'GET' && path === '/v1/bans')
			return {
				bans: [
					{ steamId: BANNED, reason: 'first' },
					{ steamId: BANNED, reason: 'again' }
				]
			};
		if (method === 'GET' && path === '/v1/reserved-slots') return { reservedSlots: [] };
		if (method === 'POST' && path === '/v1/reserved-slots') return { ok: true };
		throw new GameError(404, GAME_TEXT, 'not_found');
	};
	return { serverId: 'fake', json } as unknown as WardogsClient;
}

describe.skipIf(!hasTestDb)('list sync errors', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		const list = await listOf(env, w.org.id, 'reserve');
		await env.db
			.insert(listEntries)
			.values({ id: newId(), listId: list.id, steamId: PLAYER, addedByName: 'owner' });
	});

	const sync = async (client: WardogsClient) => {
		const server = (await getServer(env, w.server.id))!;
		const org = (await getOrg(env, w.org.id))!;
		await env.db.delete(serverListState).where(eq(serverListState.serverId, server.id));
		return reconcileServer(env, server, org, {
			features: FEATURES,
			reason: 'poll',
			waitMs: 0,
			client,
			lane: 'held'
		});
	};

	const stored = async () => {
		const state = await env.db
			.select({ error: serverListState.error })
			.from(serverListState)
			.where(eq(serverListState.serverId, w.server.id));
		const [row] = await env.db
			.select({ lastError: serverListSync.lastError })
			.from(serverListSync)
			.where(eq(serverListSync.serverId, w.server.id));
		const audit = await env.db
			.select({ message: auditLog.message, detail: auditLog.detail })
			.from(auditLog)
			.where(eq(auditLog.serverId, w.server.id));
		return { state: state.map((s) => s.error), lastError: row?.lastError ?? '', audit };
	};

	test('a refused add is stored as a fixed phrase', async () => {
		const result = await sync(refusingGame(400, 'odd_refusal'));
		expect(result.failed).toBe(1);
		const s = await stored();
		expect(s.state).toEqual(['Could not add: Refused by the server (400, odd_refusal).']);
		expect(JSON.stringify(s)).not.toContain(GAME_TEXT);
	});

	test('a code that is not a plain word is left out of the phrase', async () => {
		await sync(refusingGame(400, 'Bad Thing: 198.20.4.4'));
		const s = await stored();
		expect(s.state).toEqual(['Could not add: Refused by the server (400).']);
		expect(JSON.stringify(s)).not.toContain('198.20.4.4');
	});

	test('a server that stops answering is stored as a fixed phrase, and so shown', async () => {
		const result = await sync(refusingGame(503, ''));
		expect(result.error).toBe('The server failed to answer.');
		const s = await stored();
		expect(s.lastError).toBe('The server failed to answer.');
		expect(JSON.stringify(s)).not.toContain(GAME_TEXT);
		const shown = await callApi(stateRoute, w.users.viewer, { params: { id: w.server.id } });
		expect(shown.status).toBe(200);
		expect(JSON.stringify(shown.body)).not.toContain(GAME_TEXT);
		expect((shown.body as { sync: { lastError: string } }).sync.lastError).toBe(
			'The server failed to answer.'
		);
	});

	test('a ban list holding one player twice is kept as one row and stops nothing', async () => {
		const result = await sync(doubledBanGame());
		expect(result.error).toBe('');
		expect(result.added).toBe(1);
		const rows = await env.db
			.select({ steamId: serverBans.steamId })
			.from(serverBans)
			.where(eq(serverBans.serverId, w.server.id));
		expect(rows).toEqual([{ steamId: BANNED }]);
		expect((await stored()).lastError).toBe('');
	});
});
