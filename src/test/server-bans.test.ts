// A server's own ban list: what someone with Bans on one server, and nothing on the org's lists,
// can do with it, and what it shows to whom.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { SessionUser } from '$lib/server/access';
import { listEntries, orgMembers, orgRoles, serverGrants, user } from '$lib/server/db/schema';
import { entriesView, listOf, serverListOf } from '$lib/server/lists';
import { desiredFor } from '$lib/server/lists-sync';
import { getOrg } from '$lib/server/access';
import { newId } from '$lib/server/http';
import { gateway, setGateway } from '$lib/server/gateway';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway, type CallInput } from './call';
import { seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
const PLAYER = '76561198000000077';
const ORG_BANNED = '76561198000000078';

describe.skipIf(!hasTestDb)("a server's own bans", () => {
	let env: Env;
	let w: World;
	let moderator: SessionUser;

	const call = async (
		who: SessionUser | null,
		method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
		path: string,
		input: CallInput = {}
	) => {
		const mod = await import(join(ROUTES, path, '+server.ts'));
		return callApi(mod[method], who, {
			method,
			...input,
			params: { id: w.server.id, steamId: PLAYER, ...input.params }
		});
	};
	const ownEntry = async (serverId = w.server.id) => {
		const list = await serverListOf(env, { id: serverId, orgId: w.org.id }, 'ban');
		const [row] = await env.db
			.select()
			.from(listEntries)
			.where(
				and(
					eq(listEntries.listId, list.id),
					eq(listEntries.steamId, PLAYER),
					isNull(listEntries.removedAt)
				)
			);
		return row ?? null;
	};

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		stubGateway();
		// Bans on one server and neither org list: the moderator the org's lists are closed to.
		const id = `u_mod_${newId().slice(0, 8)}`;
		await env.db.insert(user).values({
			id,
			name: id,
			email: `${id}@test.invalid`,
			username: id,
			displayUsername: id,
			role: 'member',
			authComplete: true
		});
		const roleId = newId();
		await env.db.insert(orgRoles).values({
			id: roleId,
			orgId: w.org.id,
			name: 'Moderator',
			capabilities: ['server.view', 'players.kick', 'bans.manage']
		});
		await env.db.insert(orgMembers).values({ orgId: w.org.id, userId: id, role: 'member' });
		await env.db.insert(serverGrants).values({ serverId: w.server.id, userId: id, roleId });
		moderator = { ...w.users.viewer!, id, username: id, name: id };

		const orgBans = await listOf(env, w.org.id, 'ban');
		await env.db.insert(listEntries).values({
			id: newId(),
			listId: orgBans.id,
			steamId: ORG_BANNED,
			reason: 'org reason',
			addedByName: 'owner'
		});
	});

	test('a ban is kept on the list of that server alone, under the name of who placed it', async () => {
		const answer = await call(moderator, 'POST', 'servers/[id]/lists/ban/entries', {
			body: { steamId: PLAYER, reason: 'aimbot', expiresAt: '' }
		});
		expect(answer.status).toBe(201);
		expect(await ownEntry()).toMatchObject({ reason: 'aimbot', addedByName: moderator.username });

		const org = (await getOrg(env, w.org.id))!;
		const here = await desiredFor(env, { id: w.server.id, orgId: w.org.id }, org);
		const there = await desiredFor(env, { id: w.otherServer.id, orgId: w.org.id }, org);
		expect(here.bans.map((b) => b.steamId)).toContain(PLAYER);
		expect(there.bans.map((b) => b.steamId)).not.toContain(PLAYER);
		expect((await entriesView(env, org, 'ban')).map((e) => e.steamId)).not.toContain(PLAYER);

		const again = await call(moderator, 'POST', 'servers/[id]/lists/ban/entries', {
			body: { steamId: PLAYER }
		});
		expect(again).toMatchObject({ status: 409, code: 'duplicate' });
	});

	test('Bans on one server reaches neither another server, another org, nor the org list', async () => {
		for (const id of [w.otherServer.id, w.otherOrgServer.id]) {
			const post = await call(moderator, 'POST', 'servers/[id]/lists/ban/entries', {
				params: { id },
				body: { steamId: PLAYER }
			});
			expect({ id, status: post.status }).toEqual({ id, status: 404 });
		}
		const orgPatch = await call(moderator, 'PATCH', 'orgs/[id]/lists/[kind]/entries/[steamId]', {
			params: { id: w.org.id, kind: 'ban', steamId: ORG_BANNED },
			body: { reason: 'mine now' }
		});
		// the org's lists answer someone without a lists role as if they were not there
		expect(orgPatch.status).toBe(404);
		const orgBans = await listOf(env, w.org.id, 'ban');
		const [kept] = await env.db
			.select({ reason: listEntries.reason })
			.from(listEntries)
			.where(and(eq(listEntries.listId, orgBans.id), eq(listEntries.steamId, ORG_BANNED)));
		expect(kept.reason).toBe('org reason');
		// nor can the server's route reach an entry that is on the org's list
		for (const method of ['PATCH', 'DELETE'] as const) {
			const answer = await call(moderator, method, 'servers/[id]/lists/ban/entries/[steamId]', {
				params: { steamId: ORG_BANNED },
				body: { reason: 'mine now' }
			});
			expect({ method, status: answer.status }).toEqual({ method, status: 404 });
		}
	});

	test('the reason and the expiry can be changed; the row keeps who added it and when', async () => {
		const before = (await ownEntry())!;
		const until = new Date(Date.now() + 86400_000).toISOString();
		const answer = await call(moderator, 'PATCH', 'servers/[id]/lists/ban/entries/[steamId]', {
			body: { reason: 'aimbot, appeal pending', expiresAt: until }
		});
		expect(answer.status).toBe(200);
		const after = (await ownEntry())!;
		expect(after).toMatchObject({
			id: before.id,
			reason: 'aimbot, appeal pending',
			addedByName: before.addedByName,
			addedAt: before.addedAt
		});
		expect(after.expiresAt?.toISOString()).toBe(until);

		for (const body of [{}, { expiresAt: '2001-01-01T00:00:00Z' }, { expiresAt: 'soon' }]) {
			const bad = await call(moderator, 'PATCH', 'servers/[id]/lists/ban/entries/[steamId]', {
				body
			});
			expect({ body, status: bad.status }).toEqual({ body, status: 400 });
		}
		const viewer = await call(w.users.viewer, 'PATCH', 'servers/[id]/lists/ban/entries/[steamId]', {
			body: { reason: 'x' }
		});
		expect(viewer.status).toBe(403);
	});

	test('who is banned, why and until when is View; who placed it needs Bans or Org ban list', async () => {
		const state = async (who: SessionUser | null) =>
			(
				(await call(who, 'GET', 'servers/[id]/lists/state')).body as {
					bans: Record<string, Record<string, unknown>>;
				}
			).bans;
		const viewer = await state(w.users.viewer);
		expect(viewer[PLAYER]).toMatchObject({
			scope: 'server',
			managed: true,
			reason: 'aimbot, appeal pending',
			addedByName: ''
		});
		expect(viewer[PLAYER].expiresAt).not.toBeNull();
		expect(viewer[ORG_BANNED]).toMatchObject({
			scope: 'org',
			reason: 'org reason',
			addedByName: ''
		});
		expect(JSON.stringify(viewer)).not.toContain(moderator.username);

		const mod = await state(moderator);
		expect(mod[PLAYER]).toMatchObject({
			scope: 'server',
			reason: 'aimbot, appeal pending',
			addedByName: moderator.username
		});
		expect(mod[ORG_BANNED]).toMatchObject({
			scope: 'org',
			reason: 'org reason',
			addedByName: 'owner'
		});

		// the org's ban list opens who placed a ban; its reserved-slot list does not
		expect((await state(w.users.orgBans))[ORG_BANNED]).toMatchObject({ addedByName: 'owner' });
		const slots = await state(w.users.orgSlots);
		expect(slots[ORG_BANNED]).toMatchObject({
			scope: 'org',
			reason: 'org reason',
			addedByName: ''
		});
		expect(JSON.stringify(slots)).not.toContain(moderator.username);
	});

	test('an answer says where the sync landed and nothing of what the worker holds', async () => {
		const spoken = { serverId: w.server.id, serverName: 'one', ok: true, added: 0, removed: 0 };
		setGateway({
			...gateway(),
			syncServer: async () => ({
				...spoken,
				failed: 1,
				pending: false,
				error: '',
				observed: { bans: [ORG_BANNED], reserved: [], configured: ['76561198000000081'] },
				refusedBans: [{ steamId: ORG_BANNED, reason: 'org reason', listId: 'x' }]
			})
		});
		const answers = [
			await call(w.users.admin, 'POST', 'servers/[id]/lists/reserve/entries', {
				body: { steamId: '76561198000000079' }
			}),
			await call(w.users.admin, 'POST', 'servers/[id]/lists/sync'),
			await call(moderator, 'PATCH', 'servers/[id]/lists/ban/entries/[steamId]', {
				body: { reason: 'aimbot, appeal pending' }
			}),
			await call(moderator, 'POST', 'servers/[id]/lists/ban/entries', {
				body: { steamId: '76561198000000080' }
			})
		];
		for (const a of answers) {
			expect(a.status).toBeLessThan(300);
			expect(JSON.stringify(a.body)).not.toContain('org reason');
			expect(JSON.stringify(a.body)).not.toContain('observed');
			expect(JSON.stringify(a.body)).not.toContain('76561198000000081');
		}
		stubGateway();
	});

	test('lifting it withdraws the entry; a second time there is nothing to lift', async () => {
		const viewer = await call(w.users.viewer, 'DELETE', 'servers/[id]/lists/ban/entries/[steamId]');
		expect(viewer.status).toBe(403);
		const answer = await call(moderator, 'DELETE', 'servers/[id]/lists/ban/entries/[steamId]');
		expect(answer.status).toBe(200);
		expect(await ownEntry()).toBeNull();
		const again = await call(moderator, 'DELETE', 'servers/[id]/lists/ban/entries/[steamId]');
		expect(again.status).toBe(404);
	});
});
