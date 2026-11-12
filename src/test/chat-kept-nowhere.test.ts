// Players' chat is read under the game's chat terms, which forbid recording, storing, exporting or
// sharing it, so the panel's rule is that a chat line is written nowhere: it goes from the game to
// the page of whoever holds Read chat. chat.test.ts shows who may read it and that the audit trail
// holds no line. This suite is the fence round the rule, there to fail when a later change starts
// keeping chat without meaning to:
//
//   - every table of the database is searched after the lines have been read, refused and failed
//     on, with reads audited and a Discord and a JSON webhook taking everything they can;
//   - so is everything the process sent out and wrote to its log, and what the worker holds of the
//     server in memory;
//   - the worker's own look at a server never asks the game for its chat, unless the server has a
//     chat rule switched on (a Chat command or a Staff call; chat-look.ts). That reader was a
//     decision, made with the chat rules, and chat-commands.test.ts holds it to the same rule:
//     nothing typed reaches a table, a log line, the worker's memory or a request out, but for
//     what a player sends staff through a Staff call, which goes to the Discord webhooks that
//     take Staff calls and nowhere else;
//   - the same reads through the relay, as where the web and the worker run apart;
//   - a feed event that carries chat is dropped, as every event of a type Warcon does not know is;
//   - and the source: which files may name the game's chat routes, read its lines or ask for them.
//
// A test here that fails on a change is that change keeping, sending or reading players' chat
// somewhere new. That is a decision about the game's terms, to be made before the change and not
// by editing this file until it passes.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { inspect } from 'node:util';
import { eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import type { SessionUser } from '$lib/server/access';
import { organizations, servers } from '$lib/server/db/schema';
import { ingestBatch } from '$lib/server/feed';
import { setGateway } from '$lib/server/gateway';
import { localGateway } from '$lib/server/gateway-local';
import { call } from '$lib/server/gateway-remote';
import { JSON_WEBHOOK_EVENTS } from '$lib/server/json-webhook-events';
import { acquireOrRenew, releaseOwnership } from '$lib/server/leadership';
import { forgetMemory, memoryFor, memoryOf, observeServer } from '$lib/server/observe';
import { WardogsClient } from '$lib/server/rcon';
import { RELAY_PREFIX, serializeError } from '$lib/server/relay';
import type { GameResponse } from '$lib/server/transport';
import { resetWebhookQueues, WEBHOOK_EVENTS } from '$lib/server/webhook-delivery';
import type { ChatRead } from '$lib/chat-read';
import { relay } from '../worker/runtime';
import { hasTestDb, testEnv } from './db';
import { callApi, callRaw, stubGateway, type CallInput } from './call';
import { seedWorld, type World } from './world';
import { POST as addDiscord } from '../routes/api/orgs/[id]/webhooks/+server';
import { POST as addJson } from '../routes/api/orgs/[id]/json-webhooks/+server';
import {
	GET as readAction,
	POST as sendAction
} from '../routes/api/servers/[id]/rcon/[action]/+server';

// What only the chat carries in this run: a word in every line's text, in what was typed and in
// both of the speaker's names, and a SteamID nobody else has.
const MARK = `kn${randomBytes(6).toString('hex')}`;
const STEAM = `7656119${randomInt(1_000_000_000, 9_999_999_999)}`;
const MARKS = [MARK, STEAM];
const marked = (text: string) => MARKS.some((m) => text.includes(m));

const line = (seq: number) => ({
	seq,
	sentUtc: new Date(Date.now() - (10 - seq) * 1000).toISOString(),
	channel: 'Global',
	faction: 'RED',
	steamId: STEAM,
	realName: `Real ${MARK}`,
	hiddenName: `Amber ${MARK}`,
	anonymous: seq % 2 === 0,
	text: `${MARK} they are camping the north gate`,
	rawText: `${MARK} they are c4mping the north gate`,
	ping: false
});
const CHAT = { latestSeq: 3, messages: [line(1), line(2), line(3)], count: 3 };
/** the lines as a reader is given them */
const AS_READ = CHAT.messages.map((m) => [STEAM, m.text, m.rawText, m.realName, m.hiddenName]);
const answers = (status: number, data: unknown): GameResponse => ({
	status,
	statusText: '',
	headers: { 'content-type': 'application/json' },
	text: typeof data === 'string' ? data : JSON.stringify(data)
});
/**
 * The game failing with the lines in its answer, and what the reader is told: that it failed, in
 * the panel's words or the game's own error text. The answer's body goes no further.
 */
const FAILURES: [() => GameResponse, number, string][] = [
	// an error with the lines beside it
	[() => answers(500, { error: { code: 'internal', message: 'boom' }, ...CHAT }), 502, 'internal'],
	// the stored password rejected, which is recorded for a read too
	[
		() => answers(401, { error: { code: 'unauthorized', message: 'bad key' }, ...CHAT }),
		502,
		'unauthorized'
	],
	// a 200 that is not a chat read: lines without their numbers, and text that is not JSON
	[
		() => answers(200, { messages: CHAT.messages.map(({ seq: _seq, ...rest }) => rest) }),
		502,
		'bad_response'
	],
	[() => answers(200, `<html>${CHAT.messages[0].text} ${STEAM}</html>`), 502, 'bad_response']
];

const DISCORD = `https://discord.com/api/webhooks/100000000000000077/${'k'.repeat(68)}`;
const RECEIVER = 'https://93.184.216.34/in/kept-nowhere';

/** The tables of the database with a row that holds any of these, each row read as text. */
async function tablesHolding(env: Env, needles: string[]): Promise<string[]> {
	// a hypertable is read whole through its own name, its chunks with it
	const tables = (await env.sql.unsafe(
		`SELECT table_schema AS s, table_name AS t FROM information_schema.tables
		 WHERE table_type = 'BASE TABLE'
		   AND table_schema NOT IN ('pg_catalog', 'information_schema')
		   AND table_schema !~ '^_?timescaledb'
		 ORDER BY 1, 2`
	)) as { s: string; t: string }[];
	expect(tables.length).toBeGreaterThan(40);
	const found: string[] = [];
	for (const { s, t } of tables) {
		const where = needles.map((_, i) => `strpos(r::text, $${i + 1}) > 0`).join(' OR ');
		const [{ n }] = (await env.sql.unsafe(
			`SELECT count(*)::int AS n FROM "${s}"."${t}" AS r WHERE ${where}`,
			needles
		)) as { n: number }[];
		if (n) found.push(`${s}.${t}`);
	}
	return found;
}

/** Runs `fn` and gives back what the process wrote to its log meanwhile. */
async function logOf(fn: () => Promise<void>): Promise<string[]> {
	const logged: string[] = [];
	const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
		spyOn(console, level).mockImplementation((...args: unknown[]) => {
			logged.push(
				args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' ')
			);
		})
	);
	try {
		await fn();
	} finally {
		for (const s of spies) s.mockRestore();
	}
	return logged;
}

