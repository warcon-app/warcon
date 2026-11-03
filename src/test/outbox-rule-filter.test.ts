// Recent actions, narrowed to chosen rules: a busy rule (a Death whisper at nearly every death)
// fills the server's newest 40 rows, so a quiet rule's are read by its id, from the last week. A rule
// id is only ever matched among the asked server's own rows: another server's rule, of this org or
// another, gives nothing, and the route's check is the same with the parameter as without it.
import { beforeAll, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Env } from '$lib/server/env';
import { outbox, triggers } from '$lib/server/db/schema';
import { newId } from '$lib/server/http';
import type { OutboxView } from '$lib/types';
import { callApi, stubGateway, type CallInput, type Outcome } from './call';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type PrincipalName, type World } from './world';

const ROUTE = join(import.meta.dir, '..', 'routes', 'api/servers/[id]/outbox', '+server.ts');
const DAY = 86400_000;

describe.skipIf(!hasTestDb)('Recent actions by rule', () => {
	let env: Env;
	let w: World;
	let busy: string;
	let quiet: string;
	let elsewhere: string;
	let otherOrg: string;

	const get = async (
		who: PrincipalName,
		input: Omit<CallInput, 'method'> = {}
	): Promise<Outcome> => {
		const { GET } = await import(ROUTE);
		return callApi(GET, w.users[who], { method: 'GET', params: { id: w.server.id }, ...input });
	};
	const rule = async (serverId: string, orgId: string, kind: string, name: string) => {
		const id = newId();
		await env.db
			.insert(triggers)
			.values({ id, serverId, orgId, kind: kind as 'welcome', name, enabled: true, config: {} });
		return id;
	};
	const rows = async (
		serverId: string,
		triggerId: string,
		name: string,
		n: number,
		agoMs: number
	) =>
		env.db.insert(outbox).values(
			Array.from({ length: n }, (_, i) => ({
				serverId,
				triggerId,
				triggerName: name,
				triggerKind: 'death_whisper',
				action: 'whisper',
				target: '76561198000000971',
				dedupeKey: `filter:${triggerId}:${agoMs}:${i}`,
				state: 'delivered',
				createdAt: new Date(Date.now() - agoMs - i * 1000)
			}))
		);
	const items = (r: Outcome) => (r.body as { items: OutboxView[] }).items;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		busy = await rule(w.server.id, w.org.id, 'death_whisper', 'Death whisper');
		quiet = await rule(w.server.id, w.org.id, 'team_kill', 'Team kill limit');
		elsewhere = await rule(w.otherServer.id, w.org.id, 'team_kill', 'Team kill limit');
		otherOrg = await rule(w.otherOrgServer.id, w.otherOrg.id, 'team_kill', 'Team kill limit');
		// the quiet rule kicked twice an hour ago, and once eight days ago; the busy one whispered 45
		// times since
		await rows(w.server.id, quiet, 'Team kill limit', 2, 3600_000);
		await rows(w.server.id, quiet, 'Team kill limit', 1, 8 * DAY);
		await rows(w.server.id, busy, 'Death whisper', 45, 60_000);
		await rows(w.otherServer.id, elsewhere, 'Team kill limit', 1, 60_000);
		await rows(w.otherOrgServer.id, otherOrg, 'Team kill limit', 1, 60_000);
	});

	test("the server's newest 40 hold none of the quiet rule's; asked by id, its own from the week", async () => {
		const all = items(await get('owner'));
		expect(all).toHaveLength(40);
		expect(all.every((r) => r.triggerId === busy)).toBe(true);
		const own = items(await get('owner', { query: `rule=${quiet}` }));
		expect(own.map((r) => r.triggerId)).toEqual([quiet, quiet]);
		// newest first
		expect(own[0].createdAt > own[1].createdAt).toBe(true);
		const both = items(await get('owner', { query: `rule=${quiet}&rule=${busy}` }));
		expect(both).toHaveLength(40);
	});

	test("another server's rule, of this org or another, gives nothing here", async () => {
		expect(items(await get('owner', { query: `rule=${elsewhere}` }))).toEqual([]);
		expect(items(await get('owner', { query: `rule=${otherOrg}` }))).toEqual([]);
		expect(items(await get('site', { query: `rule=${otherOrg}` }))).toEqual([]);
		expect(
			items(await get('owner', { query: `rule=${encodeURIComponent("' OR 1=1 --")}` }))
		).toEqual([]);
	});

	test('the check is the same with the parameter as without it', async () => {
		const expected: Record<PrincipalName, number> = {
			anon: 401,
			stranger: 404,
			outsider: 404,
			member: 404,
			viewer: 403,
			operator: 403,
			admin: 200,
			elsewhere: 404,
			orgBans: 403,
			orgSlots: 403,
			owner: 200,
			site: 200,
			keyView: 403,
			keyAll: 200,
			keyElsewhere: 404,
			keyBans: 403
		};
		for (const [who, status] of Object.entries(expected) as [PrincipalName, number][]) {
			const got = await get(who, { query: `rule=${quiet}` });
			expect([who, got.status]).toEqual([who, status]);
			if (status !== 200) expect(JSON.stringify(got.body)).not.toContain(quiet);
		}
		// the other org's owner, through their own server's path, still sees only their own rows
		const { GET } = await import(ROUTE);
		const theirs = await callApi(GET, w.users.outsider, {
			method: 'GET',
			params: { id: w.otherOrgServer.id },
			query: `rule=${quiet}`
		});
		expect(theirs.status).toBe(200);
		expect(items(theirs)).toEqual([]);
	});
});
