// An action queued for a player who is off the player list but whose session is still open (the
// list empties for half a minute at a map change) waits for them instead of being dropped as
// "already left"; it is skipped once the session closes.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { organizations, outbox, servers } from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor } from '$lib/server/observe';
import { startDelivery, stopDelivery } from '$lib/server/outbox';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const AWAY = '76561198000000701';

describe.skipIf(!hasTestDb)('delivery while the player list is empty', () => {
	let env: Env;
	let w: World;

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		w = await seedWorld(env);
		expect(await acquireOrRenew(env, 'delivery-wait')).toBe(true);
	});

	afterAll(async () => {
		stopDelivery();
		forgetMemory(w.server.id);
		await releaseOwnership(env);
	});

	const rowOf = async (id: number) =>
		(await env.db.select().from(outbox).where(eq(outbox.id, id)))[0];
	const until = async (ok: () => Promise<boolean>) => {
		for (let i = 0; i < 100 && !(await ok()); i++) await Bun.sleep(50);
	};

	test('waits while the session is open, and is skipped once it closes', async () => {
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		const m = memoryFor(server, org);
		// the list is empty (a map loading); AWAY's session is still open, inside the grace
		m.players = [];
		m.playersAt = Date.now();
		m.presence.loaded = true;
		m.presence.open.set(AWAY, {
			id: 1,
			steamId: AWAY,
			name: 'Away',
			hiddenName: null,
			anonymous: false,
			faction: null,
			kills: 0,
			deaths: 0,
			cash: 0,
			game: null,
			seedMs: 0,
			pendingSeedMs: 0,
			joinedAt: Date.now() - 60_000,
			lastSeen: Date.now() - 5000,
			writtenAt: Date.now() - 5000,
			writtenTeam: null,
			writtenMode: '0:',
			firstVisit: false,
			lastFaction: null,
			team: null
		});
		const [row] = await env.db
			.insert(outbox)
			.values({
				serverId: w.server.id,
				triggerName: 'Team kill',
				triggerKind: 'team_kill',
				action: 'kick',
				params: { steamId: AWAY, reason: 'team killing' },
				target: AWAY,
				steamId: AWAY,
				okMessage: 'Kicked.',
				dedupeKey: `wait-${AWAY}`
			})
			.returning({ id: outbox.id });
		startDelivery(env);
		await until(async () => (await rowOf(row.id)).attempts > 0);
		await Bun.sleep(200);
		const waiting = await rowOf(row.id);
		expect(waiting.state).toBe('pending');
		expect(waiting.notBefore.getTime()).toBeGreaterThan(Date.now());

		// the grace passes: the session closes, and the row is skipped at its next claim
		m.presence.open.delete(AWAY);
		await env.db.update(outbox).set({ notBefore: new Date() }).where(eq(outbox.id, row.id));
		await until(async () => (await rowOf(row.id)).state === 'skipped');
		const done = await rowOf(row.id);
		expect([done.state, done.outcome]).toEqual(['skipped', 'Player already left.']);
	});
});