describe.skipIf(!hasTestDb)('players’ chat is kept nowhere', () => {
	let env: Env;
	let w: World;
	let spy: ReturnType<typeof spyOn>;
	let auditReads: string | undefined;
	const realFetch = globalThis.fetch;
	/** every request the game was sent, in order */
	const asked: string[] = [];
	const chatAsks = () => asked.filter((a) => /^GET \/v1\/chat(\?|$)/.test(a)).length;
	/** how the game answers a read of its chat */
	let chat: () => GameResponse = () => answers(200, CHAT);
	/** everything the process sent out: Discord, a JSON webhook's receiver, anything else */
	const out: { url: string; body: string }[] = [];
	/** what the web sent the worker over the relay, where the two run apart */
	const relayed: string[] = [];

	beforeAll(async () => {
		env = await testEnv();
		w = await seedWorld(env);
		setGateway(localGateway);
		expect(await acquireOrRenew(env, 'chat-kept-nowhere')).toBe(true);
		// reads audited, so a read is a row in the trail and a card on Discord as well as a refusal
		auditReads = env.AUDIT_LOG_READS;
		(env as { AUDIT_LOG_READS?: string }).AUDIT_LOG_READS = 'true';
		// The demo game, but for its chat: the lines are this run's own, whatever the terms say.
		spy = spyOn(WardogsClient, 'forServer').mockImplementation(async (_env, server) => {
			const client = new WardogsClient(
				env,
				{ id: server.id, host: 'demo', port: 1, scheme: 'http' },
				'demo',
				`kept-nowhere-${server.id}`
			);
			const raw = client.raw.bind(client);
			client.raw = async (method, path, body, headers) => {
				asked.push(`${method} ${path}`);
				return /^\/v1\/chat(\?|$)/.test(path) ? chat() : raw(method, path, body, headers);
			};
			return client;
		});
		globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
			// the relay is the panel talking to itself: its requests are let through, and looked at
			if (String(url).startsWith('http://127.0.0.1:')) {
				relayed.push(String(init?.body ?? ''));
				return realFetch(url, init);
			}
			out.push({ url: String(url), body: String(init?.body ?? '') });
			return new Response('{"id":"1"}', { status: 200 });
		}) as typeof fetch;
		// a Discord channel and a JSON webhook that take every kind of event there is
		const discord = await callApi(addDiscord, w.users.owner, {
			method: 'POST',
			params: { id: w.org.id },
			body: { url: DISCORD, events: [...WEBHOOK_EVENTS] }
		});
		expect(discord.status).toBe(201);
		const json = await callApi(addJson, w.users.owner, {
			method: 'POST',
			params: { id: w.org.id },
			body: {
				label: 'Everything',
				url: RECEIVER,
				events: [...JSON_WEBHOOK_EVENTS],
				serverIds: null
			}
		});
		expect(json.status).toBe(201);
	});

	afterAll(async () => {
		globalThis.fetch = realFetch;
		spy?.mockRestore();
		resetWebhookQueues();
		if (w) forgetMemory(w.server.id);
		if (env) {
			(env as { AUDIT_LOG_READS?: string }).AUDIT_LOG_READS = auditReads;
			await releaseOwnership(env);
		}
		stubGateway();
	});

	/** An action through its route: the status, the answer as it went out, and its caching. */
	const rcon = async (
		who: SessionUser | null,
		method: 'GET' | 'POST',
		action: string,
		input: Omit<CallInput, 'method' | 'params'> = {}
	) => {
		const res = await callRaw(method === 'GET' ? readAction : sendAction, who, {
			...input,
			method,
			params: { id: w.server.id, action }
		});
		const text = await res.text();
		const body = JSON.parse(text) as { result?: unknown; error?: { code?: string } };
		return {
			status: res.status,
			text,
			cache: res.headers.get('cache-control'),
			result: body.result,
			code: body.error?.code ?? ''
		};
	};
	const linesOf = (answer: { result?: unknown }) =>
		(answer.result as ChatRead).lines.map((l) => [
			l.steamId,
			l.text,
			l.typed,
			l.name,
			l.hiddenName
		]);
	/** every failure the game can make of a read, each told to the reader without a word of the lines */
	const failEachWay = async () => {
		for (const [answer, status, code] of FAILURES) {
			chat = answer;
			const got = await rcon(w.users.owner, 'GET', 'chat');
			expect([got.status, got.code]).toEqual([status, code]);
			expect(marked(got.text)).toBe(false);
		}
		chat = () => answers(200, CHAT);
	};

	test('read, refused and failed on, with everything listening: no table, log line, request out or memory holds a line', async () => {
		const logged = await logOf(async () => {
			// The terms accepted, as on a server whose chat is being read.
			expect(
				(await rcon(w.users.owner, 'POST', 'chatTermsAccept', { body: { version: 1 } })).status
			).toBe(200);

			// The worker's own look at the server, twice (the second knows what the build serves): it
			// reads the status and the players, never the chat. From here on the worker holds the
			// server in memory, as it does every server it watches.
			const [server] = await env.db.select().from(servers).where(eq(servers.id, w.server.id));
			const [org] = await env.db.select().from(organizations).where(eq(organizations.id, w.org.id));
			const quiet = { ...env, STEAM_API_KEY: '' };
			const look = async () => {
				const before = asked.length;
				await observeServer(quiet, memoryFor(server, org), { status: true, players: true });
				const looked = asked.slice(before);
				expect(looked).toContain('GET /v1/players');
				expect(looked.filter((a) => /chat/i.test(a))).toEqual([]);
			};
			await look();
			await look();

			// The lines reach the reader, whole, in an answer nothing may store on its way.
			const read = await rcon(w.users.owner, 'GET', 'chat');
			expect(read.status).toBe(200);
			expect(linesOf(read)).toEqual(AS_READ);
			expect(read.cache).toBe('no-store');
			expect((await rcon(w.users.owner, 'GET', 'chat', { query: 'after=1&limit=2' })).status).toBe(
				200
			);
			expect((await rcon(w.users.owner, 'GET', 'chatTerms')).status).toBe(200);
			expect(chatAsks()).toBe(2);

			// Refused: each refusal is a row in the trail and a card on Discord, and the game is not asked.
			for (const who of [w.users.viewer, w.users.admin, w.users.keyAll])
				expect((await rcon(who, 'GET', 'chat')).status).toBe(403);
			// Raw RCON is refused the route too, so this row names a path and holds no answer.
			const raw = await rcon(w.users.owner, 'POST', 'raw', {
				body: { method: 'GET', path: '/v1/chat?after=0&limit=500' }
			});
			expect([raw.status, raw.code]).toEqual([403, 'use_chat']);
			expect(chatAsks()).toBe(2);

			// The game failing with the lines in its answer, then answering again: the last thing that
			// went through the worker is a read.
			await failEachWay();
			expect((await rcon(w.users.owner, 'GET', 'chat')).status).toBe(200);
			expect(chatAsks()).toBe(3 + FAILURES.length);

			// The worker looks again, after the chat has been read through it: still not at the chat,
			// and what it holds of the server in memory has no line.
			await look();
			expect(memoryOf(w.server.id)?.players.length).toBeGreaterThan(0);
			expect(
				marked(
					inspect(memoryOf(w.server.id), { depth: 12, maxStringLength: null, maxArrayLength: null })
				)
			).toBe(false);

			// The cards for all of that have gone to Discord (the queue posts a second and a half
			// after its first card): the refusals and the audited reads, each by its title alone.
			const cards = () =>
				out
					.filter((o) => o.url.startsWith(DISCORD))
					.flatMap((o) => (JSON.parse(o.body) as { embeds?: { title: string }[] }).embeds ?? [])
					.map((e) => e.title);
			for (let i = 0; i < 80 && cards().filter((t) => t === 'Read chat').length < 3; i++)
				await Bun.sleep(100);
			expect(cards().filter((t) => t === 'Read chat').length).toBeGreaterThanOrEqual(3);
		});

		// Nothing sent out, nothing logged and no table holds a word of it. The search does see what
		// is kept: the trail has its rows for the reads.
		expect(out.filter((o) => marked(o.url) || marked(o.body))).toEqual([]);
		expect(logged.filter(marked)).toEqual([]);
		expect(await tablesHolding(env, ['rcon.chat'])).toContain('public.audit_log');
		expect(await tablesHolding(env, MARKS)).toEqual([]);
	}, 30_000);

	test('the same through the relay, as where the web and the worker run apart', async () => {
		// The worker's relay as startWorker serves it (worker/runtime.ts), without its poller.
		const worker = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			async fetch(req) {
				const url = new URL(req.url);
				try {
					return await relay(env, url.pathname.slice(RELAY_PREFIX.length), url, req);
				} catch (err) {
					const e = serializeError(err);
					return Response.json({ ok: false, error: e }, { status: e.kind === 'other' ? 500 : 200 });
				}
			}
		});
		const web = {
			...env,
			RELAY_URL: `http://127.0.0.1:${worker.port}`,
			RELAY_SECRET: 'r'.repeat(48)
		} as Env;
		setGateway({
			...localGateway,
			run: (_env, server, action, params, priority) =>
				call(web, '/run', { serverId: server.id, action, params, priority })
		});
		const sent = relayed.length;
		const before = chatAsks();
		try {
			const logged = await logOf(async () => {
				const read = await rcon(w.users.owner, 'GET', 'chat');
				expect(read.status).toBe(200);
				expect(linesOf(read)).toEqual(AS_READ);
				expect(read.cache).toBe('no-store');
				await failEachWay();
			});
			// each went to the game through the worker, and the web's requests to it held no line
			expect(chatAsks() - before).toBe(1 + FAILURES.length);
			expect(relayed.length - sent).toBe(1 + FAILURES.length);
			expect(relayed.filter(marked)).toEqual([]);
			expect(logged.filter(marked)).toEqual([]);
			expect(out.filter((o) => marked(o.url) || marked(o.body))).toEqual([]);
			expect(await tablesHolding(env, MARKS)).toEqual([]);
		} finally {
			setGateway(localGateway);
			await worker.stop(true);
		}
	}, 30_000);

	test('a feed event that carries chat is dropped, and a kill keeps only what a kill is', async () => {
		const about = {
			eventTime: 120,
			matchId: randomUUID(),
			mapName: 'Kavkazi'
		};
		const said = {
			playerName: `Real ${MARK}`,
			playerSteamId: STEAM,
			channel: 'Global',
			text: `${MARK} gg`,
			rawText: `${MARK} gg`,
			message: `${MARK} gg`
		};
		const r = await ingestBatch(env, w.server.id, {
			serverId: randomUUID(),
			serverName: 'Test',
			events: [
				// types the game does not send today; were it to, they are not Warcon's to keep
				{ ...about, eventId: randomUUID(), type: 'chat', ...said },
				{ ...about, eventId: randomUUID(), type: 'chat_message', ...said },
				{ ...about, eventId: randomUUID(), type: 'player_chat', ...said },
				// a kill with words on it: the kill is kept, its named fields alone
				{
					...about,
					eventId: randomUUID(),
					type: 'killed',
					killerName: 'Alpha',
					killerSteamId: '76561198000000001',
					victimName: 'Bravo',
					victimSteamId: '76561198000000002',
					cause: 'Id.Item.AK74M',
					distance: 70,
					contextTags: [],
					chat: said,
					lastMessage: `${MARK} nice shot`
				}
			]
		});
		expect([r.accepted, r.other, r.skipped]).toEqual([1, 0, 3]);
		expect(await tablesHolding(env, MARKS)).toEqual([]);
	});
});

