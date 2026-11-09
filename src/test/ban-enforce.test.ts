// The panel enforces its bans itself: the worker keeps each server's bans in memory between syncs
// and removes a banned player it finds on the server. Nothing is written to the game's own ban
// list, and the ban must still be in force when the player turns up.
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { auditLog, listEntries, organizations, servers } from '$lib/server/db/schema';
import {
	ensureOrgLists,
	ensureServerLists,
	grantEntry,
	listOf,
	serverListOf
} from '$lib/server/lists';
import { kickBanned, reconcileServer } from '$lib/server/lists-sync';
import type { PanelBan } from '$lib/server/lists-plan';
import { GameError, type WardogsClient } from '$lib/server/rcon';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const STEAM = '76561198000000042';

describe.skipIf(!hasTestDb)('bans enforced by the panel', () => {
	let env: Env;

	beforeAll(async () => {
		env = await testEnv();
	});

	/** A server whose org (or, with `own`, the server's own list) bans STEAM. */
	async function banned(expiresAt: Date | null = null, own = false) {
		const w = await seedWorld(env);
		await ensureOrgLists(env.db, w.org.id);
		await ensureServerLists(env.db, w.server.id, w.org.id);
		const list = own
			? await serverListOf(env, { id: w.server.id, orgId: w.org.id }, 'ban')
			: await listOf(env, w.org.id, 'ban');
		const entry = await grantEntry(env, list, {
			steamId: STEAM,
			reason: 'cheating',
			expiresAt,
			addedByName: 'test'
		});
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const bans = new Map<string, PanelBan>([[STEAM, { steamId: STEAM, listId: list.id }]]);
		const sent: string[] = [];
		const bodies: unknown[] = [];
		const client = {
			json: async (method: string, path: string, body?: unknown) => {
				sent.push(`${method} ${path}`);
				bodies.push(body);
				return {};
			}
		} as unknown as WardogsClient;
		return {
			server,
			org,
			bans,
			bansCopy: new Map(bans),
			bodies,
			otherServerId: w.otherServer.id,
			sent,
			client,
			entryId: entry.id
		};
	}

	test('a banned player seen on the server is kicked with the ban message, and it is audited', async () => {
		const t = await banned();
		await kickBanned(env, t.server, t.org, t.client, [STEAM, '76561198000000043'], t.bans);
		expect(t.sent).toEqual([`POST /v1/players/${STEAM}/kick`]);
		expect(t.bodies[0]).toEqual({ reason: 'cheating' });
		// still banned: the next join is kicked again
		expect(t.bans.size).toBe(1);
		const rows = await env.db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.serverId, t.server.id), eq(auditLog.action, 'ban.enforce')));
		expect(rows.map((r) => [r.target, r.outcome])).toEqual([[STEAM, 'ok']]);
	});

	test('the sync hands the worker the bans and writes nothing to the game', async () => {
		const t = await banned();
		const result = await reconcileServer(env, t.server, t.org, {
			reason: 'poll',
			waitMs: 0,
			lane: 'held',
			client: t.client,
			observed: { bans: [], reserved: [], configured: [] }
		});
		expect(t.sent).toEqual([]);
		expect(result.bans?.map((b) => b.steamId)).toEqual([STEAM]);
	});

	test("a ban on the server's own list is enforced there, and only there", async () => {
		const t = await banned(null, true);
		await kickBanned(env, t.server, t.org, t.client, [STEAM], t.bans);
		expect(t.sent).toEqual([`POST /v1/players/${STEAM}/kick`]);

		// the same ban handed to another server of the org is dropped: that list is not its own
		const [other] = await env.db.select().from(servers).where(eq(servers.id, t.otherServerId));
		const again = new Map(t.bansCopy);
		const sent: string[] = [];
		const client = {
			json: async (method: string, path: string) => (sent.push(`${method} ${path}`), {})
		} as unknown as WardogsClient;
		await kickBanned(env, other, t.org, client, [STEAM], again);
		expect(sent).toEqual([]);
		expect(again.size).toBe(0);
	});

	test('a ban taken off the list since the last sync kicks nobody', async () => {
		const t = await banned();
		await env.db
			.update(listEntries)
			.set({ removedAt: new Date(), removal: 'manual' })
			.where(eq(listEntries.id, t.entryId));
		await kickBanned(env, t.server, t.org, t.client, [STEAM], t.bans);
		expect(t.sent).toEqual([]);
		expect(t.bans.size).toBe(0);
	});

	test('a ban that ran out since the last sync kicks nobody', async () => {
		const t = await banned(new Date(Date.now() + 60_000));
		await env.db
			.update(listEntries)
			.set({ expiresAt: new Date(Date.now() - 1000) })
			.where(eq(listEntries.id, t.entryId));
		await kickBanned(env, t.server, t.org, t.client, [STEAM], t.bans);
		expect(t.sent).toEqual([]);
		expect(t.bans.size).toBe(0);
	});

	test('a kick the game refuses is not tried again at every look', async () => {
		const t = await banned();
		let calls = 0;
		const client = {
			json: async () => {
				calls++;
				throw new GameError(400, 'Bad request', 'bad_request');
			}
		} as unknown as WardogsClient;
		await kickBanned(env, t.server, t.org, client, [STEAM], t.bans);
		await kickBanned(env, t.server, t.org, client, [STEAM], t.bans);
		expect(calls).toBe(1);
	});
});
