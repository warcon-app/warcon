// The chat rules as the worker runs them, against the database and a stand-in game: on a server
// with a Chat command or a Staff call switched on, the worker reads the chat after its look and
// answers the lines that are commands of that server, in the same look. A reply is a whisper or a
// broadcast; a staff call is a card on the organisation's Discord and a whisper back.
//
// What the suite holds the panel to:
//   - a server without a chat rule has its chat read by nobody;
//   - nothing typed before the worker knew where the chat stood is ever answered (a start, a
//     takeover, a rule switched on, a late read, a game numbering anew, a game whose word of its
//     newest line cannot be so), and nothing twice;
//   - a player is told a call is on its way to staff only when a webhook is there to take it;
//   - nothing a player types is kept: no outbox row, no audit row, no word of a line in any table,
//     and no row saying who used a command;
//   - a rule is saved, changed, switched on and previewed only by someone who holds Read chat as
//     well as Automation and Chat, which no API key does.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { and, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { SessionUser } from '$lib/server/access';
import {
	auditLog,
	organizations,
	orgRoles,
	outbox,
	servers,
	triggers,
	webhooks
} from '$lib/server/db/schema';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, observeServer, type ServerMemory } from '$lib/server/observe';
import { chatMemoryOf, forgetChat } from '$lib/server/chat-look';
import { CHAT_SENDS_PER_LOOK } from '$lib/server/chat-rules';
import { WardogsClient } from '$lib/server/rcon';
import { invalidateTriggers } from '$lib/server/triggers';
import { encryptSecret } from '$lib/server/crypto';
import { newId } from '$lib/server/http';
import { resetWebhookQueues, WEBHOOK_EVENTS } from '$lib/server/webhook-delivery';
import { JSON_WEBHOOK_EVENTS } from '$lib/server/json-webhook-events';
import { resetSetting, saveSettings, settings } from '$lib/server/settings';
import type { Capability } from '$lib/capabilities';
import type { DryRunResult, TriggerView } from '$lib/types';
import { callApi, callLoad, stubGateway } from './call';
import { hasTestDb, testEnv } from './db';
import { seedWorld, suspend, type World } from './world';

const ROUTES = join(import.meta.dir, '..', 'routes');
const A = '76561198000000811';
const B = '76561198000000812';
const C = '76561198000000813';
/** a player whose name is markdown, a mention and a link: on only where a test puts them on */
const D = '76561198000000814';
const NAMES: Record<string, string> = {
	[A]: 'Night Owl',
	[B]: 'Kova',
	[C]: 'Brick',
	[D]: '**@everyone** [free skins](https://evil.example)'
};
const SIDES: Record<string, string> = {
	[A]: 'Valkyra',
	[B]: 'Lonestar',
	[C]: 'Lonestar',
	[D]: 'Valkyra'
};

/** One game as the stand-in keeps it. */
interface Game {
	on: string[];
	seq: number;
	lines: Record<string, unknown>[];
	/** the game says what its newest line is (`latestSeq`); 'page': it says the newest of the
	 *  lines it sends with it instead, and 0 with none; 'zero': it says 0 whatever it holds */
	latest: boolean | 'page' | 'zero';
	/** how the chat read answers: 200, or the status it fails with */
	chat: number;
	/** the build lists the chat routes */
	served: boolean;
	whispers: [string, string][];
	broadcasts: string[];
	/** what each player's whisper is answered with, when not 200 */
	refuse: Map<string, number>;
	chatReads: string[];
	rotationReads: number;
}

