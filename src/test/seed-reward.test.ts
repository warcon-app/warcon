import { beforeAll, describe, expect, test } from 'bun:test';
import { asc, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { listEntries, triggers } from '$lib/server/db/schema';
import { ensureOrgLists, grantEntry, listOf } from '$lib/server/lists';
import { evaluateTriggers, type TickContext } from '$lib/server/triggers';
import { validateConfig } from '$lib/server/trigger-rules';
import { newId } from '$lib/server/http';
import { hasTestDb, testEnv } from './db';
import { seedWorld } from './world';

const STEAM = '76561198000000042';

describe.skipIf(!hasTestDb)('seeding reward replacement', () => {
	let env: Env;

	beforeAll(async () => {
		env = await testEnv();
	});

	test('soft-removes the active entry and grants a fresh slot', async () => {
		const w = await seedWorld(env);
		await ensureOrgLists(env.db, w.org.id);
		const list = await listOf(env, w.org.id, 'reserve');
		const old = await grantEntry(env, list, {
			steamId: STEAM,
			reason: 'old reward',
			expiresAt: new Date('2026-10-01T00:00:00Z'),
			addedByName: 'admin'
		});
		const fresh = await grantEntry(
			env,
			list,
			{
				steamId: STEAM,
				reason: 'new seed reward',
				expiresAt: new Date('2026-10-08T00:00:00Z'),
				addedByName: 'trigger: Seeders'
			},
			{ replaceExisting: true }
		);

		expect(fresh).toMatchObject({ added: true, replaced: true });
		const rows = await env.db
			.select()
			.from(listEntries)
			.where(eq(listEntries.listId, list.id))
			.orderBy(asc(listEntries.addedAt), asc(listEntries.id));
		expect(rows).toHaveLength(2);
		expect(rows.find((r) => r.id === old.id)).toMatchObject({
			removedByName: 'trigger: Seeders',
			removal: 'manual'
		});
		expect(rows.find((r) => r.id === fresh.id)).toMatchObject({
			reason: 'new seed reward',
			removedAt: null
		});
	});

	test('keeps an existing slot whose note contains the protected word', async () => {
		const w = await seedWorld(env);
		await ensureOrgLists(env.db, w.org.id);
		const list = await listOf(env, w.org.id, 'reserve');
		const old = await grantEntry(env, list, {
			steamId: STEAM,
			reason: 'Annual PAID membership',
			expiresAt: new Date('2026-10-01T00:00:00Z'),
			addedByName: 'admin'
		});
		const attempted = await grantEntry(
			env,
			list,
			{
				steamId: STEAM,
				reason: 'new seed reward',
				expiresAt: new Date('2026-10-08T00:00:00Z'),
				addedByName: 'trigger: Seeders'
			},
			{ replaceExisting: true, protectedNoteWord: 'paid' }
		);

		expect(attempted).toMatchObject({
			id: old.id,
			added: false,
			replaced: false,
			protected: true
		});
		const rows = await env.db.select().from(listEntries).where(eq(listEntries.listId, list.id));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: old.id,
			reason: 'Annual PAID membership',
			removedAt: null
		});
	});

	test('does not queue or consume a reward when the existing note is protected', async () => {
		const w = await seedWorld(env);
		await ensureOrgLists(env.db, w.org.id);
		const list = await listOf(env, w.org.id, 'reserve');
		await grantEntry(env, list, {
			steamId: STEAM,
			reason: 'Paid supporter',
			expiresAt: new Date('2026-10-01T00:00:00Z'),
			addedByName: 'admin'
		});
		const config = validateConfig('seed_reward', {
			minutes: 60,
			lowAt: 1,
			untilFull: true,
			fullAt: 2,
			scope: 'org',
			replaceExisting: true,
			protectedNoteWord: 'paid'
		});
		const [row] = await env.db
			.insert(triggers)
			.values({
				id: newId(),
				serverId: w.server.id,
				orgId: w.org.id,
				kind: 'seed_reward',
				name: 'Seeders',
				enabled: true,
				config
			})
			.returning();
		const player = { steamId: STEAM, name: 'Seeder' };
		const filler = { steamId: '76561198000000043', name: 'Filler' };
		const at = Date.now();
		const context = (players: (typeof player)[], seedMinutes: number, now: number): TickContext =>
			({
				server: { id: w.server.id, orgId: w.org.id, name: 'One' },
				status: { maxPlayers: 100, serverName: 'One', playerCount: players.length },
				players,
				reserved: new Set([STEAM]),
				reservedLoaded: true,
				seedMs: new Map([[STEAM, seedMinutes * 60_000]]),
				ts: new Date(now)
			}) as TickContext;

		await evaluateTriggers(env, context([player], 0, at), [row]);
		const filled = await evaluateTriggers(env, context([player, filler], 60, at + 60_000), [row]);
		expect(filled.intents.filter((i) => i.action === 'seed_reward')).toHaveLength(0);
		expect(
			(row.state as { players: Record<string, { balance: number }> }).players[STEAM].balance
		).toBe(3600);
	});

	test('carries partial seed time across game starts and resets it after a reward', async () => {
		const w = await seedWorld(env);
		const config = validateConfig('seed_reward', {
			minutes: 60,
			lowAt: 1,
			untilFull: true,
			fullAt: 2,
			scope: 'server',
			replaceExisting: true
		});
		const [row] = await env.db
			.insert(triggers)
			.values({
				id: newId(),
				serverId: w.server.id,
				orgId: w.org.id,
				kind: 'seed_reward',
				name: 'Seeders',
				enabled: true,
				config
			})
			.returning();
		const player = { steamId: STEAM, name: 'Seeder' };
		const filler = { steamId: '76561198000000043', name: 'Filler' };
		const at = Date.now();
		const context = (players: (typeof player)[], seedMinutes: number, now: number): TickContext =>
			({
				server: { id: w.server.id, orgId: w.org.id, name: 'One' },
				status: { maxPlayers: 100, serverName: 'One', playerCount: players.length },
				players,
				reserved: new Set([STEAM]),
				reservedLoaded: true,
				seedMs: new Map([[STEAM, seedMinutes * 60_000]]),
				ts: new Date(now)
			}) as TickContext;

		await evaluateTriggers(env, context([player], 0, at), [row]);
		const firstStart = await evaluateTriggers(env, context([player, filler], 30, at + 60_000), [
			row
		]);
		expect(firstStart.intents.filter((i) => i.action === 'seed_reward')).toHaveLength(0);

		await evaluateTriggers(env, context([player], 30, at + 120_000), [row]);
		const secondStart = await evaluateTriggers(env, context([player, filler], 60, at + 180_000), [
			row
		]);
		expect(secondStart.intents.filter((i) => i.action === 'seed_reward')).toHaveLength(1);
		expect(
			(row.state as { players: Record<string, { balance: number }> }).players[STEAM].balance
		).toBe(0);

		await evaluateTriggers(env, context([player], 60, at + 240_000), [row]);
		const noNewTime = await evaluateTriggers(env, context([player, filler], 60, at + 300_000), [
			row
		]);
		expect(noNewTime.intents.filter((i) => i.action === 'seed_reward')).toHaveLength(0);
	});
});
