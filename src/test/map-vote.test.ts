// The Map vote rule end to end: the worker's looks at a stand-in game (the demo's rotation and
// config document, with the scores, the players and the chat of the test's own), the outbox
// delivering what the rule queues, and the routes that save it.
//
// What the suite holds the panel to:
//   - a vote opens only once the chat is being read and the leader reaches the rule's score; its
//     options are said from the rotation; votes typed in chat count, a player's last one; the
//     winner is put next and said; a new match leaves the vote behind;
//   - who voted for what is kept nowhere: no outbox row, audit row or rule row names a voter, and
//     no table holds a word of the chat;
//   - a rule is saved only by someone who holds Read chat, Chat and Config & settings as well as
//     Automation, which no API key can; one a server; its numbers are words a Chat command may not
//     take while it is on.
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { SessionUser } from '$lib/server/access';
import {
	auditLog,
	organizations,
	orgRoles,
	outbox,
	servers,
	triggers
} from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer, type ServerMemory } from '$lib/server/observe';
import { chatMemoryOf, forgetChat } from '$lib/server/chat-look';
import { forgetVotes, voteOf } from '$lib/server/map-vote';
import { startDelivery, stopDelivery } from '$lib/server/outbox';
import { WardogsClient } from '$lib/server/rcon';
import { readConfig } from '$lib/server/actions';
import { invalidateTriggers } from '$lib/server/triggers';
import { settings } from '$lib/server/settings';
import { rotationIntoText } from '$lib/rotation-doc';
import type { Capability } from '$lib/capabilities';
import type { MapSelection, TriggerView } from '$lib/types';
import { callApi, stubGateway } from './call';
import { hasTestDb, testEnv } from './db';
import { seedWorld, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
const A = '76561198000000911';
const B = '76561198000000912';
const C = '76561198000000913';
const D = '76561198000000914';
const VOTERS = [A, B, C, D];
/** a word only the chat carries */
const MARK = `mv${Math.random().toString(36).slice(2, 10)}`;

const ROTATION: MapSelection[] = [
	{ map: 'Kavkazi', experiences: ['Bakurani_KOTH_01'], lighting: 'DayClear', zoneAlternator: '' },
	{ map: 'Europe', experiences: ['Madrid_KOTH_01'], lighting: 'DayClear', zoneAlternator: '' },
	{
		map: 'NorthAmerica',
		experiences: ['Detroit_KOTH_01'],
		lighting: 'DayClear',
		zoneAlternator: ''
	},
	{ map: 'Russia', experiences: ['Moscow_KOTH_01'], lighting: 'DayClear', zoneAlternator: '' }
];

const until = async (ok: () => Promise<boolean>, ms = 20_000) => {
	const end = Date.now() + ms;
	while (!(await ok())) {
		if (Date.now() > end) throw new Error('timed out waiting for the delivery loop');
		await Bun.sleep(25);
	}
};

/** One game as the stand-in keeps it, beside what the demo keeps (its rotation and document). */
interface Game {
	leading: number;
	seq: number;
	lines: Record<string, unknown>[];
	said: string[];
	chatReads: number;
}

describe.skipIf(!hasTestDb)('Map vote, live', () => {
	let env: Env;
	let spy: ReturnType<typeof spyOn>;
	let renewing: ReturnType<typeof setInterval>;
	const games = new Map<string, Game>();
	const game = (serverId: string): Game => {
		let g = games.get(serverId);
		if (!g) games.set(serverId, (g = { leading: 40, seq: 0, lines: [], said: [], chatReads: 0 }));
		return g;
	};
	const demoOf = (serverId: string) =>
		new WardogsClient(
			env,
			{ id: serverId, host: 'demo', port: 1, scheme: 'http' },
			'demo',
			`map-vote-${serverId}`
		);
	const watched = new Set<string>();

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		stubGateway();
		expect(await acquireOrRenew(env, 'map vote test')).toBe(true);
		// the suite outlasts one lease: kept as a worker keeps it
		renewing = setInterval(() => void acquireOrRenew(env, 'map vote test'), 5000);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = demoOf(server.id);
			const raw = client.raw.bind(client);
			const g = game(server.id);
			const answer = (status: number, body: unknown) => ({
				status,
				statusText: 'OK',
				headers: { 'content-type': 'application/json' },
				text: JSON.stringify(body)
			});
			client.raw = async (method, path, body, headers) => {
				if (method === 'GET' && path === '/v1/players')
					return answer(200, {
						players: VOTERS.map((steamId, i) => ({
							name: `Player ${i + 1}`,
							steamId,
							faction: i % 2 ? 'Lonestar' : 'Valkyra',
							kills: 0,
							deaths: 0,
							cash: 0,
							pingMs: 40
						}))
					});
				if (method === 'GET' && path.startsWith('/v1/status')) {
					// the demo's map and rotation place, with the scores the test sets
					const res = await raw(method, path, body, headers);
					const s = JSON.parse(res.text);
					return answer(200, {
						...s,
						players: { current: VOTERS.length, max: 98 },
						factionScores: [
							{ name: 'Valkyra', colorHex: '#888888', score: g.leading },
							{ name: 'Lonestar', colorHex: '#888888', score: Math.floor(g.leading / 2) }
						]
					});
				}
				if (method === 'GET' && path.startsWith('/v1/chat?')) {
					g.chatReads++;
					const q = new URLSearchParams(path.split('?')[1]);
					const after = Number(q.get('after'));
					const messages = g.lines
						.filter((l) => (l.seq as number) > after)
						.slice(0, Number(q.get('limit')));
					return answer(200, { latestSeq: g.seq, messages, count: messages.length });
				}
				if (method === 'POST' && path === '/v1/broadcast')
					g.said.push(JSON.parse(body ?? '{}').message);
				return raw(method, path, body, headers);
			};
			return client;
		});
	});

	afterAll(async () => {
		clearInterval(renewing);
		await stopDelivery();
		for (const id of watched) forgetMemory(id);
		forgetChat();
		forgetVotes();
		spy.mockRestore();
		await releaseOwnership(env);
	});
	afterEach(() => stopDelivery());

	const route = async (method: string, path: string) =>
		(await import(join(ROUTES, path, '+server.ts')))[method];
	/** A rule saved through the route the panel calls. */
	const save = async (
		w: World,
		kind: 'map_vote' | 'chat_command',
		config: Record<string, unknown>,
		{ who = w.users.owner as SessionUser | null, enabled = true } = {}
	) =>
		callApi(await route('POST', 'api/servers/[id]/triggers'), who, {
			method: 'POST',
			params: { id: w.server.id },
			body: { kind, enabled, config }
		});
	/** The worker's memory of a server, fresh. */
	const memoryOf = async (w: World): Promise<ServerMemory> => {
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		forgetMemory(server.id);
		forgetChat(server.id);
		watched.add(server.id);
		return memoryFor(server, org);
	};
	/** The worker's next look, a little over the chat interval after the last. */
	const look = async (m: ServerMemory) => {
		const mem = chatMemoryOf(m.server.id);
		if (mem) mem.readAt -= settings().chatMs + 100;
		invalidateTriggers(m.server.id);
		await observeServer(env, m, { status: true, players: true });
	};
	/** A player typing a line in the game's chat. */
	const say = (w: World, steamId: string, text: string) => {
		const g = game(w.server.id);
		g.lines.push({
			seq: ++g.seq,
			sentUtc: new Date().toISOString(),
			channel: 'Global',
			faction: 'RED',
			steamId,
			realName: `Real ${MARK}`,
			hiddenName: `Amber ${MARK}`,
			anonymous: false,
			text,
			rawText: text,
			ping: false
		});
	};
	const rowsOf = (ruleId: string) =>
		env.db.select().from(outbox).where(eq(outbox.triggerId, ruleId)).orderBy(outbox.id);
	/** The row once delivery has done with it. */
	const done = async (rowId: number) => {
		startDelivery(env);
		await until(async () => {
			const [r] = await env.db.select().from(outbox).where(eq(outbox.id, rowId));
			return r.doneAt !== null;
		});
		return (await env.db.select().from(outbox).where(eq(outbox.id, rowId)))[0];
	};
	const ruleRow = async (id: string) =>
		(await env.db.select().from(triggers).where(eq(triggers.id, id)))[0];
	/** The demo's rotation set through its document, the server on its first entry. */
	async function setRotation(serverId: string, entries: MapSelection[]) {
		const demo = demoOf(serverId);
		const doc = await readConfig(demo);
		const text = rotationIntoText(doc.text, { enabled: true, mode: 'ordered', entries });
		expect((await demo.configCall('PUT', '/v1/config', text, doc.revision)).status).toBe(200);
	}
	const liveRotation = (serverId: string) =>
		demoOf(serverId).json('GET', '/v1/rotation') as Promise<{
			entries: (MapSelection & { status: string })[];
		}>;
	/** Every row of every table of the panel, as text. */
	const everything = async (): Promise<string> => {
		const tables = await env.sql<{ tablename: string }[]>`
			SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
		let out = '';
		for (const { tablename } of tables) {
			const rows = await env.sql.unsafe(`SELECT row_to_json(t)::text AS row FROM "${tablename}" t`);
			for (const r of rows) out += (r as { row: string }).row + '\n';
		}
		return out;
	};

	test('a vote end to end: opened at the score, votes counted, the winner next and said', async () => {
		const w = await seedWorld(env);
		await setRotation(w.server.id, ROTATION);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const made = await save(w, 'map_vote', { minPlayers: 2, startAt: 90, seconds: 60 });
		expect([made.status, made.message]).toEqual([201, '']);
		const id = (made.body as { trigger: TriggerView }).trigger.id;

		// Well under the score the chat is not read for the rule at all.
		await look(m);
		await look(m);
		expect(g.chatReads).toBe(0);
		expect(await rowsOf(id)).toEqual([]);
		// A few points short of it, it is, and the row says so; still nothing opens.
		g.leading = 86;
		await look(m);
		await look(m);
		expect((await ruleRow(id)).state).toEqual({ wait: '' });
		expect(g.chatReads).toBeGreaterThan(0);
		expect(await rowsOf(id)).toEqual([]);

		// The leader reaches the score: one opening queued, and sent with the rotation's maps.
		g.leading = 91;
		await look(m);
		await look(m);
		const opening = await rowsOf(id);
		expect(opening.map((r) => [r.action, r.state, r.target])).toEqual([
			['map_vote_open', 'pending', 'Bakurani']
		]);
		const sent = await done(opening[0].id);
		expect([sent.state, sent.outcome]).toEqual([
			'delivered',
			'Vote open for 60 s: Ozeti, Zestafona, Sabatulo.'
		]);
		expect(g.said).toEqual([
			'Next map vote (60 s). Type in chat: !1 Ozeti · !2 Zestafona · !3 Sabatulo'
		]);
		expect(voteOf(w.server.id)?.phase).toBe('open');

		// Votes in chat: a player's last one counts; anything else is no vote.
		say(w, A, '!3');
		say(w, B, '!2');
		say(w, C, '!2');
		say(w, A, '!2');
		say(w, D, `${MARK} I want 1`);
		say(w, D, '!9');
		await look(m);
		expect([...voteOf(w.server.id)!.ballots.entries()].sort()).toEqual([
			[A, 2],
			[B, 2],
			[C, 2]
		]);

		// Halfway, the votes so far are said.
		const v = voteOf(w.server.id)!;
		v.openedAt = Date.now() - 40_000;
		v.closesAt = Date.now() + 20_000;
		await look(m);
		const tally = (await rowsOf(id)).filter((r) => r.action === 'broadcast');
		expect(tally.map((r) => r.target)).toEqual([
			'Votes so far: !1 Ozeti 0 · !2 Zestafona 3 · !3 Sabatulo 0'
		]);
		await done(tally[0].id);

		// Its time up: Zestafona is put next, and said.
		v.closesAt = Date.now() - 1;
		await look(m);
		const result = (await rowsOf(id)).filter((r) => r.action === 'map_vote');
		// (delivery is running by now, so it may already be on its way)
		expect(result.map((r) => r.target)).toEqual(['Zestafona']);
		const applied = await done(result[0].id);
		expect([applied.state, applied.outcome]).toEqual([
			'delivered',
			'Zestafona won with 3 of 3 votes and is next; said to the server.'
		]);
		expect(g.said.at(-1)).toBe('Zestafona won the vote (3 of 3) and plays next.');
		// the rule's row says it too, a moment after the delivery is recorded
		await until(async () => (await ruleRow(id)).lastResult === applied.outcome);
		// the vote holds nobody once it closes, and the chat is not read for it any more
		expect(voteOf(w.server.id)?.ballots.size).toBe(0);
		const reads = g.chatReads;
		await look(m);
		expect(g.chatReads).toBe(reads);

		// Who voted for what is nowhere: not in the rule's rows, its audit rows or its own row.
		const kept = JSON.stringify([
			await rowsOf(id),
			await env.db
				.select()
				.from(auditLog)
				.where(and(eq(auditLog.serverId, w.server.id), eq(auditLog.category, 'trigger'))),
			await ruleRow(id)
		]);
		for (const voter of VOTERS) expect(kept).not.toContain(voter);
		// and no table holds a word of the chat
		expect(await everything()).not.toContain(MARK);
	}, 60_000);

	test('the winner swaps places with the entry next, and comes up at the next match', async () => {
		const w = await seedWorld(env);
		await setRotation(w.server.id, ROTATION);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const made = await save(w, 'map_vote', { minPlayers: 2, seconds: 60, tallyMessage: '' });
		const id = (made.body as { trigger: TriggerView }).trigger.id;
		await look(m);
		g.leading = 87;
		await look(m);
		g.leading = 95;
		await look(m);
		await done((await rowsOf(id))[0].id);
		say(w, A, '!3');
		say(w, B, '!3');
		say(w, C, '!1');
		await look(m);
		voteOf(w.server.id)!.closesAt = Date.now() - 1;
		await look(m);
		const [row] = (await rowsOf(id)).filter((r) => r.action === 'map_vote');
		const applied = await done(row.id);
		expect(applied.outcome).toBe('Sabatulo won with 2 of 3 votes and is next; said to the server.');
		// counts for each map on the row, never who cast them
		expect(row.detail).toEqual({
			map: 'Kavkazi',
			total: 3,
			tied: false,
			votes: [
				{ map: 'Europe', votes: 1 },
				{ map: 'NorthAmerica', votes: 0 },
				{ map: 'Russia', votes: 2 }
			]
		});
		const rotation = await liveRotation(w.server.id);
		expect(rotation.entries.map((e) => [e.map, e.status])).toEqual([
			['Kavkazi', 'now'],
			['Russia', 'next'],
			['NorthAmerica', ''],
			['Europe', '']
		]);
		// The match ends: Sabatulo comes up, and the vote is left behind.
		await demoOf(w.server.id).json('POST', '/v1/match/end');
		g.leading = 0;
		await look(m);
		expect((await liveRotation(w.server.id)).entries.find((e) => e.status === 'now')?.map).toBe(
			'Russia'
		);
		expect(voteOf(w.server.id)).toBeUndefined();
	}, 60_000);

	test('no votes: the rotation goes on as it was, and the rule says so', async () => {
		const w = await seedWorld(env);
		await setRotation(w.server.id, ROTATION);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const made = await save(w, 'map_vote', { minPlayers: 2, seconds: 60, minVotes: 2 });
		const id = (made.body as { trigger: TriggerView }).trigger.id;
		await look(m);
		g.leading = 87;
		await look(m);
		g.leading = 92;
		await look(m);
		await done((await rowsOf(id))[0].id);
		// the message for too few votes waits in the outbox while the rule's row is read
		await stopDelivery();
		say(w, A, '!1');
		await look(m);
		voteOf(w.server.id)!.closesAt = Date.now() - 1;
		await look(m);
		const rows = await rowsOf(id);
		expect(rows.map((r) => r.action)).toEqual(['map_vote_open', 'broadcast']);
		expect(rows[1].target).toBe('No votes for the next map: the rotation goes on as planned.');
		expect((await ruleRow(id)).lastResult).toBe(
			'No result on Bakurani (1 vote, 2 needed): the rotation goes on as it was.'
		);
		expect((await liveRotation(w.server.id)).entries.map((e) => e.map)).toEqual(
			ROTATION.map((e) => e.map)
		);
	}, 60_000);

	test('switched off while the winner waits to be sent: nothing is sent', async () => {
		const w = await seedWorld(env);
		await setRotation(w.server.id, ROTATION);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const made = await save(w, 'map_vote', { minPlayers: 2, seconds: 60 });
		const id = (made.body as { trigger: TriggerView }).trigger.id;
		await look(m);
		g.leading = 87;
		await look(m);
		g.leading = 92;
		await look(m);
		await done((await rowsOf(id))[0].id);
		// nothing more is sent until the rule has been switched off
		await stopDelivery();
		say(w, A, '!3');
		await look(m);
		voteOf(w.server.id)!.closesAt = Date.now() - 1;
		await look(m);
		const off = await callApi(
			await route('PATCH', 'api/servers/[id]/triggers/[triggerId]'),
			w.users.owner,
			{
				method: 'PATCH',
				params: { id: w.server.id, triggerId: id },
				body: { enabled: false }
			}
		);
		expect(off.status).toBe(200);
		const [row] = (await rowsOf(id)).filter((r) => r.action === 'map_vote');
		expect([row.state, row.outcome]).toEqual([
			'skipped',
			'The rule was changed before this was sent.'
		]);
		expect((await liveRotation(w.server.id)).entries.map((e) => e.map)).toEqual(
			ROTATION.map((e) => e.map)
		);
		// and the next look forgets who voted
		await look(m);
		expect(voteOf(w.server.id)).toBeUndefined();
	}, 60_000);

	test('a worker that starts over with the score past opens no second vote that match', async () => {
		const w = await seedWorld(env);
		await setRotation(w.server.id, ROTATION);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const made = await save(w, 'map_vote', { minPlayers: 2, seconds: 60 });
		const id = (made.body as { trigger: TriggerView }).trigger.id;
		const openings = async () =>
			(await rowsOf(id)).filter((r) => r.action === 'map_vote_open').length;
		g.leading = 86;
		await look(m);
		g.leading = 91;
		await look(m);
		expect(await openings()).toBe(1);
		// a deploy: the worker that comes up remembers nothing of the server
		forgetVotes();
		const fresh = await memoryOf(w);
		g.leading = 93;
		await look(fresh);
		await look(fresh);
		expect(await openings()).toBe(1);
		// the next match has its vote, once its leader passes the score
		await demoOf(w.server.id).json('POST', '/v1/match/end');
		g.leading = 0;
		await look(fresh);
		g.leading = 86;
		await look(fresh);
		g.leading = 90;
		await look(fresh);
		expect(await openings()).toBe(2);
	}, 60_000);

	describe('who may save one', () => {
		/** an owner sets the admin role's capabilities, as on the Roles tab */
		const adminHolds = async (w: World, drop: Capability[], add: Capability[]) => {
			const [row] = await env.db.select().from(orgRoles).where(eq(orgRoles.id, w.roles.admin));
			const keep = (row.capabilities as Capability[]).filter((c) => !drop.includes(c));
			const { PATCH } = await import(join(ROUTES, 'api/orgs/[id]/roles/[roleId]', '+server.ts'));
			const res = await callApi(PATCH, w.users.owner, {
				method: 'PATCH',
				params: { id: w.org.id, roleId: w.roles.admin },
				body: { capabilities: [...keep, ...add] }
			});
			expect(res.status).toBe(200);
		};

		test('Automation, Read chat, Chat and Config & settings; never a key; one a server', async () => {
			const w = await seedWorld(env);
			const create = async (who: SessionUser | null) => {
				const res = await save(w, 'map_vote', {}, { who, enabled: false });
				return [res.status, res.code, res.message];
			};
			// the preview is held to the same: it shows what the rule would say
			const preview = async (who: SessionUser | null) =>
				(
					await callApi(await route('POST', 'api/servers/[id]/triggers/dry-run'), who, {
						method: 'POST',
						params: { id: w.server.id },
						body: { kind: 'map_vote', config: {} }
					})
				).status;
			expect(await preview(null)).toBe(401);
			expect(await preview(w.users.outsider)).toBe(404);
			expect(await preview(w.users.keyAll)).toBe(403);
			expect((await create(null)).slice(0, 2)).toEqual([401, 'unauthenticated']);
			expect((await create(w.users.outsider)).slice(0, 2)).toEqual([404, 'not_found']);
			expect((await create(w.users.elsewhere)).slice(0, 2)).toEqual([404, 'not_found']);
			expect((await create(w.users.viewer)).slice(0, 2)).toEqual([403, 'forbidden']);
			expect((await create(w.users.operator)).slice(0, 2)).toEqual([403, 'forbidden']);
			// the built-in admin holds everything but Read chat
			const admin = await create(w.users.admin);
			expect(admin.slice(0, 2)).toEqual([403, 'forbidden']);
			expect(admin[2]).toContain("needs 'Read chat'");
			// a key over everything holds no capability that is a person's
			const key = await create(w.users.keyAll);
			expect(key.slice(0, 2)).toEqual([403, 'forbidden']);
			expect(key[2]).toContain("needs 'Read chat'");
			expect((await create(w.users.keyView)).slice(0, 2)).toEqual([403, 'forbidden']);
			// Read chat without Chat, and Read chat and Chat without Config & settings: not enough
			await adminHolds(w, ['chat.send'], ['chat.read']);
			expect((await create(w.users.admin))[2]).toContain("needs 'Chat'");
			await adminHolds(w, ['config.apply'], ['chat.read', 'chat.send']);
			expect((await create(w.users.admin))[2]).toContain("needs 'Config & settings'");
			expect(await preview(w.users.admin)).toBe(403);
			expect(
				await env.db.select().from(triggers).where(eq(triggers.serverId, w.server.id))
			).toEqual([]);
			await adminHolds(w, [], ['chat.read', 'chat.send', 'config.apply']);
			expect(await preview(w.users.admin)).toBe(200);
			expect((await create(w.users.admin)).slice(0, 2)).toEqual([201, '']);
			// one a server
			const second = await create(w.users.owner);
			expect(second.slice(0, 2)).toEqual([409, 'duplicate']);
		});

		test('its numbers are words: a Chat command may not take one while it is on', async () => {
			const w = await seedWorld(env);
			expect((await save(w, 'map_vote', { options: 3 })).status).toBe(201);
			const two = await save(w, 'chat_command', { command: '2', replies: 'two' });
			expect([two.status, two.code]).toEqual([409, 'duplicate']);
			expect(two.message).toContain('!2 is already answered by the rule "Map vote"');
			expect((await save(w, 'chat_command', { command: '4', replies: 'four' })).status).toBe(201);
		});
	});
});
