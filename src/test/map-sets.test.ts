// The org's map sets, the rotations its owners save under a name for its servers' Map rotation
// tabs: who may save, rename and delete one (an owner of the org, never a key), who may read them
// (whoever may apply the config of the server the tab is on, which is how a set is loaded), what a
// set may hold, and that one org's sets never reach another, whatever id is sent.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { and, desc, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { SessionUser } from '$lib/server/access';
import { mapSetsView } from '$lib/server/map-sets';
import { auditLog, orgMapSets, orgMembers, organizations, user } from '$lib/server/db/schema';
import { MAX_MAP_SETS, type MapSet } from '$lib/map-sets';
import type { MapSelection } from '$lib/types';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { PRINCIPALS, seedWorld, suspend, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes', 'api');
const INFANTRY: MapSelection[] = [
	{
		map: 'Kavkazi',
		experiences: ['Bakurani_KOTH_02', 'KOTH_InfantryOnly'],
		lighting: 'DayClear',
		zoneAlternator: 'ZoneAlternator.Bakurani.Default.Circle'
	},
	{
		map: 'Europe',
		experiences: ['Madrid_KOTH_01', 'KOTH_InfantryOnly'],
		lighting: 'DayEarlyFog',
		zoneAlternator: ''
	}
];
const STANDARD: MapSelection[] = INFANTRY.map((e) => ({ ...e, experiences: [e.experiences[0]] }));

describe.skipIf(!hasTestDb)("an org's map sets", () => {
	let env: Env;
	let w: World;
	const as = (who: PrincipalName | SessionUser) => (typeof who === 'string' ? w.users[who] : who);

	const create = async (who: PrincipalName | SessionUser, body: unknown, orgId = w.org.id) => {
		const mod = await import(join(ROUTES, 'orgs/[id]/map-sets', '+server.ts'));
		return callApi(mod.POST, as(who), { method: 'POST', params: { id: orgId }, body });
	};
	const patch = async (
		who: PrincipalName | SessionUser,
		setId: string,
		body: unknown,
		orgId = w.org.id
	) => {
		const mod = await import(join(ROUTES, 'orgs/[id]/map-sets/[setId]', '+server.ts'));
		return callApi(mod.PATCH, as(who), { method: 'PATCH', params: { id: orgId, setId }, body });
	};
	const remove = async (who: PrincipalName | SessionUser, setId: string, orgId = w.org.id) => {
		const mod = await import(join(ROUTES, 'orgs/[id]/map-sets/[setId]', '+server.ts'));
		return callApi(mod.DELETE, as(who), { method: 'DELETE', params: { id: orgId, setId } });
	};
	/** what a server's Map rotation tab is handed */
	const read = async (who: PrincipalName | SessionUser, serverId = w.server.id) => {
		const mod = await import(join(ROUTES, 'servers/[id]/map-sets', '+server.ts'));
		return callApi(mod.GET, as(who), { params: { id: serverId } });
	};
	const setsIn = (answer: { body: unknown }) => (answer.body as { mapSets?: MapSet[] }).mapSets;
	const madeIn = (answer: { body: unknown }) => (answer.body as { mapSet: MapSet }).mapSet;
	const stored = async (orgId = w.org.id) =>
		env.db.select().from(orgMapSets).where(eq(orgMapSets.orgId, orgId)).orderBy(orgMapSets.name);
	const lastAudit = async (action: string) =>
		(
			await env.db
				.select()
				.from(auditLog)
				.where(and(eq(auditLog.orgId, w.org.id), eq(auditLog.action, action)))
				.orderBy(desc(auditLog.id))
				.limit(1)
		)[0];

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		stubGateway();
	});

	test('an org that never saved any has none', async () => {
		expect(setsIn(await read('admin'))).toEqual([]);
		expect(await mapSetsView(env, w.org.id)).toEqual([]);
	});

	test('only an owner of the org saves one, and never through a key', async () => {
		for (const who of PRINCIPALS.filter((p) => p !== 'owner' && p !== 'site')) {
			const answer = await create(who, { name: 'Infantry', entries: INFANTRY });
			expect({ who, refused: answer.status >= 400 }).toEqual({ who, refused: true });
		}
		expect(await stored()).toEqual([]);
		// an owner of one org cannot reach another's
		expect(
			(await create('owner', { name: 'Infantry', entries: INFANTRY }, w.otherOrg.id)).status
		).toBe(404);
		expect(await stored(w.otherOrg.id)).toEqual([]);

		const answer = await create('owner', { name: 'Infantry', entries: INFANTRY });
		expect(answer.status).toBe(201);
		expect(madeIn(answer)).toMatchObject({ name: 'Infantry', entries: INFANTRY });
		expect(await stored()).toMatchObject([
			{ name: 'Infantry', entries: INFANTRY, updatedBy: w.users.owner!.id }
		]);
	});

	test('the site owner saves one too, and the sets come back by name', async () => {
		const answer = await create('site', { name: 'standard koth', entries: STANDARD });
		expect(answer.status).toBe(201);
		expect((await read('owner')).status).toBe(200);
		const sets = setsIn(await read('owner'))!;
		expect(sets.map((s) => [s.name, s.entries])).toEqual([
			['Infantry', INFANTRY],
			['standard koth', STANDARD]
		]);
		expect((await stored()).find((r) => r.name === 'standard koth')?.updatedBy).toBe(
			w.users.site!.id
		);
	});

	test('whoever may apply the config of the server reads them, and nobody else', async () => {
		// Config & settings on this server: the admin role, owners, the site owner, a full key
		for (const who of ['owner', 'site', 'admin', 'keyAll'] as PrincipalName[])
			expect({ who, names: setsIn(await read(who))?.map((s) => s.name) }).toEqual({
				who,
				names: ['Infantry', 'standard koth']
			});
		// on the server without it: View, Chat and the rest are not how the rotation is run
		for (const who of [
			'viewer',
			'operator',
			'orgBans',
			'orgSlots',
			'keyView',
			'keyBans'
		] as PrincipalName[])
			expect({ who, status: (await read(who)).status }).toEqual({ who, status: 403 });
		expect((await read('anon')).status).toBe(401);
		// cannot see the server at all
		for (const who of [
			'stranger',
			'outsider',
			'member',
			'elsewhere',
			'keyElsewhere'
		] as PrincipalName[])
			expect({ who, status: (await read(who)).status }).toEqual({ who, status: 404 });
	});

	test("the sets are the whole org's: Config & settings on another of its servers reads them there", async () => {
		for (const who of ['elsewhere', 'keyElsewhere'] as PrincipalName[])
			expect({ who, n: setsIn(await read(who, w.otherServer.id))?.length }).toEqual({ who, n: 2 });
	});

	test("one org's sets never reach another's servers", async () => {
		expect(setsIn(await read('outsider', w.otherOrgServer.id))).toEqual([]);
		expect((await read('owner', w.otherOrgServer.id)).status).toBe(404);
	});

	test('a save is in the audit trail with its name and size, not its entries', async () => {
		const row = await lastAudit('map_set.create');
		expect(row).toMatchObject({
			actorId: w.users.site!.id,
			category: 'org',
			outcome: 'ok',
			target: 'standard koth',
			message: 'Map set saved: 2 rotation entries'
		});
		expect(row.detail).toEqual({
			orgId: w.org.id,
			mapSetId: (await stored()).find((r) => r.name === 'standard koth')!.id,
			entries: 2
		});
	});

	test('the tab shows when each was last saved and by whom', async () => {
		const view = await mapSetsView(env, w.org.id);
		expect(view.map((s) => [s.name, s.savedBy])).toEqual([
			['Infantry', w.users.owner!.username],
			['standard koth', w.users.site!.username]
		]);
		expect(Date.now() - Date.parse(view[0].savedAt)).toBeLessThan(60_000);
	});

	test('an entry is stored as its four fields, whatever else is sent with it', async () => {
		const mod = await import(join(ROUTES, 'orgs/[id]/map-sets', '+server.ts'));
		// as sent on the wire: JSON text, where __proto__ is a key like any other
		const answer = await callApi(mod.POST, w.users.owner, {
			method: 'POST',
			params: { id: w.org.id },
			raw: JSON.stringify({ name: 'Extra keys', entries: [{ map: 'Kavkazi' }] }).replace(
				'"map":"Kavkazi"',
				'"map":"Kavkazi","password":"hunter2","revision":"abc","__proto__":{"polluted":true}'
			)
		});
		expect(answer.status).toBe(201);
		const row = (await stored()).find((r) => r.name === 'Extra keys')!;
		expect(row.entries).toEqual([
			{ map: 'Kavkazi', experiences: [], lighting: '', zoneAlternator: '' }
		]);
		expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		expect((await remove('owner', row.id)).status).toBe(200);
	});

	test('a set that would not save is refused and nothing is stored', async () => {
		const before = await stored();
		for (const body of [
			{},
			{ name: '  ', entries: INFANTRY },
			{ name: 'No entries', entries: [] },
			{ name: 'Not a list', entries: INFANTRY[0] },
			{ name: 'Bad id', entries: [{ ...INFANTRY[0], lighting: 'Day Clear' }] },
			{ name: 'No map', entries: [{ experiences: ['Madrid_KOTH_01'] }] },
			// a value that would end the entry and write the RCON password into the document
			{
				name: 'Break out',
				entries: [{ map: 'Kavkazi")\n[/Script/WDRCON.WDRCONSettings]\nPassword="x' }]
			},
			{ name: 'Too long', entries: Array(301).fill(INFANTRY[0]) }
		]) {
			const answer = await create('owner', body);
			expect({ body: body.name, status: answer.status }).toEqual({ body: body.name, status: 400 });
		}
		expect(await stored()).toEqual(before);
		expect(
			(await create('owner', { name: 'Bad id', entries: [{ map: 'a b' }] })).body
		).toMatchObject({ error: { message: 'Entry 1: "a b" is not a map id.' } });
	});

	test('names are unique in the org, ignoring case', async () => {
		const taken = await create('owner', { name: ' INFANTRY ', entries: STANDARD });
		expect(taken.status).toBe(409);
		expect(taken.code).toBe('name_taken');
		const [infantry, standard] = await stored();
		expect((await patch('owner', standard.id, { name: 'infantry' })).status).toBe(409);
		expect((await stored()).map((r) => r.name)).toEqual([infantry.name, standard.name]);
		// another org may use the same name
		expect(
			(await create('outsider', { name: 'Infantry', entries: INFANTRY }, w.otherOrg.id)).status
		).toBe(201);
	});

	test('an owner renames a set, or saves new entries over it, and the trail says which', async () => {
		const standard = (await stored()).find((r) => r.name === 'standard koth')!;
		const renamed = await patch('owner', standard.id, { name: 'Standard KOTH' });
		expect(renamed.status).toBe(200);
		expect(madeIn(renamed)).toEqual({ id: standard.id, name: 'Standard KOTH', entries: STANDARD });
		expect(await lastAudit('map_set.update')).toMatchObject({
			target: 'Standard KOTH',
			message: 'Map set renamed from standard koth',
			detail: { orgId: w.org.id, mapSetId: standard.id, from: 'standard koth' }
		});

		const longer = [...STANDARD, { ...STANDARD[0], lighting: 'DayLateRain' }];
		expect((await patch('owner', standard.id, { entries: longer })).status).toBe(200);
		expect((await stored()).find((r) => r.id === standard.id)).toMatchObject({
			name: 'Standard KOTH',
			entries: longer,
			updatedBy: w.users.owner!.id
		});
		expect(await lastAudit('map_set.update')).toMatchObject({
			message: 'Map set saved: 3 rotation entries',
			detail: { orgId: w.org.id, mapSetId: standard.id, entries: 3 }
		});
		expect((await patch('owner', standard.id, {})).status).toBe(400);
		expect((await patch('owner', standard.id, { entries: [] })).status).toBe(400);
		expect((await stored()).find((r) => r.id === standard.id)?.entries).toEqual(longer);
	});

	test("another org's set is not found through this org, nor this org's through another", async () => {
		const [theirs] = await stored(w.otherOrg.id);
		// an owner of this org names the other org's set under their own org
		expect((await patch('owner', theirs.id, { name: 'Mine now' })).status).toBe(404);
		expect((await patch('owner', theirs.id, { entries: STANDARD })).status).toBe(404);
		expect((await remove('owner', theirs.id)).status).toBe(404);
		// or under the org it belongs to
		expect((await patch('owner', theirs.id, { name: 'Mine now' }, w.otherOrg.id)).status).toBe(404);
		expect((await remove('owner', theirs.id, w.otherOrg.id)).status).toBe(404);
		expect(await stored(w.otherOrg.id)).toMatchObject([
			{ id: theirs.id, name: 'Infantry', entries: INFANTRY }
		]);
		// and the other org's owner cannot reach this org's
		const [ours] = await stored();
		expect((await patch('outsider', ours.id, { name: 'Theirs now' }, w.otherOrg.id)).status).toBe(
			404
		);
		expect((await remove('outsider', ours.id, w.otherOrg.id)).status).toBe(404);
		expect((await stored()).map((r) => r.name)).toContain(ours.name);
	});

	test('only an owner renames or deletes one', async () => {
		const [ours] = await stored();
		for (const who of PRINCIPALS.filter((p) => p !== 'owner' && p !== 'site')) {
			expect({ who, refused: (await patch(who, ours.id, { name: 'X' })).status >= 400 }).toEqual({
				who,
				refused: true
			});
			expect({ who, refused: (await remove(who, ours.id)).status >= 400 }).toEqual({
				who,
				refused: true
			});
		}
		expect((await stored()).find((r) => r.id === ours.id)?.name).toBe(ours.name);
	});

	test('a deleted set is gone from every server, and in the trail', async () => {
		const made = madeIn(await create('owner', { name: 'Rain', entries: STANDARD }));
		expect(setsIn(await read('admin'))?.map((s) => s.name)).toContain('Rain');
		expect((await remove('owner', made.id)).status).toBe(200);
		expect(setsIn(await read('admin'))?.map((s) => s.name)).not.toContain('Rain');
		expect((await remove('owner', made.id)).status).toBe(404);
		expect(await lastAudit('map_set.delete')).toMatchObject({
			target: 'Rain',
			message: 'Map set deleted: it had 2 rotation entries',
			detail: { orgId: w.org.id, mapSetId: made.id, entries: 2 }
		});
	});

	test(`an org keeps at most ${MAX_MAP_SETS}`, async () => {
		const have = (await stored()).length;
		for (let i = have; i < MAX_MAP_SETS; i++)
			expect((await create('owner', { name: `Set ${i}`, entries: STANDARD })).status).toBe(201);
		const over = await create('owner', { name: 'One more', entries: STANDARD });
		expect(over.status).toBe(400);
		expect(over.message).toBe(`An organisation keeps at most ${MAX_MAP_SETS} map sets.`);
		expect(await stored()).toHaveLength(MAX_MAP_SETS);
		for (const row of await stored())
			if (/^Set \d+$/.test(row.name)) expect((await remove('owner', row.id)).status).toBe(200);
	});

	test('a deleted account leaves its sets, without its name', async () => {
		const id = `u_second_owner_${w.org.id}`;
		await env.db.insert(user).values({
			id,
			name: id,
			email: `${id}@test.invalid`,
			username: id,
			displayUsername: id,
			role: 'member',
			authComplete: true
		});
		await env.db.insert(orgMembers).values({ orgId: w.org.id, userId: id, role: 'owner' });
		const second: SessionUser = {
			id,
			username: id,
			name: id,
			role: 'member',
			mustChangePassword: false,
			image: null,
			defaultOrgId: null,
			authComplete: true,
			authGraceStartedAt: null
		};
		const made = madeIn(await create(second, { name: 'Seeding', entries: STANDARD }));
		expect((await mapSetsView(env, w.org.id)).find((s) => s.id === made.id)?.savedBy).toBe(id);

		await env.db.delete(user).where(eq(user.id, id));
		expect((await stored()).find((r) => r.id === made.id)).toMatchObject({
			name: 'Seeding',
			entries: STANDARD,
			updatedBy: null
		});
		expect((await mapSetsView(env, w.org.id)).find((s) => s.id === made.id)?.savedBy).toBeNull();
	});

	test("a suspended org's owners cannot change them, nor its staff read them", async () => {
		const [ours] = await stored();
		await suspend(env, w.org.id);
		try {
			expect((await create('owner', { name: 'During', entries: STANDARD })).status).toBe(403);
			expect((await patch('owner', ours.id, { name: 'During' })).status).toBe(403);
			expect((await remove('owner', ours.id)).status).toBe(403);
			expect((await read('admin')).status).toBe(404);
			expect((await read('keyAll')).status).toBe(404);
			expect((await stored()).find((r) => r.id === ours.id)?.name).toBe(ours.name);
		} finally {
			await env.db
				.update(organizations)
				.set({ suspendedAt: null, suspendedReason: '' })
				.where(eq(organizations.id, w.org.id));
		}
	});
});
