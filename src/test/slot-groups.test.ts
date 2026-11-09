// Reserved-slot groups: an org's reserved-slot lists beside the default one, switched on and off
// or set to a window, on every server or chosen ones. What reaches a server, when, through the
// config document of a build that reads it at start (MOCK_LIVE_BUILD); that the default list keeps
// everything written to "the org's list"; and who sees a group at all.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { SessionUser } from '$lib/server/access';
import { getOrg, getServer } from '$lib/server/access';
import { readConfig } from '$lib/server/actions';
import { encryptSecret } from '$lib/server/crypto';
import {
	auditLog,
	listEntries,
	lists,
	organizations,
	serverLists,
	servers,
	type ListRow
} from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import { createServer } from '$lib/server/servers';
import {
	ensureServerLists,
	entriesView,
	grantEntry,
	importCandidates,
	listOf,
	orgListsView,
	serverListsState
} from '$lib/server/lists';
import { desiredFor, reconcileServer } from '$lib/server/lists-sync';
import { restartMock } from '$lib/server/mockgame';
import { archiveGroup, switchGroup, updateGroup } from '$lib/server/slot-groups';
import { WardogsClient } from '$lib/server/rcon';
import { reservedFromText } from '$lib/reserved-doc';
import { hasTestDb, testEnv } from './db';
import { callApi, callLoad, stubGateway, type CallInput } from './call';
import { seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
const A = '76561198000000701';
const B = '76561198000000702';
const C = '76561198000000703';
const HOUR = 3600_000;

describe.skipIf(!hasTestDb)('reserved-slot groups', () => {
	let env: Env;
	const before = process.env.MOCK_LIVE_BUILD;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		process.env.MOCK_LIVE_BUILD = 'true';
		delete process.env.MOCK_LIVE_ADDS;
	});
	afterAll(() => {
		if (before === undefined) delete process.env.MOCK_LIVE_BUILD;
		else process.env.MOCK_LIVE_BUILD = before;
	});

	const api = async (
		who: SessionUser | null,
		method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
		path: string,
		input: CallInput = {}
	) => {
		const mod = await import(join(ROUTES, 'api', path, '+server.ts'));
		return callApi(mod[method], who, { method, ...input });
	};

	/** A server of the org on the mock game, with a client to it. */
	async function demoServer(w: World, name = 'Doc') {
		const id = `s_grp_${newId().slice(0, 10)}`;
		await env.db.insert(servers).values({
			id,
			orgId: w.org.id,
			name,
			host: 'demo',
			port: 1,
			passwordEnc: encryptSecret(env, 'demo')
		});
		await ensureServerLists(env.db, id, w.org.id);
		const server = (await getServer(env, id))!;
		const client = await WardogsClient.forServer(env, server);
		return {
			id,
			client,
			sync: async () =>
				reconcileServer(env, (await getServer(env, id))!, (await getOrg(env, w.org.id))!, {
					reason: 'api',
					waitMs: 0,
					lane: 'held',
					client
				}),
			doc: async () => reservedFromText((await readConfig(client)).text),
			restart: () => restartMock(id)
		};
	}

	/** A fresh org whose default lists exist, and a group made through its route. */
	async function world() {
		const w = await seedWorld(env);
		await listOf(env, w.org.id, 'reserve');
		return w;
	}

	const make = async (w: World, body: Record<string, unknown>, who = w.users.owner) => {
		const r = await api(who, 'POST', 'orgs/[id]/slot-groups', {
			params: { id: w.org.id },
			body
		});
		expect(r.status).toBe(201);
		return (r.body as { group: { id: string } }).group.id;
	};
	const groupRow = async (id: string) =>
		(await env.db.select().from(lists).where(eq(lists.id, id)))[0] as ListRow;
	const switchIt = (
		w: World,
		groupId: string,
		body: Record<string, unknown>,
		who = w.users.owner
	) =>
		api(who, 'PUT', 'orgs/[id]/slot-groups/[groupId]/switch', {
			params: { id: w.org.id, groupId },
			body
		});
	const addTo = (w: World, groupId: string, steamId: string, who = w.users.owner) =>
		api(who, 'POST', 'orgs/[id]/slot-groups/[groupId]/entries', {
			params: { id: w.org.id, groupId },
			body: { steamId }
		});
	const wanted = async (w: World, serverId: string, now = new Date()) =>
		(
			await desiredFor(env, { id: serverId, orgId: w.org.id }, (await getOrg(env, w.org.id))!, now)
		).reserved.map((r) => r.steamId);

	test('a group named before "Default" captures nothing written to the org list', async () => {
		const w = await world();
		const groupId = await make(w, { name: 'Admins' });
		await switchIt(w, groupId, { on: true });
		const def = await listOf(env, w.org.id, 'reserve');
		expect(def.id).not.toBe(groupId);
		expect(def.isDefault).toBe(true);

		// an edit of the org list, a rule's grant and an import all land on the default list
		const add = await api(w.users.owner, 'POST', 'orgs/[id]/lists/[kind]/entries', {
			params: { id: w.org.id, kind: 'reserve' },
			body: { steamId: A }
		});
		expect(add.status).toBe(201);
		await grantEntry(env, await listOf(env, w.org.id, 'reserve'), {
			steamId: B,
			reason: 'seeded',
			expiresAt: null,
			addedByName: 'Seeding reward'
		});
		const onList = async (listId: string) =>
			(
				await env.db
					.select({ steamId: listEntries.steamId })
					.from(listEntries)
					.where(and(eq(listEntries.listId, listId), isNull(listEntries.removedAt)))
			).map((e) => e.steamId);
		expect((await onList(def.id)).sort()).toEqual([A, B]);
		expect(await onList(groupId)).toEqual([]);

		// members' slots ride on the default list, and the pages count it, not the group
		await env.db
			.update(organizations)
			.set({ membersReserved: true })
			.where(eq(organizations.id, w.org.id));
		const org = (await getOrg(env, w.org.id))!;
		const view = await orgListsView(env, org, { owner: true, kinds: ['ban', 'reserve'] });
		expect(view.lists.map((l) => l.id)).not.toContain(groupId);
		expect(view.lists.find((l) => l.kind === 'reserve')!.id).toBe(def.id);
		expect(view.groups.map((g) => g.id)).toEqual([groupId]);
		expect((await entriesView(env, org, 'reserve')).map((e) => e.steamId).sort()).toEqual([A, B]);
	});

	test('switched off, a group comes out of the document; on again before a restart, it goes back', async () => {
		const w = await world();
		const s = await demoServer(w);
		const groupId = await make(w, { name: 'Clan event' });
		await addTo(w, groupId, A);
		await s.sync();
		expect(await s.doc()).not.toContain(A);

		expect((await switchIt(w, groupId, { on: true })).status).toBe(200);
		await s.sync();
		expect(await s.doc()).toContain(A);
		s.restart();

		await switchIt(w, groupId, { on: false });
		await s.sync();
		expect(await s.doc()).not.toContain(A);

		await switchIt(w, groupId, { on: true });
		await s.sync();
		expect(await s.doc()).toContain(A);
	});

	test('a window not yet open and one ended both read off; inside it, on', async () => {
		const w = await world();
		const s = await demoServer(w);
		const groupId = await make(w, { name: 'Tournament' });
		await addTo(w, groupId, A);
		const now = Date.now();
		const from = new Date(now + 2 * HOUR);
		const until = new Date(now + 4 * HOUR);
		const r = await switchIt(w, groupId, {
			on: true,
			from: from.toISOString(),
			until: until.toISOString()
		});
		expect(r.status).toBe(200);
		expect((r.body as { group: { on: boolean } }).group.on).toBe(false);
		expect(await wanted(w, s.id, new Date(now))).not.toContain(A);
		expect(await wanted(w, s.id, new Date(now + 3 * HOUR))).toContain(A);
		expect(await wanted(w, s.id, until)).not.toContain(A);
		expect(await wanted(w, s.id, new Date(now + 5 * HOUR))).not.toContain(A);
	});

	test('a window is checked: an end ahead, a start before it, within a year', async () => {
		const w = await world();
		const groupId = await make(w, { name: 'Checked' });
		const at = (ms: number) => new Date(Date.now() + ms).toISOString();
		for (const body of [
			{ on: 'yes' },
			{ on: true, until: at(10_000) },
			{ on: true, until: 'soon' },
			{ on: true, from: at(HOUR) },
			{ on: true, from: at(3 * HOUR), until: at(2 * HOUR) },
			{ on: true, until: at(400 * 86400_000) }
		]) {
			const r = await switchIt(w, groupId, body);
			expect({ body, status: r.status }).toEqual({ body, status: 400 });
		}
		expect((await groupRow(groupId)).onFrom).toBeNull();
	});

	test('a group for chosen servers reaches only those; for every server, a new server too', async () => {
		const w = await world();
		const one = await demoServer(w, 'One');
		const two = await demoServer(w, 'Two');
		const chosen = await make(w, { name: 'Chosen', servers: [one.id] });
		const every = await make(w, { name: 'Everyone' });
		await switchIt(w, chosen, { on: true });
		await switchIt(w, every, { on: true });
		await addTo(w, chosen, A);
		await addTo(w, every, B);
		expect((await wanted(w, one.id)).sort()).toEqual([A, B]);
		expect(await wanted(w, two.id)).toEqual([B]);

		// a server added later through the panel takes the every-server group, not the chosen one
		await env.db
			.update(organizations)
			.set({ serverLimit: 100 })
			.where(eq(organizations.id, w.org.id));
		const org = (await getOrg(env, w.org.id))!;
		const third = await createServer(
			env,
			new Request('http://localhost/api'),
			w.users.owner!,
			org,
			{
				name: 'Three',
				host: 'demo',
				port: 3,
				password: 'demo'
			}
		);
		expect(await wanted(w, third)).toEqual([B]);

		// rescoped to the second server alone
		const r = await api(w.users.owner, 'PATCH', 'orgs/[id]/slot-groups/[groupId]', {
			params: { id: w.org.id, groupId: chosen },
			body: { servers: [two.id] }
		});
		expect(r.status).toBe(200);
		expect(await wanted(w, one.id)).toEqual([B]);
		expect((await wanted(w, two.id)).sort()).toEqual([A, B]);

		// a server of another org is refused, naming none
		const other = await api(w.users.owner, 'PATCH', 'orgs/[id]/slot-groups/[groupId]', {
			params: { id: w.org.id, groupId: chosen },
			body: { servers: [w.otherOrgServer.id] }
		});
		expect(other.status).toBe(400);
		expect(other.message).not.toContain(w.otherOrgServer.id);
		const given = await env.db
			.select({ serverId: serverLists.serverId })
			.from(serverLists)
			.where(eq(serverLists.listId, chosen));
		expect(given.map((g) => g.serverId)).toEqual([two.id]);
	});

	test('names are unique in the org in any case, "Default" included', async () => {
		const w = await world();
		await make(w, { name: 'Clan' });
		for (const name of ['clan', 'CLAN', 'default', 'Default']) {
			const r = await api(w.users.owner, 'POST', 'orgs/[id]/slot-groups', {
				params: { id: w.org.id },
				body: { name }
			});
			expect({ name, status: r.status }).toEqual({ name, status: 409 });
		}
	});

	test('archiving takes the slots off and keeps the group, its servers and its entries', async () => {
		const w = await world();
		const s = await demoServer(w);
		const groupId = await make(w, { name: 'Gone soon', servers: [s.id] });
		await switchIt(w, groupId, { on: true });
		await addTo(w, groupId, A);
		await s.sync();
		expect(await s.doc()).toContain(A);

		const r = await api(w.users.owner, 'DELETE', 'orgs/[id]/slot-groups/[groupId]', {
			params: { id: w.org.id, groupId }
		});
		expect(r.status).toBe(200);
		await s.sync();
		expect(await s.doc()).not.toContain(A);
		const row = await groupRow(groupId);
		expect(row.archivedAt).not.toBeNull();
		const kept = await env.db
			.select({ steamId: listEntries.steamId })
			.from(listEntries)
			.where(and(eq(listEntries.listId, groupId), isNull(listEntries.removedAt)));
		expect(kept.map((k) => k.steamId)).toEqual([A]);
		const given = await env.db.select().from(serverLists).where(eq(serverLists.listId, groupId));
		expect(given).toHaveLength(1);
		// gone from every view, its name free, and its id no longer answers
		const org = (await getOrg(env, w.org.id))!;
		expect((await orgListsView(env, org, { owner: true, kinds: ['reserve'] })).groups).toEqual([]);
		await make(w, { name: 'Gone soon' });
		const again = await switchIt(w, groupId, { on: true });
		expect([again.status, again.message]).toEqual([404, 'Group not found.']);
	});

	test('a group taken away while another request held it is not switched, changed or taken again', async () => {
		const w = await world();
		const groupId = await make(w, { name: 'Raced' });
		const seen = await groupRow(groupId);
		const org = (await getOrg(env, w.org.id))!;
		const req = new Request('http://localhost/api');
		await archiveGroup(env, req, w.users.owner!, org, seen);
		const audits = async () =>
			(await env.db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.target, 'Raced')))
				.length;
		const before = await audits();
		for (const late of [
			() => switchGroup(env, req, w.users.owner!, org, seen, { on: true }),
			() => updateGroup(env, req, w.users.owner!, org, seen, { name: 'Renamed late' }),
			() => archiveGroup(env, req, w.users.owner!, org, seen)
		])
			await expect(late()).rejects.toThrow('Group not found.');
		const row = await groupRow(groupId);
		expect([row.name, row.onFrom, row.onUntil?.getTime()]).toEqual([
			'Raced',
			null,
			seen.onUntil?.getTime()
		]);
		expect(await audits()).toBe(before);
	});

	test('a player in a group is not offered for import, switched on or not', async () => {
		const w = await world();
		const s = await demoServer(w);
		const groupId = await make(w, { name: 'Held' });
		await switchIt(w, groupId, { on: true });
		await addTo(w, groupId, C);
		await s.sync();
		await switchIt(w, groupId, { on: false });
		const org = (await getOrg(env, w.org.id))!;
		expect((await importCandidates(env, org)).map((c) => c.steamId)).not.toContain(C);
	});

	test("a group's name is staff's: not for viewers, nor for the ban list's editors", async () => {
		const w = await world();
		const groupId = await make(w, { name: 'Secret clan' });
		await switchIt(w, groupId, { on: true });
		await addTo(w, groupId, A);
		const server = (await getServer(env, w.server.id))!;
		const state = async (who: SessionUser, caps: string[]) =>
			JSON.stringify(await serverListsState(env, server, who, { caps: new Set(caps) } as never));
		// the slot shows as the org's; only staff see whose group it is
		expect(await state(w.users.viewer!, ['server.view'])).not.toContain('Secret clan');
		expect(await state(w.users.orgSlots!, ['server.view', 'lists.reserve'])).toContain(
			'Secret clan'
		);

		for (const who of ['viewer', 'orgBans', 'keyBans'] as const) {
			const route = await api(w.users[who], 'GET', 'servers/[id]/lists/state', {
				params: { id: w.server.id }
			});
			expect({ who, leak: JSON.stringify(route.body).includes('Secret clan') }).toEqual({
				who,
				leak: false
			});
		}
		for (const who of ['orgBans', 'keyBans'] as const) {
			const lists = await api(w.users[who], 'GET', 'orgs/[id]/lists', {
				params: { id: w.org.id }
			});
			expect(lists.status).toBe(200);
			expect(JSON.stringify(lists.body)).not.toContain('Secret clan');
			const groups = await api(w.users[who], 'GET', 'orgs/[id]/slot-groups', {
				params: { id: w.org.id }
			});
			expect(groups.status).toBe(403);
		}
		const { load: slotsLoad } = await import(
			join(ROUTES, '(app)', 'server', '[id]', 'slots', '+page.server.ts')
		);
		const { load: orgLayout } = await import(
			join(ROUTES, '(app)', 'orgs', '[id]', '+layout.server.ts')
		);
		for (const who of ['viewer', 'orgBans'] as const) {
			const page = await callLoad(slotsLoad, w.users[who], { params: { id: w.server.id } });
			expect({ who, leak: JSON.stringify(page.body).includes('Secret clan') }).toEqual({
				who,
				leak: false
			});
		}
		const layout = await callLoad(orgLayout, w.users.orgBans, { params: { id: w.org.id } });
		expect(layout.status).toBe(200);
		expect(JSON.stringify(layout.body)).not.toContain('Secret clan');
	});

	test('an org-wide key with Org reserved slots makes, switches and fills a group', async () => {
		const w = await world();
		const keyed = w.users.keyAll!;
		const groupId = await make(w, { name: 'By key' }, keyed);
		expect((await switchIt(w, groupId, { on: true }, keyed)).status).toBe(200);
		expect((await addTo(w, groupId, A, keyed)).status).toBe(201);
		// a key held to some servers cannot open the groups at all
		const held = await api(w.users.keyElsewhere, 'GET', 'orgs/[id]/slot-groups', {
			params: { id: w.org.id }
		});
		expect(held.status).toBe(404);
	});
});
