// The kill feed's verdict ($lib/feed-health) as each of the cast reads it: on the feed route, which
// anyone who can see the server reads, and on the Automation tab's load. When the token was made is
// part of how the server is run and goes where the token goes (org owners and the site owner), so
// only they are told the feed waits for the game's restart; everyone else reads it as silent.
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { RequestEvent } from '@sveltejs/kit';
import type { Env } from '$lib/server/env';
import { serverLive, servers } from '$lib/server/db/schema';
import { feedStatus } from '$lib/server/feed';
import { feedDiagnosis, feedReportOf } from '$lib/feed-report';
import { resetRates } from '$lib/server/ratelimit';
import { POST as ingest } from '../routes/api/ingest/events/+server';
import { hasTestDb, testEnv } from './db';
import { callApi, callLoad, stubGateway } from './call';
import { expected } from './policy';
import { PRINCIPALS, seedWorld, type PrincipalName, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
const MIN = 60_000;

describe.skipIf(!hasTestDb)("the kill feed's verdict", () => {
	let env: Env;

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
	});

	const feedRoute = async (method: 'GET' | 'POST' | 'DELETE') =>
		(await import(join(ROUTES, 'api', 'servers', '[id]', 'feed', '+server.ts')))[method];
	const automationLoad = async () =>
		(await import(join(ROUTES, '(app)', 'server', '[id]', 'automation', '+page.server.ts'))).load;

	/**
	 * The server under test with a token made `tokenMinAgo` minutes ago (through the route, as an
	 * owner makes it), up for six hours and watched a moment ago, its last batch `feedMinAgo` minutes
	 * ago (null: never).
	 */
	async function arrange(w: World, tokenMinAgo: number, feedMinAgo: number | null) {
		const made = await callApi(await feedRoute('POST'), w.users.owner, {
			method: 'POST',
			params: { id: w.server.id }
		});
		expect(made.status).toBe(200);
		const now = Date.now();
		await env.db
			.update(servers)
			.set({ feedTokenAt: new Date(now - tokenMinAgo * MIN) })
			.where(eq(servers.id, w.server.id));
		const live = {
			ok: true,
			startedAt: new Date(now - 6 * 60 * MIN),
			observedAt: new Date(now - 3000),
			feedAt: feedMinAgo === null ? null : new Date(now - feedMinAgo * MIN)
		};
		await env.db
			.insert(serverLive)
			.values({ serverId: w.server.id, ...live })
			.onConflictDoUpdate({ target: serverLive.serverId, set: live });
	}

	type Read = { state?: string; tokenAt?: string | null; token?: string; startedAt?: string };
	const readFeed = async (w: World, who: PrincipalName) => {
		const o = await callApi(await feedRoute('GET'), w.users[who], { params: { id: w.server.id } });
		const b = o.body as Read;
		return o.status === 200
			? [200, b.state, b.tokenAt !== null, !!b.token, typeof b.startedAt === 'string']
			: [o.status];
	};

	test('the feed route: the verdict for anyone who can see the server, waiting for owners alone', async () => {
		const w = await seedWorld(env);
		// replaced twenty minutes ago, while the game has run for six hours
		await arrange(w, 20, null);
		const got: Record<string, unknown> = {};
		const want: Record<string, unknown> = {};
		for (const who of PRINCIPALS) {
			got[who] = await readFeed(w, who);
			const verdict = expected('cap:server.view', who);
			const owner = expected('orgOwner', who) === 'ok';
			want[who] =
				verdict !== 'ok'
					? [verdict]
					: owner
						? [200, 'waiting', true, true, true]
						: [200, 'silent', false, false, true];
		}
		expect(got).toEqual(want);
		// the four the rules name: a viewer, a member of another org, a scoped key, nobody
		expect([got.viewer, got.outsider, got.keyView, got.anon]).toEqual([
			[200, 'silent', false, false, true],
			[404],
			[200, 'silent', false, false, true],
			[401]
		]);
	});

	test('a token older than the game start is silent until a batch comes, then live', async () => {
		const w = await seedWorld(env);
		await arrange(w, 7 * 60, 3 * 24 * 60);
		expect(await readFeed(w, 'owner')).toEqual([200, 'silent', true, true, true]);
		expect(await readFeed(w, 'viewer')).toEqual([200, 'silent', false, false, true]);
		await arrange(w, 7 * 60, 1);
		// arrange made the token again through the route; keep it older than the start
		await env.db
			.update(servers)
			.set({ feedTokenAt: new Date(Date.now() - 7 * 60 * MIN) })
			.where(eq(servers.id, w.server.id));
		expect(await readFeed(w, 'owner')).toEqual([200, 'live', true, true, true]);
		expect(await readFeed(w, 'viewer')).toEqual([200, 'live', false, false, true]);
	});

	test('the demo game takes its token at once, so it never waits for a restart', async () => {
		const w = await seedWorld(env);
		await arrange(w, 20, null);
		await env.db.update(servers).set({ host: 'demo' }).where(eq(servers.id, w.server.id));
		const [row] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		expect((await feedStatus({ ...env, ALLOW_DEMO_SERVER: 'true' }, row, true)).state).toBe(
			'silent'
		);
		// without the demo switched on, a host named demo is any other server
		expect((await feedStatus({ ...env, ALLOW_DEMO_SERVER: 'false' }, row, true)).state).toBe(
			'waiting'
		);
	});

	test('a batch the game counts as sent is in every verdict read after it', async () => {
		// TLR #1, 2026-10-18: the Config card read the verdict, the server restarted with a working
		// line, then Read again read the report alone. Its batches against the verdict from before
		// said "not as this server" although the token was this server's.
		resetRates();
		const w = await seedWorld(env);
		await arrange(w, 7 * 60, 3 * 24 * 60);
		const made = await callApi(await feedRoute('POST'), w.users.owner, {
			method: 'POST',
			params: { id: w.server.id }
		});
		const token = (made.body as { token: string }).token;
		await env.db
			.update(servers)
			.set({ feedTokenAt: new Date(Date.now() - 7 * 60 * MIN) })
			.where(eq(servers.id, w.server.id));
		const row = async () =>
			(await env.db.select().from(servers).where(eq(servers.id, w.server.id)))[0];
		const before = await feedStatus(env, await row(), false);
		expect(before.state).toBe('silent');

		// what an empty Season 2 server posts: a join, no kill and no match state
		const res = await ingest({
			request: new Request('http://localhost/api/ingest/events', {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
				body: JSON.stringify({
					serverId: 'e9cf2544-b21e-4b80-9f12-8ec95ff58964',
					serverName: 'Test',
					events: [
						{
							eventId: randomUUID(),
							type: 'player_joined',
							eventTime: 12.5,
							matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
							mapName: 'Kavkazi',
							playerName: 'Charlie',
							playerId: '-0000-000000000000',
							playerSteamId: '76561198000000003',
							players: 1
						}
					]
				})
			})
		} as unknown as RequestEvent);
		// the game counts it as sent once it has this answer
		expect(res.status).toBe(200);
		const after = await feedStatus(env, await row(), false);
		expect(after.state).toBe('live');

		const report = feedReportOf({
			enabled: true,
			endpointCount: 1,
			endpoints: [
				{
					index: 0,
					scheme: 'https',
					host: 'console.warcon.app',
					healthy: true,
					sentTotal: 1,
					lastHttpStatus: 200
				}
			]
		})!;
		expect(feedDiagnosis(report, 'https://console.warcon.app', after.state).fault).toBeNull();
		// against the verdict from before the batch: what the card said
		expect(feedDiagnosis(report, 'https://console.warcon.app', before.state).fault).toBe(
			'otherToken'
		);
	});

	test('Configure stamps the token time, Turn off clears it', async () => {
		const w = await seedWorld(env);
		const at = async () =>
			(
				await env.db
					.select({ at: servers.feedTokenAt })
					.from(servers)
					.where(eq(servers.id, w.server.id))
			)[0].at;
		expect(await at()).toBeNull();
		const before = Date.now();
		await callApi(await feedRoute('POST'), w.users.owner, {
			method: 'POST',
			params: { id: w.server.id }
		});
		expect((await at())!.getTime()).toBeGreaterThanOrEqual(before - 1000);
		await callApi(await feedRoute('DELETE'), w.users.owner, {
			method: 'DELETE',
			params: { id: w.server.id }
		});
		expect(await at()).toBeNull();
	});

	test('the Automation load: the verdict for Automation holders, never the token time', async () => {
		const w = await seedWorld(env);
		await arrange(w, 20, null);
		const load = await automationLoad();
		const got: Record<string, unknown> = {};
		const want: Record<string, unknown> = {};
		for (const who of PRINCIPALS) {
			const o = await callLoad(load, w.users[who], { params: { id: w.server.id } });
			const s = (o.body as { feedStatus?: Read } | null)?.feedStatus;
			got[who] = o.status === 200 ? [200, s?.state, s?.tokenAt] : [o.status];
			const verdict = expected('cap:automation.manage', who);
			want[who] = verdict === 'ok' ? [200, 'silent', null] : [verdict];
		}
		expect(got).toEqual(want);
		expect([got.viewer, got.outsider, got.keyView, got.anon]).toEqual([[403], [404], [403], [401]]);
	});
});
