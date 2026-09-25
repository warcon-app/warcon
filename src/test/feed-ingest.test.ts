// The kill feed against a real database: the game sends a batch again when it did not hear back,
// and the copy can arrive while the first is still being written.
import { beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { kills } from '$lib/server/db/schema';
import { countKills, ingestBatch, recentKills } from '$lib/server/feed';
import { EMPTY_FILTER } from '$lib/kills';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const batchOf = (eventIds: string[]) => ({
	serverId: 'e9cf2544-b21e-4b80-9f12-8ec95ff58964',
	serverName: 'Test',
	events: eventIds.map((eventId, i) => ({
		eventId,
		type: 'killed',
		eventTime: 100 + i,
		matchId: '7e72e869-4460-4d27-aa4c-76a52ed20cb4',
		mapName: 'Kavkazi',
		killerName: 'Alpha',
		killerSteamId: '76561198000000001',
		victimName: 'Bravo',
		victimSteamId: '76561198000000002',
		cause: 'Id.Item.AK74M',
		distance: 70,
		contextTags: []
	}))
});

describe.skipIf(!hasTestDb)('kill feed ingest', () => {
	let env: Env;

	beforeAll(async () => {
		env = await testEnv();
	});

	const stored = async (serverId: string, eventId: string) =>
		(
			await env.db
				.select({ id: kills.eventId })
				.from(kills)
				.where(and(eq(kills.serverId, serverId), eq(kills.eventId, eventId)))
		).length;

	test('a batch that arrives many times at once is written once', async () => {
		const w = await seedWorld(env);
		const ids = [randomUUID(), randomUUID()];
		const results = await Promise.all(
			Array.from({ length: 12 }, () => ingestBatch(env, w.server.id, batchOf(ids)))
		);
		expect(results.reduce((n, r) => n + r.accepted, 0)).toBe(2);
		expect(results.reduce((n, r) => n + r.duplicates, 0)).toBe(22);
		for (const id of ids) expect(await stored(w.server.id, id)).toBe(1);
	});

	test("the same event id on another server is that server's own kill", async () => {
		const w = await seedWorld(env);
		const id = randomUUID();
		const [a, b] = await Promise.all([
			ingestBatch(env, w.server.id, batchOf([id])),
			ingestBatch(env, w.otherServer.id, batchOf([id]))
		]);
		expect([a.accepted, b.accepted]).toEqual([1, 1]);
	});

	test('stores every event but exposes only complete kills to kill consumers', async () => {
		const w = await seedWorld(env);
		const killId = randomUUID();
		const startedId = randomUUID();
		const incompleteId = randomUUID();
		const started = {
			eventId: startedId,
			type: 'match_started',
			mapName: 'Kavkazi',
			extra: { round: 2 }
		};
		const incomplete = { eventId: incompleteId, type: 'killed', eventTime: 102 };
		const body = {
			...batchOf([killId]),
			events: [...batchOf([killId]).events, started, incomplete]
		};
		const result = await ingestBatch(env, w.server.id, body);
		expect(result).toMatchObject({ accepted: 3, acceptedKills: 1, skipped: 0, duplicates: 0 });
		expect(result.kills.map((k) => k.eventId)).toEqual([killId]);
		const rows = await env.db.select().from(kills).where(eq(kills.serverId, w.server.id));
		expect(rows.find((r) => r.eventId === startedId)).toMatchObject({
			eventType: 'match_started',
			parsedKill: false,
			rawEvent: started,
			victimSteamId: null
		});
		expect(rows.find((r) => r.eventId === incompleteId)).toMatchObject({
			eventType: 'killed',
			parsedKill: false,
			rawEvent: incomplete
		});
		expect(await countKills(env, w.server.id, EMPTY_FILTER)).toBe(1);
		expect(
			(await recentKills(env, w.server.id, null, 10, EMPTY_FILTER)).map((k) => k.eventId)
		).toEqual([killId]);
	});
});
