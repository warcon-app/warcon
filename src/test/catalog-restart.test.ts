// The server layout's catalog (the maps, game modes and lightings a server lists, and the routes
// its build serves): read from the game once an hour, and again at the first page after the game
// has restarted, which is when a server takes new allow lists (Sabatulo, once its host has been
// given it). A read that fails then leaves the pages on the lists read before it. The read comes
// after the layout's own access check: whoever may not open the server causes no request to the
// game.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import { forgetCatalog } from '$lib/server/catalog-cache';
import { gateway, setGateway } from '$lib/server/gateway';
import { GameError } from '$lib/server/rcon';
import type { Catalog, LiveView } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callLoad, stubGateway } from './call';
import { expected, outcomeOf } from './policy';
import { PRINCIPALS, seedWorld, type World } from './world';

const LAYOUT = join(import.meta.dir, '../routes/(app)/server/[id]/+layout.server.ts');
const SESSIONS = PRINCIPALS.filter((who) => !who.startsWith('key'));
const MIN = 60_000;

const list = (...ids: string[]) => ids.map((id) => ({ id, display: id }));
const SEASON_2: Catalog = {
	maps: list('Kavkazi', 'Europe', 'NorthAmerica'),
	lightings: list('DayClear', 'DayLateRain'),
	experiences: list('Bakurani_KOTH_01', 'KOTH_InfantryOnly')
};
const SEASON_3: Catalog = {
	maps: list('Kavkazi', 'Europe', 'NorthAmerica', 'Russia'),
	lightings: SEASON_2.lightings,
	experiences: [...SEASON_2.experiences, ...list('Moscow_KOTH_01', 'KOTH_LimitedGear')]
};

describe.skipIf(!hasTestDb)('server layout catalog', () => {
	let env: Env;
	let world: World;
	/** what the game lists now, and when the worker says it started */
	let listed = SEASON_2;
	let startedAt: number | null = Date.now() - 6 * 60 * MIN;
	const reads: string[] = [];
	/** how often the worker was asked for its last look */
	let looks = 0;
	/** the game is down: its catalog cannot be read */
	let down = false;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		setGateway({
			...gateway(),
			run: async (_env, server, action) => {
				reads.push(`${server.id} ${action}`);
				if (down) throw new GameError(502, 'The server did not answer.', 'unreachable');
				return action === 'catalog' ? structuredClone(listed) : { features: {} };
			},
			live: async (_env, ids) => {
				looks++;
				return new Map(
					ids.map((id) => [
						id,
						{
							serverId: id,
							ok: true,
							startedAt: startedAt ? new Date(startedAt).toISOString() : null
						} as LiveView
					])
				);
			}
		});
		world = await seedWorld(env);
		forgetCatalog(world.server.id);
	});

	const open = async (who: (typeof SESSIONS)[number] = 'owner') => {
		const { load } = await import(LAYOUT);
		return callLoad(load, world.users[who], { params: { id: world.server.id } });
	};
	const maps = (answer: { body: unknown }) =>
		(answer.body as { catalog: Catalog }).catalog.maps.map((m) => m.id);
	const catalogReads = () => reads.filter((r) => r === `${world.server.id} catalog`).length;

	test('nobody who may not open the server causes a read of the game or of the worker', async () => {
		let refused = 0;
		for (const who of SESSIONS) {
			if (expected('cap:server.view', who) === 'ok') continue;
			const answer = await open(who);
			expect([who, outcomeOf(answer)]).toEqual([who, expected('cap:server.view', who)]);
			refused++;
		}
		expect(refused).toBeGreaterThan(2);
		expect(reads).toEqual([]);
		expect(looks).toBe(0);
	});

	test('read once, then kept while the game runs on', async () => {
		expect(maps(await open())).toEqual(['Kavkazi', 'Europe', 'NorthAmerica']);
		expect(catalogReads()).toBe(1);
		// the host is given Sabatulo, but the game has not restarted: it lists what it started with
		for (const who of ['viewer', 'operator', 'owner'] as const)
			expect(maps(await open(who))).toEqual(['Kavkazi', 'Europe', 'NorthAmerica']);
		// the same start, worked out a few seconds off at another look
		startedAt! += 4_000;
		await open();
		expect(catalogReads()).toBe(1);
	});

	test('read again at the first page after the game restarts, and kept again', async () => {
		listed = SEASON_3;
		startedAt = Date.now() - 2 * MIN;
		expect(maps(await open('viewer'))).toEqual(['Kavkazi', 'Europe', 'NorthAmerica', 'Russia']);
		expect(catalogReads()).toBe(2);
		expect(maps(await open())).toEqual(['Kavkazi', 'Europe', 'NorthAmerica', 'Russia']);
		expect(catalogReads()).toBe(2);
	});

	test('a read that fails after a restart leaves the pages on the lists in hand', async () => {
		// the game restarts once more and is down again before its lists can be read
		startedAt = Date.now() - MIN / 2;
		down = true;
		try {
			const answer = await open('viewer');
			expect(maps(answer)).toEqual(['Kavkazi', 'Europe', 'NorthAmerica', 'Russia']);
			expect((answer.body as { reachable: boolean; problem: string }).reachable).toBe(true);
			expect((answer.body as { problem: string }).problem).toBe('');
			expect(catalogReads()).toBe(3);
			// the pages opened in the next half minute do not ask the game again
			for (const who of ['owner', 'operator', 'viewer'] as const)
				expect(maps(await open(who))).toEqual(['Kavkazi', 'Europe', 'NorthAmerica', 'Russia']);
			expect(catalogReads()).toBe(3);
		} finally {
			down = false;
		}
		// with nothing in hand (a server never read), the page says it cannot be reached, as before
		forgetCatalog(world.server.id);
		down = true;
		try {
			const answer = await open();
			const body = answer.body as { reachable: boolean; problem: string; catalog: Catalog };
			expect(body.reachable).toBe(false);
			expect(body.catalog.maps).toEqual([]);
			expect(body.problem).toBe('The server did not answer.');
		} finally {
			down = false;
		}
		expect(maps(await open())).toEqual(['Kavkazi', 'Europe', 'NorthAmerica', 'Russia']);
		const before = catalogReads();
		await open();
		expect(catalogReads()).toBe(before);
	});

	test('a worker that does not know the start changes nothing', async () => {
		const before = catalogReads();
		startedAt = null;
		expect(maps(await open())).toEqual(['Kavkazi', 'Europe', 'NorthAmerica', 'Russia']);
		expect(catalogReads()).toBe(before);
	});
});
