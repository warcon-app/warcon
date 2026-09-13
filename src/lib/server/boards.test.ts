import { afterEach, describe, expect, test } from 'bun:test';
import { BOARD_MAX_EMBEDS, renderBoard } from './board-render';
import { parseInterval } from './boards';
import { callDiscord } from './webhook-delivery';
import { encryptSecret } from './crypto';
import type { Env } from './env';
import type { LiveView, Player, Status } from '$lib/types';

const player = (name: string, faction: string | null, kills = 0, deaths = 0, cash = 0): Player => ({
	name,
	steamId: '76561198100000001',
	faction,
	kills,
	deaths,
	cash,
	ping: 40
});
const status = (over: Partial<Status> = {}): Status => ({
	serverName: 'EU #1 · 24/7 KOTH',
	map: 'Kavkazi',
	experiences: ['Bakurani_KOTH_01', 'KOTH_InfantryOnly'],
	lighting: 'DayEarlyFog',
	alternator: 'None',
	scoreTick: 10,
	scoreTickMin: 5,
	scoreTickMax: 60,
	scoreCap: 2000,
	matchSeconds: 600,
	playerCount: 3,
	maxPlayers: 64,
	scores: [
		{ name: 'Valkyra', colorHex: '#D86060', score: 1240 },
		{ name: 'Lonestar', colorHex: '#5B95D8', score: 980 }
	],
	rotationNow: 0,
	rotationNext: 1,
	...over
});
const SEEN = '2026-09-13T12:00:00.000Z';
const live = (over: Partial<LiveView> = {}): LiveView => ({
	serverId: 's1',
	ok: true,
	error: '',
	tier: 'hot',
	status: status(),
	players: [
		player('Raven', 'Lonestar', 8, 8, 2500),
		player('Nomad', 'Valkyra', 12, 3, 5000),
		player('Ghost', null, 0, 1, 100)
	],
	statusAt: SEEN,
	playersAt: SEEN,
	observedAt: SEEN,
	...over
});
const NOW = Date.parse('2026-09-13T12:00:30Z');
const base = { appName: 'Warcon', heading: '', intervalMs: 30_000, showPlayers: true, now: NOW };
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const size = (embeds: ReturnType<typeof renderBoard>['embeds']) =>
	embeds.reduce(
		(n, e) =>
			n +
			e.title.length +
			e.description.length +
			(e.footer?.text.length ?? 0) +
			(e.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0),
		0
	);

describe('renderBoard', () => {
	test('an online server: players, labels, a live match clock, scores, players per faction', () => {
		const { content, embeds } = renderBoard({
			...base,
			heading: '**Clan servers**',
			servers: [{ id: 's1', name: 'EU #1', live: live() }]
		});
		expect(content).toBe('**Clan servers**');
		expect(embeds).toHaveLength(1);
		const e = embeds[0];
		expect(e.title).toBe('🟢 EU #1');
		expect(e.description).toContain('**Server** EU #1 · 24/7 KOTH');
		expect(e.description).toContain('**Players** 3 / 64');
		expect(e.description).toContain(
			'**Map** Bakurani · King of the Hill + Infantry Only · Day Early Fog'
		);
		// the match clock counts from the status read, as a Discord timestamp that ticks on its own
		expect(e.description).toContain(`**Match** started <t:${unix('2026-09-13T11:50:00Z')}:R>`);
		expect(e.description).toContain('**Score** Valkyra **1,240** · Lonestar **980** · cap 2,000');
		expect(e.description).not.toContain('Control zone');
		expect(e.color).toBe(0x7bc462);
		expect(e.timestamp).toBe(new Date(NOW).toISOString());
		expect(e.footer?.text).toBe('Warcon · updated every 30 s');
		expect(e.fields?.map((f) => f.name)).toEqual([
			'Valkyra · 1 · $5,000',
			'Lonestar · 1 · $2,500',
			'Unassigned · 1 · $100'
		]);
		expect(e.fields?.map((f) => f.value)).toEqual(['Nomad 12/3', 'Raven 8/8', 'Ghost 0/1']);
		expect(e.fields?.every((f) => f.inline)).toBe(true);
	});

	test('the in-game name is left out when it is the panel name; a control zone is named', () => {
		const { embeds } = renderBoard({
			...base,
			servers: [
				{
					id: 's1',
					name: 'eu #1 · 24/7 koth',
					live: live({ status: status({ alternator: 'ZoneAlternator.Random.Fast' }) })
				}
			]
		});
		expect(embeds[0].description).not.toContain('**Server**');
		expect(embeds[0].description).toContain('**Control zone** Random Fast');
	});

	test('an unreachable server says so and when it was last seen', () => {
		const { embeds } = renderBoard({
			...base,
			servers: [
				{
					id: 's1',
					name: 'EU #1',
					live: live({ ok: false, error: 'Connection refused', tier: 'offline' })
				}
			]
		});
		expect(embeds[0].title).toBe('🔴 EU #1');
		expect(embeds[0].description).toContain('**Unreachable.** Connection refused');
		expect(embeds[0].description).toContain(`Last seen <t:${unix(SEEN)}:R> with 3 on Bakurani.`);
		expect(embeds[0].color).toBe(0xd86060);
		expect(embeds[0].fields).toBeUndefined();
	});

	test('a server never observed, and a board without servers', () => {
		const { embeds } = renderBoard({ ...base, servers: [{ id: 's1', name: 'New', live: null }] });
		expect(embeds[0].title).toBe('⚪ New');
		expect(embeds[0].description).toBe('Not observed yet.');
		const empty = renderBoard({ ...base, servers: [] });
		expect(empty.embeds).toHaveLength(1);
		expect(empty.embeds[0].title).toBe('No servers');
		expect(empty.content).toBe('');
	});

	test('players can be left out; an empty server lists nobody', () => {
		const quiet = renderBoard({
			...base,
			showPlayers: false,
			servers: [{ id: 's1', name: 'EU #1', live: live() }]
		});
		expect(quiet.embeds[0].fields).toBeUndefined();
		const empty = renderBoard({
			...base,
			servers: [
				{ id: 's1', name: 'EU #1', live: live({ players: [], status: status({ playerCount: 0 }) }) }
			]
		});
		expect(empty.embeds[0].description).toContain('**Players** 0 / 64');
		expect(empty.embeds[0].fields).toBeUndefined();
	});

	test('a message holds ten servers; the rest are counted in the text', () => {
		const servers = Array.from({ length: 12 }, (_, i) => ({
			id: `s${i}`,
			name: `Server ${i}`,
			live: live()
		}));
		const { content, embeds } = renderBoard({ ...base, heading: 'Servers', servers });
		expect(embeds).toHaveLength(BOARD_MAX_EMBEDS);
		expect(content).toBe('Servers\n2 more servers not shown: a message holds 10.');
	});

	test('long player lists are trimmed together to fit Discord, short ones are kept whole', () => {
		const roster = (name: (i: number) => string) =>
			Array.from({ length: 64 }, (_, i) =>
				player(name(i), i % 2 ? 'Valkyra' : 'Lonestar', 64 - i, 1, 100)
			);
		const full = live({ players: roster((i) => `Player with a long name ${i}`) });
		const servers = Array.from({ length: 10 }, (_, i) => ({
			id: `s${i}`,
			name: `Server ${i}`,
			live: full
		}));
		const { embeds } = renderBoard({ ...base, servers });
		expect(size(embeds)).toBeLessThanOrEqual(6000);
		for (const e of embeds)
			for (const f of e.fields ?? []) {
				expect(f.value.length).toBeLessThanOrEqual(1024);
				expect(f.value).toMatch(/, \+\d+ more$/);
			}
		expect(embeds[0].fields?.[0].value).toMatch(/^Player with a long name 1 63\/1, /);
		const one = renderBoard({
			...base,
			servers: [{ id: 's1', name: 'EU', live: live({ players: roster((i) => `P${i}`) }) }]
		});
		expect(one.embeds[0].fields?.map((f) => f.value.split(', ').length)).toEqual([32, 32]);
		expect(one.embeds[0].fields?.some((f) => /more$/.test(f.value))).toBe(false);
	});
});

