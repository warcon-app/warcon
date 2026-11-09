// The reserved-slot sync on a build that takes slots through its config document and reads it at
// start (MOCK_LIVE_BUILD): it plans against the document, so a slot switched off and on again
// before a restart is not lost; it owns what it adds before it writes; and every change for a
// server goes in one write that fits the listener's body limit.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { getOrg, getServer } from '$lib/server/access';
import { readConfig } from '$lib/server/actions';
import { encryptSecret } from '$lib/server/crypto';
import { listEntries, serverListState, servers } from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import {
	ensureServerLists,
	importCandidates,
	listOf,
	serverListOf,
	serverListsState,
	standings
} from '$lib/server/lists';
import { liveObserved, reconcileServer, writeSnapshot } from '$lib/server/lists-sync';
import { restartMock } from '$lib/server/mockgame';
import { GameError, WardogsClient } from '$lib/server/rcon';
import { reservedFromText, reservedIntoText } from '$lib/reserved-doc';
import type { ListRow } from '$lib/server/db/schema';
import { hasTestDb, testEnv } from './db';
import { stubGateway } from './call';
import { seedWorld, type World } from './world';

const A = '76561198000000601';
const B = '76561198000000602';
const C = '76561198000000603';
const BUDGET = 65_536 - 2048;

interface Hooks {
	/** runs before each PUT of the document reaches the game */
	beforePut?: () => Promise<void>;
	/** answers a PUT in the game's place */
	answer?: () => { status: number; body: unknown; etag: string };
	/** the PUT reaches the game, then its answer is lost */
	loseAnswer?: boolean;
}

