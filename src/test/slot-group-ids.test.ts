// Every route under a group id finds the group with the org it was checked against: another org's
// group, the org's default list, a server's own list, a ban list or an archived group is "Group not
// found." to every one of them, and nothing is written.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { auditLog, listEntries, lists, serverLists } from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import { listOf, serverListOf } from '$lib/server/lists';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api', 'orgs', '[id]', 'slot-groups');
const PLAYER = '76561198000000801';

/** Each route under [groupId], with a body that would change something were the group found. */
const CALLS: { path: string; method: string; body: Record<string, unknown> }[] = [
	{ path: '[groupId]', method: 'PATCH', body: { name: 'Taken over', servers: 'every' } },
	{ path: '[groupId]', method: 'DELETE', body: {} },
	{ path: '[groupId]/switch', method: 'PUT', body: { on: true } },
	{ path: '[groupId]/entries', method: 'GET', body: {} },
	{ path: '[groupId]/entries', method: 'POST', body: { steamId: PLAYER } },
	{ path: '[groupId]/entries/[steamId]', method: 'PATCH', body: { reason: 'changed' } },
	{ path: '[groupId]/entries/[steamId]', method: 'DELETE', body: {} }
];

describe.skipIf(!hasTestDb)('a group id', () => {
	let env: Env;
	let w: World;
	const targets: Record<string, string> = {};

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		const group = async (orgId: string, name: string, archived = false) => {
			const id = newId();
			await env.db.insert(lists).values({
				id,
				orgId,
				kind: 'reserve',
				name,
				onUntil: new Date(),
				archivedAt: archived ? new Date() : null
			});
			await env.db.insert(listEntries).values({
				id: newId(),
				listId: id,
				steamId: PLAYER,
				reason: 'kept',
				addedByName: 'owner'
			});
			return id;
		};
		await listOf(env, w.org.id, 'reserve');
		await listOf(env, w.otherOrg.id, 'reserve');
		targets["another org's group"] = await group(w.otherOrg.id, 'Theirs');
		targets['an archived group'] = await group(w.org.id, 'Old', true);
		targets['the default list'] = (await listOf(env, w.org.id, 'reserve')).id;
		targets['the ban list'] = (await listOf(env, w.org.id, 'ban')).id;
		targets["a server's own list"] = (
			await serverListOf(env, { id: w.server.id, orgId: w.org.id }, 'reserve')
		).id;
		for (const id of [targets['the default list'], targets["a server's own list"]])
			await env.db
				.insert(listEntries)
				.values({ id: newId(), listId: id, steamId: PLAYER, addedByName: 'owner' });
	});

	const snapshot = async () => ({
		lists: await env.db.select().from(lists),
		entries: await env.db.select().from(listEntries),
		given: await env.db.select().from(serverLists)
	});

	for (const call of CALLS)
		test(`${call.method} ${call.path} reaches no list but the org's own groups`, async () => {
			const mod = await import(join(ROUTES, call.path, '+server.ts'));
			const before = await snapshot();
			const audits = (await env.db.select({ id: auditLog.id }).from(auditLog)).length;
			for (const [what, groupId] of Object.entries(targets)) {
				const r = await callApi(mod[call.method], w.users.owner, {
					method: call.method,
					params: { id: w.org.id, groupId, steamId: PLAYER },
					body: call.body
				});
				expect({ what, status: r.status, message: r.message }).toEqual({
					what,
					status: 404,
					message: 'Group not found.'
				});
			}
			expect(await snapshot()).toEqual(before);
			expect((await env.db.select({ id: auditLog.id }).from(auditLog)).length).toBe(audits);
		});

	test('nor does a group of this org reached through another org', async () => {
		const mine = newId();
		await env.db
			.insert(lists)
			.values({ id: mine, orgId: w.org.id, kind: 'reserve', name: 'Mine', onUntil: new Date() });
		const mod = await import(join(ROUTES, '[groupId]', 'switch', '+server.ts'));
		const r = await callApi(mod.PUT, w.users.outsider, {
			method: 'PUT',
			params: { id: w.otherOrg.id, groupId: mine },
			body: { on: true }
		});
		expect([r.status, r.message]).toEqual([404, 'Group not found.']);
		const [row] = await env.db.select().from(lists).where(eq(lists.id, mine));
		expect(row.onFrom).toBeNull();
		expect(row.onUntil).not.toBeNull();
	});
});
