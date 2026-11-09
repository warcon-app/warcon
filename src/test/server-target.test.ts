// One server row per RCON address: a second add of an address already on the panel is refused,
// naming no other organisation, and the limit on an org's servers holds when two adds race.
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { randomInt } from 'node:crypto';
import type { Env } from '$lib/server/env';
import { encryptSecret } from '$lib/server/crypto';
import { auditLog, organizations, servers } from '$lib/server/db/schema';
import { POST as createRoute } from '../routes/api/servers/+server';
import { PATCH as updateRoute } from '../routes/api/servers/[id]/+server';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';

describe.skipIf(!hasTestDb)('one server row per RCON address', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		// room for every add in this file; the limit has a test of its own below
		for (const id of [w.org.id, w.otherOrg.id])
			await env.db.update(organizations).set({ serverLimit: 1000 }).where(eq(organizations.id, id));
	});

	/** A public address no other test uses. */
	const address = () => `198.20.${randomInt(1, 255)}.${randomInt(1, 255)}`;

	const add = (who: 'owner' | 'outsider', orgId: string, body: Record<string, unknown>) =>
		callApi(createRoute, w.users[who], {
			method: 'POST',
			body: { orgId, name: 'Game', scheme: 'http', password: 'rcon-secret', ...body }
		});

	const rowsAt = async (host: string, port: number) =>
		(
			await env.db
				.select({ id: servers.id })
				.from(servers)
				.where(and(sql`lower(${servers.host}) = ${host.toLowerCase()}`, eq(servers.port, port)))
		).length;

	const deniedRows = (orgId: string, host: string) =>
		env.db
			.select({ action: auditLog.action, message: auditLog.message })
			.from(auditLog)
			.where(
				and(
					eq(auditLog.orgId, orgId),
					eq(auditLog.outcome, 'denied'),
					sql`${auditLog.target} LIKE ${'%' + host + '%'}`
				)
			)
			.orderBy(auditLog.id);

	test('another org adding the address is refused, naming no org or server', async () => {
		const host = address();
		expect((await add('owner', w.org.id, { name: 'First', host, port: 7779 })).status).toBe(201);
		for (const body of [
			{ host, port: 7779 },
			{ host: ` ${host} `, port: 7779 },
			{ host, port: 7779, scheme: 'https' }
		]) {
			const r = await add('outsider', w.otherOrg.id, body);
			expect([r.status, r.code]).toEqual([409, 'duplicate_target']);
			expect(r.message).not.toContain('First');
			expect(r.message).not.toContain(w.org.name);
		}
		expect(await rowsAt(host, 7779)).toBe(1);
		const denied = await deniedRows(w.otherOrg.id, host);
		expect(denied.map((d) => d.action)).toEqual(Array(3).fill('server.create'));
		// nothing about the refusal lands in the org that holds the address
		expect(await deniedRows(w.org.id, host)).toHaveLength(0);
	});

	test('the same org adding it again is told which of its servers has it', async () => {
		const host = address();
		await add('owner', w.org.id, { name: 'Alpha', host, port: 7779 });
		const r = await add('owner', w.org.id, { name: 'Beta', host, port: 7779 });
		expect([r.status, r.code]).toEqual([409, 'duplicate_target']);
		expect(r.message).toBe('Alpha already uses this address.');
	});

	test('another port on the same host is a different server', async () => {
		const host = address();
		expect((await add('owner', w.org.id, { host, port: 7779 })).status).toBe(201);
		expect((await add('outsider', w.otherOrg.id, { host, port: 7780 })).status).toBe(201);
	});

	test('the demo target may be added by every org, more than once', async () => {
		const port = randomInt(1000, 60000);
		expect((await add('owner', w.org.id, { host: 'demo', port })).status).toBe(201);
		expect((await add('owner', w.org.id, { host: 'demo', port })).status).toBe(201);
		expect((await add('outsider', w.otherOrg.id, { host: 'demo', port })).status).toBe(201);
	});

	test('moving a server onto a taken address is refused and changes nothing', async () => {
		const host = address();
		await add('owner', w.org.id, { host, port: 7779 });
		const before = (
			await env.db
				.select({ host: servers.host, port: servers.port })
				.from(servers)
				.where(eq(servers.id, w.otherOrgServer.id))
		)[0];
		const r = await callApi(updateRoute, w.users.outsider, {
			method: 'PATCH',
			params: { id: w.otherOrgServer.id },
			body: { host, port: 7779, password: 'rcon-secret' }
		});
		expect([r.status, r.code]).toEqual([409, 'duplicate_target']);
		expect(r.message).not.toContain(w.org.name);
		const after = (
			await env.db
				.select({ host: servers.host, port: servers.port })
				.from(servers)
				.where(eq(servers.id, w.otherOrgServer.id))
		)[0];
		expect(after).toEqual(before);
		const denied = await deniedRows(w.otherOrg.id, host);
		expect(denied.map((d) => d.action)).toEqual(['server.update']);
	});

	test('a pair already on the panel can still be renamed', async () => {
		const host = address();
		const ids = [`s_pair_a_${randomInt(1, 1e9)}`, `s_pair_b_${randomInt(1, 1e9)}`];
		for (const [i, id] of ids.entries())
			await env.db.insert(servers).values({
				id,
				orgId: i ? w.otherOrg.id : w.org.id,
				name: `Pair ${i}`,
				host,
				port: 7779,
				passwordEnc: encryptSecret(env, 'rcon-secret')
			});
		const r = await callApi(updateRoute, w.users.outsider, {
			method: 'PATCH',
			params: { id: ids[1] },
			body: { name: 'Renamed' }
		});
		expect(r.status).toBe(200);
	});

	test('two adds of one address at once leave one row', async () => {
		for (let round = 0; round < 5; round++) {
			const host = address();
			const done = await Promise.all([
				add('owner', w.org.id, { host, port: 7779 }),
				add('outsider', w.otherOrg.id, { host, port: 7779 })
			]);
			expect(done.map((d) => d.status).sort()).toEqual([201, 409]);
			expect(await rowsAt(host, 7779)).toBe(1);
		}
	});

	test('two adds at once at the limit leave one', async () => {
		const world = await seedWorld(env);
		for (let round = 0; round < 5; round++) {
			const [{ n }] = await env.db
				.select({ n: sql<number>`count(*)::int` })
				.from(servers)
				.where(eq(servers.orgId, world.org.id));
			await env.db
				.update(organizations)
				.set({ serverLimit: n + 1 })
				.where(eq(organizations.id, world.org.id));
			const done = await Promise.all(
				[address(), address()].map((host) =>
					callApi(createRoute, world.users.owner, {
						method: 'POST',
						body: { orgId: world.org.id, name: 'Racer', host, port: 7779, password: 'rcon-secret' }
					})
				)
			);
			expect(done.map((d) => d.status).sort()).toEqual([201, 403]);
			const [{ m }] = await env.db
				.select({ m: sql<number>`count(*)::int` })
				.from(servers)
				.where(eq(servers.orgId, world.org.id));
			expect(m).toBe(n + 1);
		}
	});
});