describe('parseInterval', () => {
	test('defaults, accepts the bounds and refuses the rest', () => {
		expect(parseInterval(undefined)).toBe(30_000);
		expect(parseInterval('', 45_000)).toBe(45_000);
		expect(parseInterval(10_000)).toBe(10_000);
		expect(parseInterval('3600000')).toBe(3_600_000);
		expect(() => parseInterval(5000)).toThrow('intervalMs');
		expect(() => parseInterval(3_600_001)).toThrow('intervalMs');
		expect(() => parseInterval('soon')).not.toThrow();
	});
});

describe('callDiscord', () => {
	const env = { ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), APP_NAME: 'Warcon' } as Env;
	const url = `https://discord.com/api/webhooks/123456789012345678/${'t'.repeat(68)}`;
	const hook = { urlEnc: encryptSecret(env, url) };
	const calls: { url: string; init: RequestInit }[] = [];
	const real = globalThis.fetch;
	const answer = (status: number, body?: unknown, headers?: Record<string, string>) => {
		globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init: init ?? {} });
			return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
		}) as unknown as typeof fetch;
	};
	afterEach(() => {
		globalThis.fetch = real;
		calls.length = 0;
	});

	test('a post waits for the message and reports its id', async () => {
		answer(200, { id: '999' });
		const r = await callDiscord(env, hook, { payload: { content: 'hi' } });
		expect(r).toEqual({ ok: true, status: 200, error: '', messageId: '999' });
		expect(calls[0].url).toBe(`${url}?wait=true`);
		expect(calls[0].init.method).toBe('POST');
		expect(JSON.parse(String(calls[0].init.body))).toEqual({
			username: 'Warcon',
			allowed_mentions: { parse: [] },
			content: 'hi'
		});
	});

	test('an edit goes to the message and sends no username', async () => {
		answer(200, { id: '999' });
		const r = await callDiscord(env, hook, {
			method: 'PATCH',
			messageId: '999',
			payload: { content: '', embeds: [] }
		});
		expect(r.ok).toBe(true);
		expect(calls[0].url).toBe(`${url}/messages/999`);
		expect(calls[0].init.method).toBe('PATCH');
		expect(JSON.parse(String(calls[0].init.body))).toEqual({
			allowed_mentions: { parse: [] },
			content: '',
			embeds: []
		});
	});

	test('a removal sends no body and takes a 204', async () => {
		answer(204);
		const r = await callDiscord(env, hook, { method: 'DELETE', messageId: '999' });
		expect(r).toEqual({ ok: true, status: 204, error: '' });
		expect(calls[0].url).toBe(`${url}/messages/999`);
		expect(calls[0].init.body).toBeUndefined();
	});

	test('a deleted message is a 404 the caller can act on; a 429 says when to retry', async () => {
		answer(404, { message: 'Unknown Message' });
		expect(await callDiscord(env, hook, { method: 'PATCH', messageId: '1' })).toMatchObject({
			ok: false,
			status: 404
		});
		answer(429, { retry_after: 2.5 });
		expect(await callDiscord(env, hook, { payload: { content: 'x' } })).toMatchObject({
			ok: false,
			status: 429,
			retryAfterMs: 2500
		});
	});
});