describe.skipIf(!hasTestDb)('reserved slots through the config document', () => {
	let env: Env;
	const before = { build: process.env.MOCK_LIVE_BUILD, adds: process.env.MOCK_LIVE_ADDS };

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		process.env.MOCK_LIVE_BUILD = 'true';
	});
	afterAll(() => {
		for (const [k, v] of [
			['MOCK_LIVE_BUILD', before.build],
			['MOCK_LIVE_ADDS', before.adds]
		] as const)
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
	});

	/** A fresh org with a server on the mock game, and a client to it that counts its writes. */
	async function setup(hooks: Hooks = {}) {
		const w: World = await seedWorld(env);
		const id = `s_doc_${newId().slice(0, 10)}`;
		await env.db.insert(servers).values({
			id,
			orgId: w.org.id,
			name: 'Doc',
			host: 'demo',
			port: 1,
			passwordEnc: encryptSecret(env, 'demo')
		});
		const orgList = await listOf(env, w.org.id, 'reserve');
		await ensureServerLists(env.db, id, w.org.id);
		const own = await serverListOf(env, { id, orgId: w.org.id }, 'reserve');
		const server = (await getServer(env, id))!;
		const client = await WardogsClient.forServer(env, server);
		const puts = { n: 0 };
		const put = client.configCall.bind(client);
		client.configCall = async (method, path, text, revision) => {
			if (method === 'PUT') {
				puts.n++;
				await hooks.beforePut?.();
				if (hooks.answer) return hooks.answer();
				const r = await put(method, path, text, revision);
				if (hooks.loseAnswer) throw new GameError(502, 'lost', 'unreachable');
				return r;
			}
			return put(method, path, text, revision);
		};
		const sync = async () =>
			reconcileServer(env, (await getServer(env, id))!, (await getOrg(env, w.org.id))!, {
				reason: 'api',
				waitMs: 0,
				lane: 'held',
				client
			});
		const doc = async () => reservedFromText((await readConfig(client)).text);
		const running = async () =>
			((await client.json('GET', '/v1/reserved-slots')) as { reservedSlots: string[] })
				.reservedSlots;
		const give = (steamId: string, list: ListRow = orgList) =>
			env.db
				.insert(listEntries)
				.values({ id: newId(), listId: list.id, steamId, addedByName: 'owner' });
		const withdraw = (steamId: string, list: ListRow = orgList) =>
			env.db
				.update(listEntries)
				.set({ removedAt: new Date(), removedByName: 'owner', removal: 'manual' })
				.where(
					and(
						eq(listEntries.listId, list.id),
						eq(listEntries.steamId, steamId),
						isNull(listEntries.removedAt)
					)
				);
		const stateOf = async (steamId: string) =>
			(
				await env.db
					.select({ state: serverListState.state, error: serverListState.error })
					.from(serverListState)
					.where(and(eq(serverListState.serverId, id), eq(serverListState.steamId, steamId)))
			)[0] ?? null;
		const standingOf = async (steamId: string) =>
			(await standings(env, 'reserve', [id], [steamId])).get(id)?.get(steamId)?.state ?? 'pending';
		return {
			w,
			id,
			server,
			client,
			orgList,
			own,
			puts,
			sync,
			doc,
			running,
			give,
			withdraw,
			stateOf,
			standingOf,
			restart: () => restartMock(id)
		};
	}

	test('a slot given and withdrawn before a restart leaves the document as it was', async () => {
		delete process.env.MOCK_LIVE_ADDS;
		const t = await setup();
		await t.give(A);
		await t.sync();
		expect(await t.doc()).toContain(A);
		expect(await t.running()).not.toContain(A);
		expect(await t.standingOf(A)).toBe('applied');

		await t.withdraw(A);
		await t.sync();
		expect(await t.doc()).not.toContain(A);
		expect(await t.stateOf(A)).toBeNull();
		t.restart();
		expect(await t.running()).not.toContain(A);
	});

	test('a slot withdrawn and given back before a restart stays', async () => {
		delete process.env.MOCK_LIVE_ADDS;
		const t = await setup();
		await t.give(A);
		await t.sync();
		t.restart();
		expect(await t.running()).toContain(A);

		await t.withdraw(A);
		await t.sync();
		expect(await t.doc()).not.toContain(A);
		expect(await t.running()).toContain(A);

		await t.give(A);
		await t.sync();
		expect(await t.doc()).toContain(A);
		expect(await t.stateOf(A)).toMatchObject({ state: 'applied' });
		t.restart();
		expect(await t.running()).toContain(A);
	});

	test('a write whose answer was lost is still the panel’s, and the panel can take it back', async () => {
		process.env.MOCK_LIVE_ADDS = 'now';
		const hooks: Hooks = { loseAnswer: true };
		const t = await setup(hooks);
		await t.give(A);
		const lost = await t.sync();
		expect(lost.error).toBe('Could not reach the server.');
		expect(await t.doc()).toContain(A);
		expect(await t.running()).toContain(A);

		hooks.loseAnswer = false;
		await t.sync();
		expect(await t.standingOf(A)).toBe('applied');
		expect(await t.stateOf(A)).toMatchObject({ state: 'applied' });

		await t.withdraw(A);
		await t.sync();
		expect(await t.doc()).not.toContain(A);
	});

	test('an id put in the document outside the panel is never removed', async () => {
		delete process.env.MOCK_LIVE_ADDS;
		const t = await setup();
		const d = await readConfig(t.client);
		await t.client.configCall(
			'PUT',
			'/v1/config',
			reservedIntoText(d.text, [...reservedFromText(d.text), B]),
			d.revision
		);
		await t.give(A);
		await t.sync();
		await t.withdraw(A);
		await t.sync();
		expect(await t.doc()).toContain(B);
		expect(await t.standingOf(B)).toBe('local');
	});

	test('a slot the panel withdrew that the server still runs is neither local nor offered for import', async () => {
		delete process.env.MOCK_LIVE_ADDS;
		const t = await setup();
		await t.give(A);
		await t.sync();
		t.restart();
		await t.withdraw(A);
		await t.sync();
		expect(await t.running()).toContain(A);
		expect(await t.doc()).not.toContain(A);
		// the worker's next look at the server's lists
		await writeSnapshot(env, t.id, await liveObserved(t.client));

		const org = (await getOrg(env, t.w.org.id))!;
		expect((await importCandidates(env, org)).map((c) => c.steamId)).not.toContain(A);
		const owner = t.w.users.owner!;
		const view = await serverListsState(env, t.server, owner, {
			caps: new Set(['server.view'])
		} as never);
		expect(view.reserved[A]?.state).not.toBe('local');
	});

	test('thirty slots given at once are one write', async () => {
		delete process.env.MOCK_LIVE_ADDS;
		const t = await setup();
		const ids = Array.from(
			{ length: 30 },
			(_, i) => `765611980000007${String(i).padStart(2, '0')}`
		);
		for (const id of ids) await t.give(id);
		const r = await t.sync();
		expect(r.added).toBe(30);
		expect(t.puts.n).toBe(1);
		const doc = await t.doc();
		for (const id of ids) expect(doc).toContain(id);
	});

	test('a conflict during the write keeps the other writer’s edit', async () => {
		delete process.env.MOCK_LIVE_ADDS;
		const hooks: Hooks = {};
		const t = await setup(hooks);
		let edited = false;
		hooks.beforePut = async () => {
			if (edited) return;
			edited = true;
			// someone else saves the document between the panel's read and its write
			const other = await WardogsClient.forServer(env, t.server);
			const d = await readConfig(other);
			await other.configCall(
				'PUT',
				'/v1/config',
				reservedIntoText(d.text, [...reservedFromText(d.text), C]),
				d.revision
			);
		};
		await t.give(A);
		await t.sync();
		const doc = await t.doc();
		expect(doc).toContain(A);
		expect(doc).toContain(C);
		expect(await t.stateOf(A)).toMatchObject({ state: 'applied' });
	});

	test('a full document holds adds back, the org list’s before the server’s own, and lets removals through', async () => {
		delete process.env.MOCK_LIVE_ADDS;
		const t = await setup();
		await t.give(A);
		await t.sync();
		// fill the document to 20 bytes under the budget: room for the line A leaves and no more
		const d = await readConfig(t.client);
		const pad = BUDGET - 20 - Buffer.byteLength(d.text, 'utf8') - 4;
		await t.client.configCall(
			'PUT',
			'/v1/config',
			`${d.text.replace(/\n?$/, '\n')}; ${'x'.repeat(pad)}\n`,
			d.revision
		);
		await t.withdraw(A);
		await t.give(B);
		await t.give(C, t.own);
		const r = await t.sync();
		expect(r.removed).toBe(1);
		const doc = await t.doc();
		expect(doc).not.toContain(A);
		expect(doc).toContain(C);
		expect(doc).not.toContain(B);
		expect(await t.stateOf(B)).toEqual({
			state: 'failed',
			error: "Could not add: The server's config document is full."
		});
	});

	test("a refused write keeps a fixed phrase, never the game's words", async () => {
		delete process.env.MOCK_LIVE_ADDS;
		const t = await setup({
			answer: () => ({
				status: 400,
				body: {
					ok: false,
					error: { code: 'invalid', message: 'line 9: RCONPassword=hunter2 is not valid' }
				},
				etag: ''
			})
		});
		await t.give(A);
		const r = await t.sync();
		expect(r.failed).toBe(1);
		expect(await t.stateOf(A)).toEqual({
			state: 'failed',
			error: 'Could not add: Refused by the server (400, invalid).'
		});
	});
});
