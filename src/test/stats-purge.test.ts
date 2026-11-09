// A server's stats purge: the server's kills, matches, match rows and match events go, nothing else does, and
// only an org owner who typed the server's name back can do it (the matrix covers who is refused).
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import {
	auditLog,
	kills,
	matchEvents,
	matches,
	matchPlayers,
	playerSessions,
	servers
} from '$lib/server/db/schema';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type World } from './world';
import { POST as purge } from '../routes/api/servers/[id]/stats/purge/+server';

const A = '76561198000000091';

describe.skipIf(!hasTestDb)('stats purge', () => {
	let env: Env;
	let w: World;
	let name = '';
	const t = new Date(Date.now() - 3600_000);

	beforeAll(async () => {
		env = await testEnv();
		stubGateway();
		w = await seedWorld(env);
		[{ name }] = await env.db
			.select({ name: servers.name })
			.from(servers)
			.where(eq(servers.id, w.server.id));
		for (const serverId of [w.server.id, w.otherServer.id]) {
			const [m] = await env.db
				.insert(matches)
				.values({ serverId, startedAt: t, endedAt: new Date(), map: 'Europe' })
				.returning({ id: matches.id });
			await env.db
				.insert(matchPlayers)
				.values({ matchId: m.id, serverId, steamId: A, name: 'a', kills: 3 });
			await env.db.insert(kills).values({
				ts: t,
				serverId,
				eventId: `p-${serverId}`,
				instanceId: 'i',
				matchId: 'g',
				matchRow: m.id,
				eventTime: 1,
				map: 'Europe',
				killerSteamId: A,
				killerName: 'a',
				victimSteamId: '76561198000000092',
				victimName: 'b',
				tags: []
			});
			await env.db.insert(matchEvents).values({
				ts: t,
				serverId,
				eventId: `e-${serverId}`,
				seq: 0,
				instanceId: 'i',
				type: 'match_state',
				map: 'Europe',
				state: 'MatchState.Playing.KOTH'
			});
			await env.db
				.insert(playerSessions)
				.values({ serverId, steamId: A, name: 'a', joinedAt: t, lastSeen: t, leftAt: t, kills: 3 });
		}
	});

	const count = async (serverId: string) => ({
		kills: (await env.db.select().from(kills).where(eq(kills.serverId, serverId))).length,
		matches: (await env.db.select().from(matches).where(eq(matches.serverId, serverId))).length,
		lines: (await env.db.select().from(matchPlayers).where(eq(matchPlayers.serverId, serverId)))
			.length,
		events: (await env.db.select().from(matchEvents).where(eq(matchEvents.serverId, serverId)))
			.length,
		sessions: (
			await env.db.select().from(playerSessions).where(eq(playerSessions.serverId, serverId))
		).length
	});

	test('needs the server name typed back', async () => {
		const r = await callApi(purge, w.users.owner, {
			method: 'POST',
			params: { id: w.server.id },
			body: { name: 'wrong' }
		});
		expect([r.status, r.code]).toEqual([400, 'name_mismatch']);
		expect(await count(w.server.id)).toMatchObject({ kills: 1, matches: 1, lines: 1, events: 1 });
	});

	test("deletes this server's kills, matches, match rows and match events, keeps its sessions and the other server's everything, and is audited", async () => {
		const r = await callApi(purge, w.users.owner, {
			method: 'POST',
			params: { id: w.server.id },
			body: { name }
		});
		expect(r.status).toBe(200);
		expect((r.body as { counts: unknown }).counts).toEqual({
			kills: 1,
			matches: 1,
			matchPlayers: 1,
			matchEvents: 1
		});
		expect(await count(w.server.id)).toEqual({
			kills: 0,
			matches: 0,
			lines: 0,
			events: 0,
			sessions: 1
		});
		expect(await count(w.otherServer.id)).toEqual({
			kills: 1,
			matches: 1,
			lines: 1,
			events: 1,
			sessions: 1
		});
		const rows = await env.db
			.select()
			.from(auditLog)
			.where(and(eq(auditLog.action, 'server.stats.purge'), eq(auditLog.serverId, w.server.id)));
		expect(rows.length).toBe(1);
		expect(rows[0].message).toBe('1 kills, 1 matches, 1 match rows and 1 match events deleted.');
		expect(rows[0].actorId).toBe(w.users.owner!.id);
	});
});
