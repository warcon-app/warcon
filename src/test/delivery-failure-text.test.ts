// A row the panel itself fails on (a failed query, a bug: anything that is not the game's answer
// or the panel's own refusal) is stored with a fixed phrase, and the error goes to the log without
// a failed query's parameters. The outcome is read in Recent actions, the audit trail and Discord.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { and, eq, sql } from 'drizzle-orm';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { Env } from '$lib/server/env';
import { auditLog, organizations, outbox, servers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor } from '$lib/server/observe';
import { startDelivery, stopDelivery, wakeDelivery } from '$lib/server/outbox';
import { WardogsClient } from '$lib/server/rcon';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const PLAYER = '76561198000000801';
const REASON = 'Fixture reason text';

describe.skipIf(!hasTestDb)('an outbox row the panel fails on', () => {
	let env: Env;
	let w: World;
	const logged: string[] = [];
	const saved = console.error;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'delivery-failure-text')).toBe(true);
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		memoryFor(server, org);
		console.error = (...args: unknown[]) =>
			void logged.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' '));
		startDelivery(env);
	});

	afterAll(async () => {
		console.error = saved;
		stopDelivery();
		forgetMemory(w.server.id);
		await releaseOwnership(env);
	});

	const rowOf = async (id: number) =>
		(await env.db.select().from(outbox).where(eq(outbox.id, id)))[0];
	/** The row once delivery is done with it. */
	const settled = async (id: number) => {
		wakeDelivery();
		for (let i = 0; i < 100; i++) {
			const row = await rowOf(id);
			if (row.state !== 'pending' && row.state !== 'sending') return row;
			await Bun.sleep(50);
		}
		return rowOf(id);
	};
	const queue = async (action: string, params: Record<string, unknown>) =>
		(
			await env.db
				.insert(outbox)
				.values({
					serverId: w.server.id,
					triggerName: 'Fixture rule',
					triggerKind: action === 'seed_reward' ? 'seed_reward' : 'broadcast',
					action,
					params,
					target: PLAYER,
					okMessage: 'Done.',
					dedupeKey: `failure-${action}`
				})
				.returning({ id: outbox.id })
		)[0].id;

	test('a game action that fails in the panel', async () => {
		const spy = spyOn(WardogsClient, 'forServer').mockImplementation(async () => {
			throw new DrizzleQueryError(
				'select "notes" from "players" where "steam_id" = $1',
				[PLAYER, REASON],
				new Error('canceling statement due to statement timeout')
			);
		});
		try {
			const id = await queue('broadcast', { message: 'Fixture broadcast' });
			const done = await settled(id);
			expect([done.state, done.outcome]).toEqual(['failed', 'The panel failed while sending it.']);
			const [audit] = await env.db
				.select({ message: auditLog.message })
				.from(auditLog)
				.where(and(eq(auditLog.serverId, w.server.id), eq(auditLog.action, 'trigger.broadcast')));
			expect(audit.message).toBe('The panel failed while sending it.');
		} finally {
			spy.mockRestore();
		}
		const text = logged.join('\n');
		expect(text).not.toContain(PLAYER);
		expect(text).not.toContain(REASON);
		expect(text).toContain('statement timeout');
	});

	test('a Seeding reward whose slot cannot be written', async () => {
		// The database refuses the slot: a real failed query, its parameters the player and the reason.
		await env.db.execute(sql`
			CREATE FUNCTION fixture_refuse() RETURNS trigger LANGUAGE plpgsql AS
			$$ BEGIN RAISE EXCEPTION 'fixture refusal'; END $$`);
		await env.db.execute(sql`
			CREATE TRIGGER fixture_refuse BEFORE INSERT ON list_entries
			FOR EACH ROW EXECUTE FUNCTION fixture_refuse()`);
		try {
			logged.length = 0;
			const id = await queue('seed_reward', {
				steamId: PLAYER,
				name: 'Fixture seeder',
				reason: REASON,
				slotDays: 3,
				scope: 'server'
			});
			const done = await settled(id);
			expect([done.state, done.outcome]).toEqual(['failed', 'Could not write the reserved slot.']);
		} finally {
			await env.db.execute(sql`DROP TRIGGER fixture_refuse ON list_entries`);
			await env.db.execute(sql`DROP FUNCTION fixture_refuse()`);
		}
		const text = logged.join('\n');
		expect(text).not.toContain(PLAYER);
		expect(text).not.toContain(REASON);
		expect(text).toContain('fixture refusal');
	});
});
