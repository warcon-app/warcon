// What a Discord channel is told of a whisper sent by hand, through the real route: what it said, as
// the audit trail keeps it, and never what someone refused typed. Long ones in a burst go as more
// than one message, since Discord refuses a message of more than 6,000 characters.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { and, desc, eq } from 'drizzle-orm';
import type { Env } from '$lib/server/env';
import { MAX_CHAT } from '$lib/chat';
import { auditLog } from '$lib/server/db/schema';
import { resetWebhookQueues } from '$lib/server/webhook-delivery';
import { hasTestDb, testEnv } from './db';
import { callApi, stubGateway } from './call';
import { seedWorld, type PrincipalName, type World } from './world';
import { POST as createRoute } from '../routes/api/orgs/[id]/webhooks/+server';
import { POST as actionRoute } from '../routes/api/servers/[id]/rcon/[action]/+server';

const TOKEN = 'a'.repeat(68);
const COMMANDS = '100000000000000021';
const urlOf = (id: string) => `https://discord.com/api/webhooks/${id}/${TOKEN}`;
const PLAYER = '76561198000000981';

describe.skipIf(!hasTestDb)('whispers on Discord', () => {
	let env: Env;
	let w: World;
	const posts: { url: string; cards: { title: string; description: string }[] }[] = [];
	/** the size of each message Discord refused */
	const refused: number[] = [];
	const realFetch = globalThis.fetch;

	/** the cards the channel was sent since the last call, once `n` have come (the queue posts a
	 *  second and a half after its first card, at once at ten) or four seconds have gone, within the
	 *  test's five */
	const sent = async (n: number) => {
		const cards = () =>
			posts.filter((p) => p.url.startsWith(urlOf(COMMANDS))).flatMap((p) => p.cards);
		for (let i = 0; i < 40 && cards().length < n; i++) await Bun.sleep(100);
		const got = cards();
		posts.length = 0;
		return got;
	};
	const whisper = (who: PrincipalName, message: string) =>
		callApi(actionRoute, w.users[who], {
			method: 'POST',
			params: { id: w.server.id, action: 'whisper' },
			body: { steamId: PLAYER, message }
		});

	beforeAll(async () => {
		env = await testEnv();
		stubGateway({ message: 'OK: message delivered to Player.' });
		w = await seedWorld(env);
		globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body ?? '{}')) as {
				embeds?: { title: string; description: string; footer?: { text: string } }[];
			};
			const embeds = body.embeds ?? [];
			// as Discord: no more than 6,000 characters across a message's embeds
			const chars = embeds.reduce(
				(n, e) => n + e.title.length + e.description.length + (e.footer?.text.length ?? 0),
				0
			);
			if (chars > 6000) {
				refused.push(chars);
				return new Response('{"code":50035,"message":"Invalid Form Body"}', { status: 400 });
			}
			posts.push({
				url: String(url),
				cards: embeds.map((e) => ({ title: e.title, description: e.description }))
			});
			return new Response('{"id":"1"}', { status: 200 });
		}) as typeof fetch;
		const made = await callApi(createRoute, w.users.owner, {
			method: 'POST',
			params: { id: w.org.id },
			body: { url: urlOf(COMMANDS), events: ['commands'] }
		});
		expect(made.status).toBe(201);
	});

	afterAll(() => {
		globalThis.fetch = realFetch;
		resetWebhookQueues();
	});

	test('a whisper says what it said, as the trail keeps it', async () => {
		expect((await whisper('operator', 'Stop camping our main, last warning')).status).toBe(200);
		const cards = await sent(1);
		expect(cards.map((c) => c.title)).toEqual(['Whisper']);
		expect(cards[0].description).toContain(`→ \`${PLAYER}\`\nServer: `);
		expect(cards[0].description).toEndWith(
			'\nMessage: Stop camping our main, last warning\nOK: message delivered to Player.'
		);
		const [row] = await env.db
			.select({ detail: auditLog.detail })
			.from(auditLog)
			.where(and(eq(auditLog.serverId, w.server.id), eq(auditLog.action, 'rcon.whisper')))
			.orderBy(desc(auditLog.id))
			.limit(1);
		expect(row.detail).toEqual({ steamId: PLAYER, message: 'Stop camping our main, last warning' });
	});

	test('a group whisper says it once, after the faction it went to', async () => {
		const res = await callApi(actionRoute, w.users.operator, {
			method: 'POST',
			params: { id: w.server.id, action: 'whisperMany' },
			body: { faction: 'Valkyra', message: 'Push B with us' }
		});
		expect(res.status).toBe(200);
		const cards = await sent(1);
		expect(cards.map((c) => c.title)).toEqual(['Group whisper']);
		expect(cards[0].description).toContain('→ `Valkyra`\nServer: ');
		expect(cards[0].description).toContain('\nMessage: Push B with us\n');
		expect(cards[0].description.split('Push B with us')).toHaveLength(2);
	});

	test('a refused whisper posts without what was typed', async () => {
		expect((await whisper('viewer', 'typed without Chat')).status).toBe(403);
		const cards = await sent(1);
		expect(cards.map((c) => c.title)).toEqual(['Whisper']);
		expect(cards[0].description).toContain('Outcome: **denied** (403)');
		expect(cards[0].description).not.toContain('typed without Chat');
	});

	test('a key with Chat posts its words; no one else gets a word into the channel', async () => {
		expect((await whisper('anon', 'from no one')).status).toBe(401);
		expect((await whisper('outsider', 'from another org')).status).toBe(404);
		expect((await whisper('elsewhere', 'from an admin of another server')).status).toBe(404);
		expect((await whisper('keyElsewhere', 'from a key held to another server')).status).toBe(404);
		expect((await whisper('keyView', 'from a View key')).status).toBe(403);
		expect((await whisper('keyAll', 'from a key with Chat')).status).toBe(200);
		const cards = await sent(2);
		// the View key's refusal, then the whisper
		expect(cards.map((c) => c.title)).toEqual(['Whisper', 'Whisper']);
		expect(cards[0].description).toContain('Outcome: **denied** (403)');
		expect(cards[1].description).toEndWith(
			'\nMessage: from a key with Chat\nOK: message delivered to Player.'
		);
		const all = cards.map((c) => c.description).join('\n');
		for (const typed of [
			'from no one',
			'from another org',
			'from an admin of another server',
			'from a key held to another server',
			'from a View key'
		])
			expect(all).not.toContain(typed);
	});

	test('ten long whispers at once all reach the channel, in messages Discord takes', async () => {
		// escaped, each card is over 600 characters: ten are more than Discord takes in one message
		const said = Array.from({ length: 10 }, (_, i) =>
			`${i}${'*_'.repeat(MAX_CHAT)}`.slice(0, MAX_CHAT)
		);
		const answers = await Promise.all(said.map((message) => whisper('operator', message)));
		expect(answers.map((a) => a.status)).toEqual(said.map(() => 200));
		const cards = await sent(10);
		expect(refused).toEqual([]);
		expect(cards).toHaveLength(10);
		for (let i = 0; i < 10; i++)
			expect(cards.filter((c) => c.description.includes(`\nMessage: ${i}\\*\\_`))).toHaveLength(1);
	});
});