// The same rule read off the source, without a database: the places that may touch players' chat
// are listed here, so a new one is a change to this file and is seen for what it is.
describe('players’ chat: the code that may touch it', () => {
	const SRC = join(import.meta.dir, '..');
	const walk = (dir: string): string[] =>
		readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
			e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]
		);
	// the panel's own code: not its tests, and not the demo game, which plays the game's part
	const files = walk(SRC)
		.map((f) => relative(SRC, f))
		.filter((f) => /\.(ts|svelte)$/.test(f) && !/\.test\.ts$/.test(f) && !f.startsWith('test/'))
		.filter((f) => f !== 'lib/server/mockgame.ts');
	const read = (file: string) => readFileSync(join(SRC, file), 'utf8');
	const holding = (re: RegExp) => files.filter((f) => re.test(read(f))).sort();
	const CHAT_TAB = 'routes/(app)/server/[id]/chat/+page.svelte';

	test('the game’s chat routes are named by the action registry alone', () => {
		expect(files.length).toBeGreaterThan(200);
		expect(holding(/\/v1\/chat/)).toEqual([
			// the routes' shapes, in its header
			'lib/chat-read.ts',
			// chatTerms, chatTermsAccept and chat; what raw refuses; whether a build serves them
			'lib/server/actions.ts',
			// the feature flag's comment
			'lib/types.ts'
		]);
		// in the registry: the three actions' own requests, and no other
		const requests = [
			...read('lib/server/actions.ts').matchAll(/c\.json\(\s*'(\w+)',\s*[`']\/v1\/chat([^`']*)/g)
		];
		expect(requests.map((m) => `${m[1]} ${m[2].replace(/\?.*$/, '')}`)).toEqual([
			'GET /terms',
			'POST /terms',
			'GET '
		]);
	});

	test('the lines are shaped by the action registry, shown by the Chat tab and read by the chat rules, and by nothing else', () => {
		expect(holding(/chat-read['"]/)).toEqual([
			// what counts as a command in one line, and whom a report names (a line's type alone)
			'lib/chat-commands.ts',
			'lib/server/actions.ts',
			// the worker's read for a server with a chat rule on: the page size and a read's type
			'lib/server/chat-look.ts',
			// the step that decides what one read brings (a line's type alone)
			'lib/server/chat-rules.ts',
			CHAT_TAB
		]);
	});

	test('the chat is read from the game in one place, for the Chat tab and for the chat rules', () => {
		// the request itself, and its two callers on the server: the registry's action and the
		// worker's chat stage (the Chat tab has a function of the same name, which asks the action)
		expect(holding(/\breadChat\(/).filter((f) => f.startsWith('lib/server/'))).toEqual([
			'lib/server/actions.ts',
			'lib/server/chat-look.ts'
		]);
		// the chat stage is run by the worker's look and by nothing else
		expect(holding(/\bkeepChat\(/)).toEqual(['lib/server/chat-look.ts', 'lib/server/observe.ts']);
		// and it keeps nothing: no row but a rule's own (how often it answered, what it waits for),
		// no outbox action, no audit row, no event for a page or a JSON webhook
		const stage = read('lib/server/chat-look.ts');
		expect(stage).not.toMatch(/\.insert\(|enqueueIntents|writeAudit|queueEvent|\bemit\(/);
		expect([...stage.matchAll(/\.update\((\w+)\)/g)].map((m) => m[1])).toEqual([
			'triggers',
			'triggers'
		]);
	});

	test('nothing asks for the chat by name but the Chat tab: no other page, and the worker by its own stage alone', () => {
		// observe.ts: the label of the look's chat stage (keepChat, above), not a request by name
		expect(holding(/['"`]chat['"`]/)).toEqual(['lib/server/observe.ts', CHAT_TAB]);
		// and no one runs the action from the registry directly
		expect(holding(/ACTIONS\s*(\.\s*chat\b|\[\s*['"`]chat)/)).toEqual([]);
	});

	test('the Chat tab holds its lines in the page: no browser storage, no download, nothing of them sent back', () => {
		for (const file of [CHAT_TAB, 'lib/chat-read.ts'])
			expect({
				file,
				keeps:
					/localStorage|sessionStorage|indexedDB|document\.cookie|\bcaches\.|sendBeacon|createObjectURL|\bdownload\b|export const snapshot/.exec(
						read(file)
					)?.[0]
			}).toEqual({ file, keeps: undefined });
		const page = read(CHAT_TAB);
		// what the tab sends the panel: an owner's acceptance, by its version, and nothing else
		expect([...page.matchAll(/\brconPost(?:<[^(]*>)?\(([^)]*)\)/g)].map((m) => m[1])).toEqual([
			"id, 'chatTermsAccept', { version }"
		]);
		// its other requests are reads: the terms, the lines, and the live view for the sides' colours
		expect([...page.matchAll(/\brconGet(?:<[^(]*>)?\(\s*id,\s*'(\w+)'/g)].map((m) => m[1])).toEqual(
			['chatTerms', 'chat']
		);
		expect([...page.matchAll(/\bapi(?:<[^(]*>)?\(\s*'(\w+)'/g)].map((m) => m[1])).toEqual(['GET']);
		expect(page).not.toMatch(/\bfetch\(/);
	});
});