describe.skipIf(!hasTestDb)('Chat rules, live', () => {
	let env: Env;
	let spy: ReturnType<typeof spyOn>;
	let renewing: ReturnType<typeof setInterval>;
	const games = new Map<string, Game>();
	const game = (serverId: string): Game => {
		let g = games.get(serverId);
		if (!g)
			games.set(
				serverId,
				(g = {
					on: [A, B, C],
					seq: 0,
					lines: [],
					latest: true,
					chat: 200,
					served: true,
					whispers: [],
					broadcasts: [],
					refuse: new Map(),
					chatReads: [],
					rotationReads: 0
				})
			);
		return g;
	};
	/** what reached the Discord webhook that takes Staff calls: each card's title and body */
	const cards: { title: string; description: string }[] = [];
	/** every request the process sent out, to Discord or anywhere else */
	const out: { url: string; body: string }[] = [];
	const STAFF_HOOK = 'https://discord.test/api/webhooks/1/staff';
	const OTHER_HOOK = 'https://discord.test/api/webhooks/2/everything-else';
	/** a webhook its owner deleted in Discord */
	const GONE_HOOK = 'https://discord.test/api/webhooks/3/gone';
	const realFetch = globalThis.fetch;
	const watched = new Set<string>();

	beforeAll(async () => {
		env = { ...(await testEnv()), STEAM_API_KEY: '' };
		stubGateway();
		expect(await acquireOrRenew(env, 'chat rules test')).toBe(true);
		// the suite outlasts one lease: kept as a worker keeps it
		renewing = setInterval(() => void acquireOrRenew(env, 'chat rules test'), 5000);
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`chatrules-${server.id}`
			);
			const raw = client.raw.bind(client);
			const g = game(server.id);
			const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
				status,
				statusText: status === 200 ? 'OK' : 'Refused',
				headers: { 'content-type': 'application/json', ...headers },
				text: JSON.stringify(body)
			});
			const error = (status: number, code: string, message: string) =>
				answer(
					status,
					{ ok: false, error: { code, message } },
					status === 429 ? { 'retry-after': '7' } : {}
				);
			client.raw = async (method, path, body, headers) => {
				if (method === 'GET' && path === '/v1/players')
					return answer(200, {
						players: g.on.map((steamId) => ({
							name: NAMES[steamId],
							steamId,
							faction: SIDES[steamId],
							kills: 0,
							deaths: 0,
							cash: 0,
							pingMs: 41.6
						}))
					});
				if (method === 'GET' && path === '/v1/status')
					return answer(200, {
						serverName: 'Example Clan #1',
						map: 'Kavkazi',
						experiences: [],
						players: { current: g.on.length, max: 98 },
						factionScores: [
							{ name: 'Lonestar', colorHex: '#888888', score: 12 },
							{ name: 'Valkyra', colorHex: '#888888', score: 30 },
							{ name: 'Manticore', colorHex: '#888888', score: 4 }
						],
						rotation: { nowIndex: 0, nextIndex: 1 }
					});
				if (method === 'GET' && path === '/v1/rotation') {
					g.rotationReads++;
					return answer(200, {
						enabled: true,
						mode: 'ordered',
						entries: [
							{ map: 'Kavkazi', experiences: [], status: 'now' },
							{ map: 'Russia', experiences: [], status: 'next' },
							{ map: 'Europe', experiences: [] }
						]
					});
				}
				if (method === 'GET' && path === '/v1/capabilities' && !g.served)
					return answer(200, { build: 'old', routes: ['GET /v1/status', 'GET /v1/players'] });
				if (method === 'GET' && path.startsWith('/v1/chat?')) {
					g.chatReads.push(path);
					if (g.chat === 409)
						return error(409, 'chat_terms_not_accepted', 'The chat terms have not been accepted.');
					if (g.chat === 429) return error(429, 'rate_limited', 'Too many requests.');
					if (g.chat !== 200) return error(g.chat, 'boom', 'internal detail at 10.0.0.9');
					const q = new URLSearchParams(path.split('?')[1]);
					const after = Number(q.get('after'));
					const messages = g.lines
						.filter((l) => (l.seq as number) > after)
						.slice(0, Number(q.get('limit')));
					return answer(200, {
						...(g.latest === true
							? { latestSeq: g.seq }
							: g.latest === 'page'
								? { latestSeq: (messages.at(-1)?.seq as number | undefined) ?? 0 }
								: g.latest === 'zero'
									? { latestSeq: 0 }
									: {}),
						messages,
						count: messages.length
					});
				}
				const whisper = /^\/v1\/players\/(\d{17})\/message$/.exec(path);
				if (method === 'POST' && whisper) {
					const status = g.refuse.get(whisper[1]);
					if (status === 404) return error(404, 'player_not_found', 'No such player.');
					if (status === 429) return error(429, 'rate_limited', 'Too many requests.');
					if (status)
						return error(status, 'message_refused', `Refused for ${whisper[1]} at 10.0.0.9`);
					g.whispers.push([whisper[1], JSON.parse(body ?? '{}').message]);
					return answer(200, { message: 'Message sent.' });
				}
				if (method === 'POST' && path === '/v1/broadcast') {
					g.broadcasts.push(JSON.parse(body ?? '{}').message);
					return answer(200, { message: 'Announcement sent.' });
				}
				return raw(method, path, body, headers);
			};
			return client;
		});
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			const to = String(url);
			if (to.startsWith('http://127.0.0.1:')) return realFetch(url, init);
			// everything the process sends out stops here, and is kept to be looked at
			out.push({ url: to, body: String(init?.body ?? '') });
			if (to.startsWith(GONE_HOOK))
				return new Response('{"message":"Unknown Webhook","code":10015}', { status: 404 });
			if (to.startsWith(STAFF_HOOK))
				for (const e of JSON.parse(String(init?.body ?? '{}')).embeds ?? [])
					cards.push({ title: e.title, description: e.description });
			return new Response('{"id":"1"}', { status: 200 });
		}) as typeof fetch;
	});

	afterAll(async () => {
		clearInterval(renewing);
		for (const id of watched) forgetMemory(id);
		forgetChat();
		spy.mockRestore();
		globalThis.fetch = realFetch;
		resetWebhookQueues();
		await releaseOwnership(env);
	});

	/** The worker's memory of a server, fresh, and nothing remembered of its chat. */
	const memoryOf = async (w: World): Promise<ServerMemory> => {
		const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		forgetMemory(server.id);
		forgetChat(server.id);
		watched.add(server.id);
		return memoryFor(server, org);
	};
	/**
	 * As if `ms` had gone by on this server: every time the chat memory holds moves that far back.
	 * `reads: false` leaves when the chat was last read alone (a long wait would otherwise make the
	 * place stale, which is its own test).
	 */
	const later = (serverId: string, ms: number, { reads = true } = {}) => {
		const mem = chatMemoryOf(serverId);
		if (!mem) return;
		if (reads) mem.readAt -= ms;
		mem.waitUntil -= ms;
		mem.flushedAt -= ms;
		mem.prunedAt -= ms;
		for (const by of mem.tracks.players.values()) for (const [k, v] of by) by.set(k, v - ms);
		for (const [k, v] of mem.tracks.said) mem.tracks.said.set(k, v - ms);
		for (const [k, v] of mem.tracks.typed)
			mem.tracks.typed.set(
				k,
				v.map((t) => t - ms)
			);
		mem.tracks.sent = mem.tracks.sent.map((t) => t - ms);
		if (mem.rotation) mem.rotation.at -= ms;
		if (mem.top) mem.top.at -= ms;
		for (const r of mem.ranks.values()) r.at -= ms;
	};
	/** The worker's next look at the server, a little over the chat interval after the last. */
	const look = async (m: ServerMemory) => {
		later(m.server.id, settings().chatMs + 100);
		invalidateTriggers(m.server.id);
		await observeServer(env, m, { status: true, players: true });
	};
	/** A player typing a line in the game's chat. */
	const say = (w: World, steamId: string, text: string, over: Record<string, unknown> = {}) => {
		const g = game(w.server.id);
		g.lines.push({
			seq: ++g.seq,
			sentUtc: new Date().toISOString(),
			channel: 'Team',
			faction: 'RED',
			steamId,
			realName: NAMES[steamId] ?? '',
			hiddenName: 'Amber Falcon',
			anonymous: false,
			text,
			rawText: text,
			ping: false,
			...over
		});
	};
	const route = async (method: string, path: string) =>
		(await import(join(ROUTES, path, '+server.ts')))[method];
	/** A rule saved through the route the panel calls. */
	const save = async (
		w: World,
		kind: 'chat_command' | 'staff_call',
		config: Record<string, unknown>,
		{ who = w.users.owner, enabled = true, serverId = w.server.id, name = '' } = {}
	) =>
		callApi(await route('POST', 'api/servers/[id]/triggers'), who, {
			method: 'POST',
			params: { id: serverId },
			body: { kind, enabled, config, ...(name ? { name } : {}) }
		});
	const rule = async (
		w: World,
		kind: 'chat_command' | 'staff_call',
		config: Record<string, unknown>
	): Promise<string> => {
		const res = await save(w, kind, config);
		expect([res.status, res.message]).toEqual([201, '']);
		return (res.body as { trigger: TriggerView }).trigger.id;
	};
	const patch = async (
		w: World,
		id: string,
		body: Record<string, unknown>,
		who: SessionUser | null = w.users.owner
	) =>
		callApi(await route('PATCH', 'api/servers/[id]/triggers/[triggerId]'), who, {
			method: 'PATCH',
			params: { id: w.server.id, triggerId: id },
			body
		});
	const ruleRow = async (id: string) =>
		(await env.db.select().from(triggers).where(eq(triggers.id, id)))[0];
	const staffHook = async (w: World, serverIds: string[] | null = null, url = STAFF_HOOK) => {
		await env.db.insert(webhooks).values({
			id: newId(),
			orgId: w.org.id,
			label: 'staff',
			urlEnc: encryptSecret(env, url),
			events: ['staffcalls'],
			serverIds
		});
		resetWebhookQueues();
	};
	/** Discord takes a card a moment after it is queued (a second and a half, and the post). */
	const posted = () => Bun.sleep(2000);
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

	test('a server without a chat rule has its chat read by nobody', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		say(w, A, '!rules');
		await look(m);
		await look(m);
		expect(game(w.server.id).chatReads).toEqual([]);
		expect(chatMemoryOf(w.server.id)).toBeUndefined();
		// a rule that is saved but off reads nothing either
		const res = await save(
			w,
			'chat_command',
			{ command: 'rules', replies: 'x' },
			{ enabled: false }
		);
		expect(res.status).toBe(201);
		await look(m);
		expect(game(w.server.id).chatReads).toEqual([]);
	});

	test('nor is the chat of a suspended organisation read: nobody of it could switch the rule off', async () => {
		const w = await seedWorld(env);
		let m = await memoryOf(w);
		const g = game(w.server.id);
		await rule(w, 'chat_command', { command: 'motd', replies: 'hello', cooldownSeconds: 0 });
		await look(m);
		say(w, A, '!motd');
		await look(m);
		expect(g.whispers).toHaveLength(1);
		await suspend(env, w.org.id);
		const reads = g.chatReads.length;
		// the worker's next look at the roster takes the organisation as it now stands
		const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
		m = memoryFor(m.server, org);
		say(w, A, '!motd');
		await look(m);
		await look(m);
		expect(g.chatReads).toHaveLength(reads);
		expect(g.whispers).toHaveLength(1);
		expect(chatMemoryOf(w.server.id)).toBeUndefined();
	});

	test('a command is answered by whisper, filled in; chat that is no command goes unanswered', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const id = await rule(w, 'chat_command', {
			command: 'rules',
			aliases: 'r',
			replies: [
				'No team killing on {server}, {name} ({faction}, ping {ping}).',
				'{kills} kills here. Commands: {commands}. Sides: {teams}.'
			]
		});
		await rule(w, 'chat_command', { command: 'discord', replies: 'discord.gg/example' });
		// the first look only finds where the chat stands: the game's newest line from a read of
		// one, then a read from there that brings nothing
		say(w, A, '!rules');
		await look(m);
		expect(g.chatReads).toEqual(['/v1/chat?after=0&limit=1', '/v1/chat?after=1&limit=200']);
		expect(g.whispers).toEqual([]);
		// then what is typed is answered, at the next look, to the player who typed it
		say(w, B, 'push the hill from the east side');
		say(w, B, '!R');
		say(w, C, '!nothing here');
		say(w, C, 'type !rules for the rules');
		await look(m);
		expect(g.chatReads.slice(2)).toEqual(['/v1/chat?after=1&limit=200']);
		expect(g.whispers).toEqual([
			[B, 'No team killing on Example Clan #1, Kova (Lonestar, ping 42).'],
			[B, '0 kills here. Commands: !rules !discord. Sides: Lonestar 2 · Valkyra 1 · Manticore 0.']
		]);
		expect(g.broadcasts).toEqual([]);
		// inside the rule's wait the same player is not answered again; another is
		say(w, B, '!rules');
		say(w, A, '!rules');
		await look(m);
		expect(g.whispers.map(([to]) => to)).toEqual([B, B, A, A]);
		// the row counts its answers and when, and says nothing of who
		const row = await ruleRow(id);
		expect(row.fireCount).toBe(1);
		expect(row.lastResult).toBe('Answered once.');
		expect(row.lastFiredAt).not.toBeNull();
		expect(row.state).toEqual({ wait: '' });
		later(w.server.id, 61_000, { reads: false });
		await look(m);
		expect([(await ruleRow(id)).fireCount, (await ruleRow(id)).lastResult]).toEqual([
			2,
			'Answered once.'
		]);
		// nothing went through the outbox or the audit trail
		expect(await env.db.select().from(outbox).where(eq(outbox.serverId, w.server.id))).toEqual([]);
		const trail = await env.db
			.select({ action: auditLog.action })
			.from(auditLog)
			.where(eq(auditLog.serverId, w.server.id));
		expect(trail.map((r) => r.action)).toEqual(['trigger.create', 'trigger.create']);
	});

	test('nothing typed before the worker knew where the chat stood is answered, and nothing twice', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		await rule(w, 'chat_command', { command: 'motd', replies: 'hello {name}', cooldownSeconds: 0 });
		const answered = () => g.whispers.length;
		for (let i = 0; i < 5; i++) say(w, A, '!motd');
		await look(m);
		await look(m);
		expect(answered()).toBe(0);
		say(w, A, '!motd');
		await look(m);
		expect(answered()).toBe(1);
		// a look that reads nothing new answers nothing again
		await look(m);
		expect(answered()).toBe(1);

		// the worker starts again, or another takes over: what was typed meanwhile is not answered
		say(w, A, '!motd');
		forgetChat();
		await look(m);
		expect(answered()).toBe(1);
		say(w, B, '!motd');
		await look(m);
		expect(g.whispers.at(-1)).toEqual([B, 'hello Kova']);
		expect(answered()).toBe(2);

		// a read that comes late (a held server, a busy lane) sets the place again
		say(w, A, '!motd');
		later(w.server.id, 20_000);
		await look(m);
		expect(answered()).toBe(2);
		say(w, C, '!motd');
		await look(m);
		expect(answered()).toBe(3);

		// the game numbers its lines from the start again (a new process): the place is lost, found
		// again at the next look, and its lines until then are old
		g.lines = [];
		g.seq = 0;
		say(w, A, '!motd');
		say(w, A, '!motd');
		await look(m);
		expect(answered()).toBe(3);
		expect(chatMemoryOf(w.server.id)).toMatchObject({ primed: false, cursor: 0 });
		say(w, A, '!motd');
		await look(m);
		expect(answered()).toBe(3);
		expect(chatMemoryOf(w.server.id)).toMatchObject({ primed: true, cursor: 3 });
		say(w, B, '!motd');
		await look(m);
		expect(answered()).toBe(4);

		// a page full is no chat typed between two reads: a backlog, and none of it is answered
		for (let i = 0; i < 200; i++) say(w, C, '!motd');
		await look(m);
		expect(answered()).toBe(4);
		expect(chatMemoryOf(w.server.id)).toMatchObject({ primed: false });
		await look(m);
		say(w, C, '!motd');
		await look(m);
		expect(answered()).toBe(5);

		// the rule is switched off and on: what was typed while it was off is not answered
		const [row] = await env.db.select().from(triggers).where(eq(triggers.serverId, w.server.id));
		expect((await patch(w, row.id, { enabled: false })).status).toBe(200);
		say(w, A, '!motd');
		const before = g.chatReads.length;
		await look(m);
		expect(g.chatReads.length).toBe(before);
		expect(chatMemoryOf(w.server.id)).toBeUndefined();
		expect((await patch(w, row.id, { enabled: true })).status).toBe(200);
		await look(m);
		expect(answered()).toBe(5);
		say(w, A, '!motd');
		await look(m);
		expect(answered()).toBe(6);
	});

	test.each([
		['does not say where its chat stands', false],
		['says its newest line is 0 whatever it holds', 'zero']
	] as const)(
		'a game that %s has nothing answered: the rows say the chat cannot be read',
		async (_, unplaced) => {
			const w = await seedWorld(env);
			const m = await memoryOf(w);
			const g = game(w.server.id);
			g.latest = unplaced;
			const id = await rule(w, 'chat_command', {
				command: 'motd',
				replies: 'hello',
				cooldownSeconds: 0
			});
			for (let i = 0; i < 30; i++) say(w, A, i % 2 ? '!motd' : 'chatter');
			const warn = spyOn(console, 'warn').mockImplementation(() => {});
			try {
				for (let i = 0; i < 3; i++) {
					say(w, B, '!motd');
					later(w.server.id, 61_000, { reads: false });
					await look(m);
				}
				// asked for one line each time, and no further: there is no place to read on from
				expect(g.chatReads).toEqual(Array(3).fill('/v1/chat?after=0&limit=1'));
				expect(g.whispers).toEqual([]);
				expect(chatMemoryOf(w.server.id)).toMatchObject({ primed: false, failures: 3 });
				expect((await ruleRow(id)).state).toEqual({ wait: 'failing' });
				// logged once, as what the panel made of the answer
				expect(
					warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('chat of'))
				).toEqual([expect.stringContaining('502 bad_response')]);
				// once it does say, the place is found and the rules answer
				g.latest = true;
				later(w.server.id, 61_000, { reads: false });
				await look(m);
				expect((await ruleRow(id)).state).toEqual({ wait: '' });
				say(w, B, '!motd');
				await look(m);
				expect(g.whispers).toEqual([[B, 'hello']]);
				// and should it stop saying, they stop answering
				g.latest = unplaced;
				say(w, B, '!motd');
				await look(m);
				say(w, B, '!motd');
				later(w.server.id, 61_000, { reads: false });
				await look(m);
				expect(g.whispers).toHaveLength(1);
				expect(chatMemoryOf(w.server.id)?.failures).toBeGreaterThan(0);
			} finally {
				warn.mockRestore();
			}
		}
	);

	test('a game whose word of its newest line is of something else has no old line answered', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		// its "newest line" is the newest of the lines it sends with it: the first read of one line
		// says 1 with 620 lines behind it
		g.latest = 'page';
		const id = await rule(w, 'chat_command', {
			command: 'motd',
			replies: 'hello',
			cooldownSeconds: 0
		});
		for (let i = 0; i < 620; i++) say(w, A, i % 2 ? '!motd' : 'chatter');
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			await look(m);
			// a read from the number it gave brought lines: read on, a page at a time, acting on none
			expect(g.chatReads).toEqual([
				'/v1/chat?after=0&limit=1',
				'/v1/chat?after=1&limit=200',
				'/v1/chat?after=201&limit=200'
			]);
			expect(chatMemoryOf(w.server.id)).toMatchObject({ primed: false, cursor: 401 });
			// its end never comes (with no line to send it says 0, which reads as numbering anew), so
			// after a dozen reads the chat counts as unreadable, and after three such rounds the rows
			// say so. Nothing typed in all that time is answered.
			for (let i = 0; i < 15; i++) {
				say(w, B, '!motd');
				later(w.server.id, 61_000, { reads: false });
				await look(m);
			}
			expect(g.whispers).toEqual([]);
			expect(chatMemoryOf(w.server.id)).toMatchObject({ primed: false });
			expect((await ruleRow(id)).state).toEqual({ wait: 'failing' });
			expect((await ruleRow(id)).lastResult).toContain('cannot be read right now');
		} finally {
			warn.mockRestore();
		}
	});

	test('said to everyone: a broadcast, once in its wait, an anonymous player under the name others see', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		await rule(w, 'chat_command', {
			command: 'score',
			replies:
				'{name} ({steamid}, {faction}) asked: {scores}. All time {kills}, org {org_kills}, rank {rank}, ping {ping}.',
			to: 'everyone',
			cooldownSeconds: 60
		});
		await look(m);
		say(w, A, '!score', { anonymous: true });
		say(w, B, '!score');
		await look(m);
		// The hidden name and the side the others see, and nothing that is the player's own: no
		// SteamID, stats, rank or ping. Nobody's org-wide stats go into a text everyone reads.
		expect(g.broadcasts).toEqual([
			'Amber Falcon (, Valkyra) asked: Lonestar 12 · Valkyra 30 · Manticore 4. All time …, org {org_kills}, rank …, ping ….'
		]);
		expect(g.whispers).toEqual([]);
		later(w.server.id, 60_000, { reads: false });
		say(w, B, '!score');
		await look(m);
		expect(g.broadcasts.at(-1)).toBe(
			`Kova (${B}, Lonestar) asked: Lonestar 12 · Valkyra 30 · Manticore 4. All time 0, org {org_kills}, rank unranked, ping 42.`
		);
		// a game that gives an anonymous player no other name: the real one is still not said
		later(w.server.id, 60_000, { reads: false });
		say(w, C, '!score', { anonymous: true, hiddenName: '' });
		await look(m);
		expect(g.broadcasts.at(-1)).toStartWith('A player (, Lonestar) asked');
		expect(g.broadcasts.join(' ')).not.toContain('Night Owl');
		expect(g.broadcasts.join(' ')).not.toContain('Brick');
		expect(g.broadcasts).toHaveLength(3);
	});

	test('the rotation, a rank and the board come from where the panel already keeps them', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		await rule(w, 'chat_command', {
			command: 'next',
			replies: 'Next: {next_map}. Maps: {rotation}. Rank {rank}. Top: {top}.',
			cooldownSeconds: 0
		});
		await rule(w, 'chat_command', {
			command: 'plain',
			replies: 'nothing to read',
			cooldownSeconds: 0
		});
		await look(m);
		// a reply that names none of them reads none of them
		say(w, A, '!plain');
		await look(m);
		expect(g.rotationReads).toBe(0);
		say(w, A, '!next');
		say(w, B, '!next');
		await look(m);
		// a server with no history: nobody ranked, nobody on the board
		const text = 'Next: Sabatulo. Maps: Bakurani, Sabatulo, Ozeti. Rank unranked. Top: ….';
		expect(g.whispers.slice(1)).toEqual([
			[A, text],
			[B, text]
		]);
		// the rotation is read from the game once a minute at most
		expect(g.rotationReads).toBe(1);
		say(w, C, '!next');
		await look(m);
		expect(g.rotationReads).toBe(1);
		later(w.server.id, 61_000, { reads: false });
		say(w, C, '!next');
		await look(m);
		expect(g.rotationReads).toBe(2);
	});

	test('a staff call: a card on Discord with who and what, a whisper back; a report names its player', async () => {
		const w = await seedWorld(env);
		await staffHook(w);
		cards.length = 0;
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const id = await rule(w, 'staff_call', {
			commands: 'mods',
			reports: 'grass',
			cooldownSeconds: 60
		});
		await look(m);
		say(w, A, '!mods');
		say(w, A, '!mods **he** is <@&123> stuck at https://evil.example', { channel: 'Global' });
		say(w, A, '!mods and again');
		say(w, B, '!grass brick shooting teammates at spawn', { anonymous: true });
		say(w, C, '!grass nobodyhere is cheating');
		await look(m);
		expect(g.whispers).toEqual([
			[A, 'Tell staff what is wrong: !mods <message>'],
			[A, 'Thanks Night Owl: your call is on its way to staff.'],
			[A, 'Your last call was passed on, Night Owl. You can send another in 60 s.'],
			[B, 'Thanks Kova: your call is on its way to staff.'],
			[C, 'Thanks Brick: your call is on its way to staff.']
		]);
		await posted();
		expect(cards.map((c) => c.title)).toEqual([
			'Staff call · !mods',
			'Player report · !grass',
			'Player report · !grass'
		]);
		const [call, report, unnamed] = cards.map((c) => c.description);
		const page = (steamId: string) =>
			`http://localhost:5173/server/${encodeURIComponent(w.server.id)}/players/${steamId}`;
		// who called, with a link to their page; what they wrote, as text and nothing else
		expect(call).toContain(`[**Night Owl**](${page(A)}) \`${A}\``);
		expect(call).toContain('> \\*\\*he\\*\\* is \\<@&123\\> stuck at https:​//evil.example');
		expect(call).not.toContain('<@&123>');
		expect(call).not.toContain('About:');
		expect(call).toContain('Server: Example Clan #1 · Bakurani · 3 on · Global chat');
		// a report: the player it names, looked up on the list; the caller's anonymous mode is said
		expect(report).toContain(`[**Kova**](${page(B)}) \`${B}\` · anonymous, shown as Amber Falcon`);
		expect(report).toContain(`About: [**Brick**](${page(C)}) \`${C}\``);
		expect(report).toContain('> brick shooting teammates at spawn');
		expect(unnamed).toContain('About: no player on the server fits the name given');
		// a name is text too, the caller's and the one a report names: no markdown, mention or link.
		// Nor does anything a player writes end the card's own link or start another, and half a
		// character pair (a line the game cut through an emoji) is no reason for Discord to refuse.
		cards.length = 0;
		g.on = [A, B, C, D];
		await look(m);
		say(w, D, '!mods help ](https:/evil.example) (now)');
		say(w, B, `!mods ${'x'.repeat(493)}\u{1F600}`);
		later(w.server.id, 61_000, { reads: false });
		say(w, C, `!grass ${D} is advertising`);
		// a report that starts with less than a whole name: a guess, and the card says so
		say(w, A, '!grass kov was shooting his own side');
		await look(m);
		await posted();
		expect(cards.map((c) => c.title)).toEqual([
			'Staff call · !mods',
			'Staff call · !mods',
			'Player report · !grass',
			'Player report · !grass'
		]);
		const escaped = '\\*\\*@everyone\\*\\* \\[free skins\\]\\(https:\u200B//evil.example\\)';
		expect(cards[0].description).toContain(`[**${escaped}**](${page(D)}) \`${D}\``);
		expect(cards[0].description).toContain('> help \\]\\(https:/evil.example\\) \\(now\\)');
		expect(cards[2].description).toContain(`About: [**${escaped}**](${page(D)}) \`${D}\``);
		expect(cards[3].description).toContain(
			`Perhaps about: [**Kova**](${page(B)}) \`${B}\` · guessed from "kov"`
		);
		for (const c of cards) {
			expect(c.description).not.toContain('**@everyone**');
			expect(c.description).not.toContain('](https://evil.example)');
			// the only links are the card's own: the caller's, and the player a report names
			const links = c.description.match(/(?<!\\)\]\(/g) ?? [];
			expect(links).toHaveLength(c.title.startsWith('Player report') ? 2 : 1);
			expect(/\p{Cs}/u.test(c.description)).toBe(false);
		}
		expect(cards[1].description).toContain('x'.repeat(493) + '\uFFFD');
		// the rule's row: how many calls, not whose or what
		const row = await ruleRow(id);
		expect([row.fireCount, row.lastResult]).toEqual([7, 'Passed 4 calls on to Discord.']);
		expect(JSON.stringify(row)).not.toContain('stuck');
		for (const steamId of [A, B, C]) expect(JSON.stringify(row)).not.toContain(steamId);
	}, 20_000);

	test('with no Discord webhook for it, a staff call reaches nobody and nobody is told it did', async () => {
		const w = await seedWorld(env);
		// a webhook that takes Staff calls, for the organisation's other server only
		await staffHook(w, [w.otherServer.id]);
		cards.length = 0;
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const id = await rule(w, 'staff_call', { commands: 'mods', reports: [] });
		await look(m);
		say(w, A, '!mods help me');
		await look(m);
		await posted();
		expect(cards).toEqual([]);
		expect(g.whispers).toEqual([]);
		const row = await ruleRow(id);
		expect(row.fireCount).toBe(0);
		expect(row.lastResult).toContain(
			'No working Discord webhook takes Staff calls for this server'
		);
		// the page says so before anyone calls: the count, and nothing of the webhooks themselves
		const { load } = await import(join(ROUTES, '(app)/server/[id]/automation', '+page.server.ts'));
		const page = await callLoad(load, w.users.owner, { params: { id: w.server.id } });
		expect((page.body as { staffHooks: number }).staffHooks).toBe(0);
		const other = await callLoad(load, w.users.owner, { params: { id: w.otherServer.id } });
		expect((other.body as { staffHooks: number }).staffHooks).toBe(1);
		// the player may call again at once, and is heard once a webhook takes it
		await staffHook(w);
		say(w, A, '!mods help me now');
		await look(m);
		expect(g.whispers).toEqual([[A, 'Thanks Night Owl: your call is on its way to staff.']]);
		await posted();
		expect(cards.map((c) => c.title)).toEqual(['Staff call · !mods']);
	}, 20_000);

	test('a webhook Discord says is gone counts as none from then on: no later caller is told their call is on its way', async () => {
		const w = await seedWorld(env);
		await staffHook(w, null, GONE_HOOK);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const id = await rule(w, 'staff_call', { commands: 'mods', reports: [] });
		const { load } = await import(join(ROUTES, '(app)/server/[id]/automation', '+page.server.ts'));
		const hooks = async () =>
			(
				(await callLoad(load, w.users.owner, { params: { id: w.server.id } })).body as {
					staffHooks: number;
				}
			).staffHooks;
		expect(await hooks()).toBe(1);
		await look(m);
		// the first call finds out: it was on its way, and Discord refused it
		say(w, A, '!mods help me');
		await look(m);
		expect(g.whispers).toEqual([[A, 'Thanks Night Owl: your call is on its way to staff.']]);
		await posted();
		const hook = async () =>
			(await env.db.select().from(webhooks).where(eq(webhooks.orgId, w.org.id)))[0];
		// what Discord answered is on the webhook's row once the post is back
		for (let i = 0; i < 50 && (await hook()).lastStatus !== 404; i++) await Bun.sleep(100);
		expect((await hook()).lastStatus).toBe(404);
		await Bun.sleep(100);
		// from then on a call reaches nobody and nobody is told it did: neither that it is on its
		// way, nor (calling twice in one read) that their last call was passed on
		const sent = out.filter((o) => o.url.startsWith(GONE_HOOK)).length;
		say(w, B, '!mods and me');
		say(w, B, '!mods hello?');
		later(w.server.id, 61_000, { reads: false });
		await look(m);
		await posted();
		expect(g.whispers).toHaveLength(1);
		expect(out.filter((o) => o.url.startsWith(GONE_HOOK))).toHaveLength(sent);
		expect((await ruleRow(id)).lastResult).toContain('No working Discord webhook');
		expect(await hooks()).toBe(0);
		// an owner gives it a new address, which forgets what Discord last said: calls go out again
		const { PATCH } = await import(
			join(ROUTES, 'api/orgs/[id]/webhooks/[webhookId]', '+server.ts')
		);
		const mended = await callApi(PATCH, w.users.owner, {
			method: 'PATCH',
			params: { id: w.org.id, webhookId: (await hook()).id },
			body: { url: 'https://discord.com/api/webhooks/123456789012345678/' + 'b'.repeat(68) }
		});
		expect(mended.status).toBe(200);
		expect((await hook()).lastStatus).toBeNull();
		resetWebhookQueues();
		expect(await hooks()).toBe(1);
		say(w, B, '!mods third time');
		await look(m);
		expect(g.whispers.at(-1)).toEqual([B, 'Thanks Kova: your call is on its way to staff.']);
		await posted();
	}, 20_000);

	test('the game’s chat terms come first: the rules wait, say so once, and go on when accepted', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		g.chat = 409;
		const id = await rule(w, 'chat_command', { command: 'motd', replies: 'hello' });
		await look(m);
		expect(g.chatReads).toHaveLength(1);
		let row = await ruleRow(id);
		expect(row.state).toEqual({ wait: 'terms' });
		expect(row.lastResult).toContain('chat terms have not been accepted');
		const view = async () => {
			const res = await callApi(await route('GET', 'api/servers/[id]/triggers'), w.users.owner, {
				params: { id: w.server.id }
			});
			return (res.body as { triggers: TriggerView[] }).triggers.find((t) => t.id === id);
		};
		expect((await view())?.chatWait).toBe('terms');
		// not asked again at every look: once a minute
		await look(m);
		await look(m);
		expect(g.chatReads).toHaveLength(1);
		// a rule added while the others wait is told too
		const second = await rule(w, 'chat_command', { command: 'other', replies: 'x' });
		later(w.server.id, 61_000);
		await look(m);
		expect(g.chatReads).toHaveLength(2);
		expect((await ruleRow(second)).state).toEqual({ wait: 'terms' });
		// an owner accepts: the next read finds the place, and what was typed before it is not answered
		g.chat = 200;
		say(w, A, '!motd');
		later(w.server.id, 61_000);
		await look(m);
		row = await ruleRow(id);
		expect(row.state).toEqual({ wait: '' });
		expect(row.lastResult).toBe('Reading the chat.');
		expect((await view())?.chatWait).toBe('');
		expect(g.whispers).toEqual([]);
		say(w, A, '!motd');
		await look(m);
		expect(g.whispers).toEqual([[A, 'hello']]);
	});

	test('a wait an earlier worker left on a row is cleared by the next; a result that is no wait is left', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		g.chat = 409;
		const id = await rule(w, 'chat_command', { command: 'motd', replies: 'hello' });
		await look(m);
		expect((await ruleRow(id)).lastResult).toStartWith('Waiting:');
		// the terms are accepted while no worker is looking; the one that starts has told this row
		// nothing, and still takes the old wait off it
		forgetChat();
		g.chat = 200;
		await look(m);
		expect((await ruleRow(id)).state).toEqual({ wait: '' });
		expect((await ruleRow(id)).lastResult).toBe('Reading the chat.');
		// what the row says of its answers is not a wait, and outlasts a worker
		say(w, A, '!motd');
		await look(m);
		expect((await ruleRow(id)).lastResult).toBe('Answered once.');
		forgetChat();
		await look(m);
		expect((await ruleRow(id)).lastResult).toBe('Answered once.');
	});

	test('a build that does not serve the chat: the rules wait and nothing is asked of it', async () => {
		const w = await seedWorld(env);
		const g = game(w.server.id);
		g.served = false;
		const m = await memoryOf(w);
		const id = await rule(w, 'staff_call', {});
		await look(m);
		await look(m);
		expect(g.chatReads).toEqual([]);
		expect((await ruleRow(id)).state).toEqual({ wait: 'build' });
		expect((await ruleRow(id)).lastResult).toContain('does not serve the in-game chat');
	});

	test('nobody on, nothing read', async () => {
		const w = await seedWorld(env);
		const g = game(w.server.id);
		g.on = [];
		const m = await memoryOf(w);
		await rule(w, 'chat_command', { command: 'motd', replies: 'hello' });
		await look(m);
		await look(m);
		expect(g.chatReads).toEqual([]);
		g.on = [A];
		await look(m);
		expect(g.chatReads).toHaveLength(1);
	});

	test('read as seldom as the site sets it, the place still holds from one read to the next', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		await rule(w, 'chat_command', { command: 'motd', replies: 'hello', cooldownSeconds: 0 });
		try {
			// the chat read every 20 s: a read is never "too long after the last" for coming on time
			await saveSettings(env, { chatMs: 20_000 }, null);
			await look(m);
			say(w, A, '!motd');
			await look(m);
			expect(g.whispers).toEqual([[A, 'hello']]);
			// one that comes far later than that is, and finds the place again first
			say(w, A, '!motd');
			later(w.server.id, 30_000);
			await look(m);
			expect(g.whispers).toHaveLength(1);
			say(w, B, '!motd');
			await look(m);
			expect(g.whispers).toHaveLength(2);
			// the same where it is the worker's looks that come seldom
			await saveSettings(env, { chatMs: 2000, hotPlayersMs: 30_000, hotStatusMs: 30_000 }, null);
			say(w, C, '!motd');
			later(w.server.id, 30_000);
			await look(m);
			expect(g.whispers).toHaveLength(3);
		} finally {
			for (const key of ['chatMs', 'hotPlayersMs', 'hotStatusMs']) await resetSetting(env, key);
		}
	});

	test('a read that fails is the chat’s own: the look stands, the tries thin out, the row says so', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const id = await rule(w, 'chat_command', {
			command: 'motd',
			replies: 'hello',
			cooldownSeconds: 0
		});
		await look(m);
		g.chat = 500;
		const warn = spyOn(console, 'warn').mockImplementation(() => {});
		try {
			say(w, A, '!motd');
			await look(m);
			// the server was looked at and is up: only the chat was not read
			expect([m.ok, m.failures, m.error]).toEqual([true, 0, '']);
			expect(chatMemoryOf(w.server.id)).toMatchObject({ failures: 1, primed: true });
			// logged once, as a status and a code, never the game's words
			const logged = JSON.stringify(warn.mock.calls);
			expect(logged).toContain('500 boom');
			expect(logged).not.toContain('10.0.0.9');
			// the next look comes too soon to try again
			const reads = g.chatReads.length;
			await look(m);
			expect(g.chatReads).toHaveLength(reads);
			// a short lapse leaves the place as it was: what was typed during it is answered after
			g.chat = 200;
			later(w.server.id, 4000);
			await look(m);
			expect(g.whispers).toEqual([[A, 'hello']]);
			expect(chatMemoryOf(w.server.id)).toMatchObject({ failures: 0 });
			// failing three times in a row, the rules' rows say the chat cannot be read
			g.chat = 500;
			for (let i = 0; i < 3; i++) {
				later(w.server.id, 61_000, { reads: false });
				const mem = chatMemoryOf(w.server.id)!;
				mem.readAt = Date.now() - 3000;
				await look(m);
			}
			expect((await ruleRow(id)).state).toEqual({ wait: 'failing' });
			expect((await ruleRow(id)).lastResult).toContain('cannot be read right now');
			expect(JSON.stringify(await ruleRow(id))).not.toContain('10.0.0.9');
		} finally {
			warn.mockRestore();
		}
	});

	test('the game asking the panel to slow down holds the server, at a read and at an answer', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const id = await rule(w, 'chat_command', { command: 'motd', replies: ['one', 'two'] });
		await look(m);
		g.chat = 429;
		await look(m);
		expect(m.holdUntil).toBeGreaterThan(Date.now() + 5000);
		expect(m.holdUntil).toBeLessThan(Date.now() + 8000);
		// at an answer: the first line is refused, the second is not tried, and the row says why
		g.chat = 200;
		m.holdUntil = 0;
		later(w.server.id, 8000);
		g.refuse.set(A, 429);
		say(w, A, '!motd');
		await look(m);
		expect(g.whispers).toEqual([]);
		expect(m.holdUntil).toBeGreaterThan(Date.now() + 5000);
		expect((await ruleRow(id)).lastResult).toBe(
			'Not answered: the server asked the panel to slow down.'
		);
	});

	test('a game that stops answering ends the look’s sending; a call to staff still reaches Discord', async () => {
		const w = await seedWorld(env);
		await staffHook(w);
		cards.length = 0;
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const motd = await rule(w, 'chat_command', { command: 'motd', replies: ['one', 'two'] });
		await rule(w, 'staff_call', { commands: 'mods', reports: [] });
		await look(m);
		// the game fails on the first whisper: the second line and the next player's are not tried
		g.refuse.set(A, 503);
		say(w, A, '!motd');
		say(w, B, '!motd');
		say(w, C, '!mods he is stuck at B');
		await look(m);
		expect(g.whispers).toEqual([]);
		expect((await ruleRow(motd)).lastResult).toBe(
			'Not answered: refused by the server (503, message_refused).'
		);
		await posted();
		expect(cards.map((c) => c.title)).toEqual(['Staff call · !mods']);
		// the same when it asks the panel to slow down
		cards.length = 0;
		m.holdUntil = 0;
		g.refuse.set(A, 429);
		later(w.server.id, 61_000, { reads: false });
		say(w, A, '!motd');
		say(w, C, '!mods and now at C');
		await look(m);
		expect(g.whispers).toEqual([]);
		await posted();
		expect(cards.map((c) => c.title)).toEqual(['Staff call · !mods']);
	}, 20_000);

	test('a whisper the game refuses is told in the panel’s words; a player who left is nothing', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		const id = await rule(w, 'chat_command', {
			command: 'motd',
			replies: 'hello',
			cooldownSeconds: 0
		});
		await look(m);
		g.refuse.set(A, 404);
		say(w, A, '!motd');
		await look(m);
		expect((await ruleRow(id)).lastResult).toBe('');
		g.refuse.set(A, 400);
		say(w, A, '!motd');
		await look(m);
		const row = await ruleRow(id);
		expect(row.lastResult).toBe('Not answered: refused by the server (400, message_refused).');
		expect(row.fireCount).toBe(0);
		expect(JSON.stringify(row)).not.toContain('10.0.0.9');
	});

	test('so many messages a look, and a player so many answers a minute', async () => {
		const w = await seedWorld(env);
		const m = await memoryOf(w);
		const g = game(w.server.id);
		await rule(w, 'chat_command', {
			command: 'four',
			replies: ['1', '2', '3', '4'],
			cooldownSeconds: 0
		});
		await look(m);
		// three players, four lines each: the look sends eight messages and lets the third go whole
		say(w, A, '!four');
		say(w, B, '!four');
		say(w, C, '!four');
		await look(m);
		expect(g.whispers).toHaveLength(CHAT_SENDS_PER_LOOK);
		expect(new Set(g.whispers.map(([to]) => to))).toEqual(new Set([A, B]));
		// the one let go was not answered, so they may ask again
		say(w, C, '!four');
		await look(m);
		expect(g.whispers.filter(([to]) => to === C)).toHaveLength(4);
	});

	test('nothing a player types is kept: no table, log line, request out or memory holds it; a staff call goes to its webhook alone', async () => {
		const w = await seedWorld(env);
		await staffHook(w);
		// two more listeners: a Discord webhook on every class of event but Staff calls, and a JSON
		// webhook on every kind of event there is
		await env.db.insert(webhooks).values({
			id: newId(),
			orgId: w.org.id,
			label: 'everything else',
			urlEnc: encryptSecret(env, OTHER_HOOK),
			events: WEBHOOK_EVENTS.filter((e) => e !== 'staffcalls'),
			serverIds: null
		});
		const json = await callApi(await route('POST', 'api/orgs/[id]/json-webhooks'), w.users.owner, {
			method: 'POST',
			params: { id: w.org.id },
			body: {
				label: 'Everything',
				url: 'https://93.184.216.34/in/chat-rules',
				events: [...JSON_WEBHOOK_EVENTS],
				serverIds: null
			}
		});
		expect(json.status).toBe(201);
		resetWebhookQueues();
		cards.length = 0;
		out.length = 0;
		// what only this chat carries: the words of each line, and the names nobody is listed under
		const PLAIN = ['quartzzebra', 'seventeen', 'saffronlynx', 'eightyeight'];
		const TO_STAFF = ['indigoheron', 'fortytwo', 'violetotter', 'ninetynine'];
		const HIDDEN = ['Crimson Marmot', 'Amber Falcon'];
		const holds = (text: string, words: string[]) => words.some((word) => text.includes(word));
		const logged: string[] = [];
		const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
			spyOn(console, level).mockImplementation((...args: unknown[]) => {
				logged.push(
					args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' ')
				);
			})
		);
		const m = await memoryOf(w);
		try {
			await rule(w, 'chat_command', { command: 'motd', replies: 'hello {name}' });
			await rule(w, 'staff_call', { commands: 'mods', reports: 'grass' });
			await look(m);
			say(w, A, 'quartzzebra seventeen is my password');
			say(w, B, '!motd');
			say(w, C, '!mods indigoheron fortytwo is stuck');
			say(w, A, '!grass kova violetotter ninetynine');
			say(w, B, '!unknown saffronlynx eightyeight', { hiddenName: 'Crimson Marmot' });
			await look(m);
			later(w.server.id, 61_000, { reads: false });
			await look(m);
			await posted();
		} finally {
			for (const spy of spies) spy.mockRestore();
		}
		// the two calls went to the webhook that takes Staff calls, as their players asked
		expect(cards.map((c) => c.title)).toEqual(['Staff call · !mods', 'Player report · !grass']);
		expect(cards[0].description).toContain('indigoheron fortytwo is stuck');
		// and to nothing else: no other request out holds a word of them, the other Discord webhook
		// and the JSON webhook among them
		expect(
			out.filter((o) => holds(o.body + o.url, TO_STAFF)).map((o) => o.url.replace(/\?.*$/, ''))
		).toEqual([STAFF_HOOK]);
		// (the other webhook was listening: it has the cards of the rules being made, and no call)
		const others = out
			.filter((o) => o.url.startsWith(OTHER_HOOK))
			.flatMap((o) => (JSON.parse(o.body) as { embeds?: { title: string }[] }).embeds ?? [])
			.map((e) => e.title);
		expect(others.length).toBeGreaterThan(0);
		expect(others.filter((t) => /staff call|player report/i.test(t))).toEqual([]);
		// chat that was no call to staff left the game for nowhere at all
		expect(out.filter((o) => holds(o.body + o.url, [...PLAIN, ...HIDDEN]))).toEqual([]);
		// nothing typed was logged, by the worker or anything else
		expect(logged.filter((line) => holds(line, [...PLAIN, ...TO_STAFF, ...HIDDEN]))).toEqual([]);
		// no table holds a word of any line (the JSON webhook's queue of posts is one of them)
		const all = await everything();
		for (const word of [...PLAIN, ...TO_STAFF, ...HIDDEN]) expect(all).not.toContain(word);
		// nor does what the worker remembers of the server: the look's memory, and the chat rules'
		// (a place in the chat, and when each rule last answered whom)
		const remembered = inspect([m, chatMemoryOf(w.server.id)], {
			depth: 12,
			maxStringLength: null,
			maxArrayLength: null
		});
		expect(chatMemoryOf(w.server.id)).toMatchObject({ primed: true });
		expect(holds(remembered, [...PLAIN, ...TO_STAFF, ...HIDDEN])).toBe(false);
		// and no row of the server says a command was used, or by whom
		expect(await env.db.select().from(outbox).where(eq(outbox.serverId, w.server.id))).toEqual([]);
		const trail = await env.db
			.select({ category: auditLog.category, action: auditLog.action })
			.from(auditLog)
			.where(eq(auditLog.serverId, w.server.id));
		expect(trail.filter((r) => r.category === 'trigger')).toEqual([]);
		expect(trail.map((r) => r.action)).toEqual(['trigger.create', 'trigger.create']);
		for (const row of await env.db
			.select()
			.from(triggers)
			.where(eq(triggers.serverId, w.server.id)))
			for (const steamId of [A, B, C]) expect(JSON.stringify(row)).not.toContain(steamId);
	}, 20_000);

	describe('who may save one', () => {
		const COMMAND = { command: 'motd', replies: 'hello' };
		/** an owner gives the admin role these, as on the Roles tab */
		const adminHolds = async (w: World, caps: Capability[]) => {
			const [row] = await env.db.select().from(orgRoles).where(eq(orgRoles.id, w.roles.admin));
			const keep = (row.capabilities as Capability[]).filter(
				(c) => c !== 'chat.read' && c !== 'chat.send'
			);
			const { PATCH } = await import(join(ROUTES, 'api/orgs/[id]/roles/[roleId]', '+server.ts'));
			const res = await callApi(PATCH, w.users.owner, {
				method: 'PATCH',
				params: { id: w.org.id, roleId: w.roles.admin },
				body: { capabilities: [...keep, ...caps] }
			});
			expect(res.status).toBe(200);
		};

		test('Automation, Chat and Read chat: owners, and a role an owner gave Read chat; never a key', async () => {
			const w = await seedWorld(env);
			const create = async (who: SessionUser | null, kind: 'chat_command' | 'staff_call') => {
				const res = await save(w, kind, kind === 'chat_command' ? COMMAND : {}, {
					who,
					enabled: false
				});
				return [res.status, res.code];
			};
			for (const kind of ['chat_command', 'staff_call'] as const) {
				expect(await create(null, kind)).toEqual([401, 'unauthenticated']);
				expect(await create(w.users.outsider, kind)).toEqual([404, 'not_found']);
				expect(await create(w.users.elsewhere, kind)).toEqual([404, 'not_found']);
				expect(await create(w.users.viewer, kind)).toEqual([403, 'forbidden']);
				expect(await create(w.users.operator, kind)).toEqual([403, 'forbidden']);
				// the built-in admin holds Automation and Chat, and not Read chat
				const admin = await save(w, kind, kind === 'chat_command' ? COMMAND : {}, {
					who: w.users.admin,
					enabled: false
				});
				expect([admin.status, admin.code]).toEqual([403, 'forbidden']);
				expect(admin.message).toContain("needs 'Read chat'");
				// a key over everything holds no capability that is a person's
				const key = await save(w, kind, kind === 'chat_command' ? COMMAND : {}, {
					who: w.users.keyAll,
					enabled: false
				});
				expect([key.status, key.code]).toEqual([403, 'forbidden']);
				expect(key.message).toContain("needs 'Read chat'");
				expect(await create(w.users.keyView, kind)).toEqual([403, 'forbidden']);
			}
			expect(
				await env.db.select().from(triggers).where(eq(triggers.serverId, w.server.id))
			).toEqual([]);
			// Read chat without Chat is not enough for a rule that messages players
			await adminHolds(w, ['chat.read']);
			const noChat = await save(w, 'chat_command', COMMAND, { who: w.users.admin });
			expect([noChat.status, noChat.message.includes("needs 'Chat'")]).toEqual([403, true]);
			// a Staff call that whispers nothing back needs Read chat alone; one that whispers, Chat too
			const silent = { commands: 'mods', ack: '', usage: '', wait: '' };
			for (const text of ['ack', 'usage', 'wait']) {
				const whispers = await save(
					w,
					'staff_call',
					{ ...silent, [text]: 'hello' },
					{ who: w.users.admin }
				);
				expect([text, whispers.status, whispers.message.includes("needs 'Chat'")]).toEqual([
					text,
					403,
					true
				]);
			}
			expect((await save(w, 'staff_call', silent, { who: w.users.admin })).status).toBe(201);
			await adminHolds(w, ['chat.read', 'chat.send']);
			const made = await save(w, 'chat_command', COMMAND, { who: w.users.admin });
			expect(made.status).toBe(201);
			const id = (made.body as { trigger: TriggerView }).trigger.id;
			// taken from the role again, its people can change, switch on and preview nothing
			await adminHolds(w, ['chat.send']);
			for (const body of [{ enabled: false }, { name: 'x' }, { config: COMMAND }]) {
				const res = await patch(w, id, body, w.users.admin);
				expect([res.status, res.message.includes("needs 'Read chat'")]).toEqual([403, true]);
			}
			const dry = await route('POST', 'api/servers/[id]/triggers/dry-run');
			const preview = (who: SessionUser | null) =>
				callApi(dry, who, {
					method: 'POST',
					params: { id: w.server.id },
					body: { kind: 'chat_command', config: COMMAND }
				});
			expect((await preview(w.users.admin)).status).toBe(403);
			expect((await preview(w.users.keyAll)).status).toBe(403);
			expect((await preview(w.users.outsider)).status).toBe(404);
			expect((await preview(null)).status).toBe(401);
			// a key with Automation lists the rules and may delete one, which stops the reading
			const list = await callApi(await route('GET', 'api/servers/[id]/triggers'), w.users.keyAll, {
				params: { id: w.server.id }
			});
			expect((list.body as { triggers: TriggerView[] }).triggers.map((t) => t.kind).sort()).toEqual(
				['chat_command', 'staff_call']
			);
			expect((await patch(w, id, { enabled: false }, w.users.keyAll)).status).toBe(403);
			const del = await callApi(
				await route('DELETE', 'api/servers/[id]/triggers/[triggerId]'),
				w.users.keyAll,
				{ method: 'DELETE', params: { id: w.server.id, triggerId: id } }
			);
			expect(del.status).toBe(200);
			// another organisation's owner reaches none of it
			expect((await patch(w, id, { enabled: false }, w.users.outsider)).status).toBe(404);
		});

		test('a word has one answer on a server: a clash is refused at a save and at a switch-on', async () => {
			const w = await seedWorld(env);
			await rule(w, 'chat_command', { command: 'rules', aliases: 'r', replies: 'x' });
			const clash = await save(w, 'chat_command', {
				command: 'regeln',
				aliases: 'r',
				replies: 'x'
			});
			expect([clash.status, clash.code]).toEqual([409, 'duplicate']);
			expect(clash.message).toContain('!r is already answered by the rule "Chat command"');
			// a Staff call's words are words like any other
			const staffClash = await save(w, 'staff_call', { commands: 'rules' });
			expect([staffClash.status, staffClash.code]).toEqual([409, 'duplicate']);
			// saved switched off, a rule may hold the word; switching it on is refused
			const off = await save(
				w,
				'chat_command',
				{ command: 'regeln', aliases: 'r', replies: 'x' },
				{ enabled: false }
			);
			expect(off.status).toBe(201);
			const offId = (off.body as { trigger: TriggerView }).trigger.id;
			const on = await patch(w, offId, { enabled: true });
			expect([on.status, on.code]).toEqual([409, 'duplicate']);
			expect((await ruleRow(offId)).enabled).toBe(false);
			// with another word it goes on; and an edit to a word that is taken is refused
			expect(
				(await patch(w, offId, { enabled: true, config: { command: 'regeln', replies: 'x' } }))
					.status
			).toBe(200);
			const edit = await patch(w, offId, { config: { command: 'rules', replies: 'x' } });
			expect([edit.status, edit.code]).toEqual([409, 'duplicate']);
			expect((await ruleRow(offId)).config).toMatchObject({ command: 'regeln' });
			// the organisation's other server has its own words
			const elsewhere = await save(
				w,
				'chat_command',
				{ command: 'rules', replies: 'x' },
				{ serverId: w.otherServer.id }
			);
			expect(elsewhere.status).toBe(201);
			// one Staff call rule a server
			expect((await save(w, 'staff_call', { commands: 'mods' })).status).toBe(201);
			const second = await save(w, 'staff_call', { commands: 'helpme' });
			expect([second.status, second.code]).toEqual([409, 'duplicate']);
		});

		test('settings are checked at the door, and a preview shows what it would send', async () => {
			const w = await seedWorld(env);
			const bad = async (kind: 'chat_command' | 'staff_call', config: Record<string, unknown>) =>
				(await save(w, kind, config)).status;
			expect(await bad('chat_command', { command: 'two words', replies: 'x' })).toBe(400);
			expect(await bad('chat_command', { command: 'a'.repeat(21), replies: 'x' })).toBe(400);
			expect(await bad('chat_command', { command: 'rules', replies: '' })).toBe(400);
			expect(
				await bad('chat_command', { command: 'rules', replies: ['1', '2', '3', '4', '5'] })
			).toBe(400);
			expect(await bad('staff_call', { commands: 'admin', reports: 'admin' })).toBe(400);
			expect(await bad('staff_call', { cooldownSeconds: 1 })).toBe(400);
			expect(
				await env.db.select().from(triggers).where(eq(triggers.serverId, w.server.id))
			).toEqual([]);
			await rule(w, 'staff_call', {});
			const dry = await route('POST', 'api/servers/[id]/triggers/dry-run');
			const res = await callApi(dry, w.users.owner, {
				method: 'POST',
				params: { id: w.server.id },
				body: {
					kind: 'chat_command',
					config: { command: 'help', replies: ['On {server}: {commands}', '{name} is rank {rank}'] }
				}
			});
			expect(res.status).toBe(200);
			const result = (res.body as { result: DryRunResult }).result;
			expect(result.fires).toBe(0);
			expect(result.items.map((i) => i.text)).toEqual([
				`!help → the player: On ${(await env.db.select().from(servers).where(eq(servers.id, w.server.id)))[0].name}: !admin !report !help`,
				'!help → the player: Player is rank …'
			]);
			expect(result.notes.join(' ')).toContain('the chat is not kept');
			const staffPreview = await callApi(dry, w.users.owner, {
				method: 'POST',
				params: { id: w.server.id },
				body: { kind: 'staff_call', config: { commands: 'mods' } }
			});
			expect(
				(staffPreview.body as { result: DryRunResult }).result.items.map((i) => i.text)
			).toEqual([
				'once the call is on its way to Discord: Thanks Player: your call is on its way to staff.',
				'nothing after the word: Tell staff what is wrong: !mods <message>',
				'called again too soon: Your last call was passed on, Player. You can send another in 60 s.'
			]);
		});
	});

	test('a Staff calls box is one of a webhook’s, and only an owner ticks it', async () => {
		const w = await seedWorld(env);
		const { POST } = await import(join(ROUTES, 'api/orgs/[id]/webhooks', '+server.ts'));
		const body = {
			label: 'staff',
			url: 'https://discord.com/api/webhooks/123456789012345678/' + 'a'.repeat(68),
			events: ['staffcalls']
		};
		const make = (who: SessionUser | null) =>
			callApi(POST, who, { method: 'POST', params: { id: w.org.id }, body });
		expect((await make(w.users.admin)).status).toBe(403);
		expect((await make(w.users.keyAll)).status).toBe(403);
		expect((await make(w.users.outsider)).status).toBe(404);
		const made = await make(w.users.owner);
		expect(made.status).toBe(201);
		const [row] = await env.db
			.select()
			.from(webhooks)
			.where(and(eq(webhooks.orgId, w.org.id), eq(webhooks.label, 'staff')));
		expect(row.events).toEqual(['staffcalls']);
	});
});
