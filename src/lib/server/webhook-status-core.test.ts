import { describe, expect, test } from 'bun:test';
import type { LiveView, Player, Status } from '$lib/types';
import {
	buildStatusEmbed,
	cardLinks,
	clampInterval,
	embedLength,
	escapeMarkdown,
	factionFields,
	fitLines,
	LIMITS,
	modeLabel,
	squareFor,
	statusMessage
} from './webhook-status-core';

const opts = {
	appName: 'Warcon',
	orgName: 'Bakurani Boys',
	origin: 'https://rcon.example.com',
	now: Date.parse('2026-09-13T12:00:00Z')
};
const server = { id: 's1', name: 'EU #1' };
const panelLink = { label: 'Panel', url: 'https://rcon.example.com/server/s1' };
const p = (name: string, faction: string | null, kills: number, deaths: number): Player => ({
	name,
	steamId: name,
	faction,
	kills,
	deaths,
	cash: 0,
	ping: 30
});
const status: Status = {
	serverName: 'EU #1',
	map: 'Kavkazi',
	experiences: ['Bakurani_KOTH_01'],
	lighting: 'DayLateClear',
	alternator: 'ZoneAlternator.Factory.Circle',
	scoreTick: 24,
	scoreTickMin: null,
	scoreTickMax: null,
	scoreCap: 100,
	matchSeconds: 1523,
	playerCount: 6,
	maxPlayers: 100,
	scores: [
		{ name: 'Valkyra', colorHex: '#D86060', score: 34 },
		{ name: 'Lonestar', colorHex: '#5B95D8', score: 27 },
		{ name: 'Manticore', colorHex: '#7BC462', score: 30 }
	],
	rotationNow: 0,
	rotationNext: 1
};
const players = [
	p('Ghostpepper', 'Valkyra', 14, 6),
	p('Mad Marmalade', 'Valkyra', 9, 11),
	p('Nomad', 'Lonestar', 17, 8),
	p('Willowisp', 'Lonestar', 11, 10),
	p('QuietStorm', 'Manticore', 13, 7),
	p('Rooikat', 'Manticore', 7, 3)
];
const live = (over: Partial<LiveView> = {}): LiveView => ({
	serverId: 's1',
	ok: true,
	error: '',
	tier: 'hot',
	build: '',
	gameServerId: '',
	startedAt: null,
	reservedSlots: null,
	throttledUntil: null,
	status,
	players,
	statusAt: '2026-09-13T11:59:50Z',
	playersAt: '2026-09-13T11:59:50Z',
	observedAt: '2026-09-13T11:59:50Z',
	...over
});

describe('buildStatusEmbed', () => {
	test('slots the server holds back for reserved players sit beside the public cap', () => {
		const e = buildStatusEmbed(opts, server, live({ reservedSlots: 2 }));
		expect(e.description?.split('\n')[0]).toBe(
			'🟢 **6 / 100** +2 reserved online  ▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱'
		);
		expect(buildStatusEmbed(opts, server, live({ reservedSlots: 0 })).description).toContain(
			'**6 / 100** online'
		);
	});

	test('the card: bars, map line, faction rows, columns, art and author', () => {
		const e = buildStatusEmbed({ ...opts, links: [panelLink] }, server, live());
		expect(e.title).toBe('EU #1');
		expect(e.url).toBe('https://rcon.example.com/server/s1');
		expect(e.color).toBe(0xd86060); // Valkyra leads
		expect(e.author).toEqual({
			name: 'Bakurani Boys',
			icon_url: 'https://rcon.example.com/icon-192.png'
		});
		const lines = e.description.split('\n');
		expect(lines[0]).toBe('🟢 **6 / 100** online  ▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱');
		expect(lines[1]).toBe('**Bakurani** · Day Late Clear · King of the Hill · Factory Circle');
		expect(lines[2]).toBe('🟥🟥🟥⬛⬛⬛⬛⬛⬛⬛ **34** Valkyra');
		expect(lines[3]).toBe('🟩🟩🟩⬛⬛⬛⬛⬛⬛⬛ **30** Manticore');
		expect(lines[4]).toBe('🟦🟦🟦⬛⬛⬛⬛⬛⬛⬛ **27** Lonestar');
		expect(lines[5]).toBe('First to 100 · 0:25:23 played');
		expect(lines).toHaveLength(6);
		expect(e.fields?.map((f) => f.name)).toEqual([
			'🟥 Valkyra · 2',
			'🟩 Manticore · 2',
			'🟦 Lonestar · 2',
			'\u200b'
		]);
		expect(e.fields?.at(-1)?.value).toBe(
			`Updated <t:${Date.parse('2026-09-13T11:59:50Z') / 1000}:R>`
		);
		expect(e.fields?.[2]).toEqual({
			name: '🟦 Lonestar · 2',
			value: '**Nomad** 17/8\n**Willowisp** 11/10',
			inline: true
		});
		expect(e.image?.url).toBe('https://rcon.example.com/maps/Kavkazi/DayLateClear-wide.webp');
		expect(e.timestamp).toBe('2026-09-13T11:59:50Z');
		expect(e.footer?.text).toBe('Warcon');
	});
	test('the bar is green when people play with no scores yet, and falls back by faction name', () => {
		const noScores = buildStatusEmbed(opts, server, live({ status: { ...status, scores: [] } }));
		expect(noScores.color).toBe(0x7bc462);
		const byName = buildStatusEmbed(
			opts,
			server,
			live({ status: { ...status, scores: [{ name: 'BLU', colorHex: '', score: 9 }] } })
		);
		expect(byName.color).toBe(0x5b95d8);
	});
	test('an empty server is grey, has no columns, keeps the map; no images over http', () => {
		const e = buildStatusEmbed(
			{ ...opts, origin: 'http://localhost:5173' },
			server,
			live({ players: [], status: { ...status, playerCount: 0, scores: [], matchSeconds: null } })
		);
		expect(e.color).toBe(0x8a8a90);
		expect(e.description).toContain('⚪ **0 / 100** online  ▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱');
		expect(e.description).not.toContain('First to');
		expect(e.fields?.map((f) => f.name)).toEqual(['\u200b']);
		expect(e.image).toBeUndefined();
		expect(e.author?.icon_url).toBeUndefined();
	});
	test('an unreachable server is red with the error, the clocks and the last map as thumbnail', () => {
		const e = buildStatusEmbed(opts, server, live({ ok: false, error: 'Poll failed.' }));
		expect(e.color).toBe(0xd86060);
		expect(e.description).toContain('🔴 **Unreachable**\nPoll failed.\nLast seen <t:');
		expect(e.thumbnail?.url).toBe('https://rcon.example.com/maps/Kavkazi/DayLateClear-square.webp');
		expect(e.fields).toBeUndefined();
	});
	test('a server never looked at says so', () => {
		const e = buildStatusEmbed(opts, server, null);
		expect(e.description).toBe('⚪ Waiting for the first look.');
	});
	test('names are escaped and the unplaced get their own row', () => {
		const e = buildStatusEmbed(
			opts,
			server,
			live({ players: [...players, p('b*b_<t:1:R>', null, 1, 1), p('Ghost', 'Nobody', 0, 0)] })
		);
		const loose = e.fields?.find((f) => f.name.startsWith('Unassigned'));
		expect(loose).toEqual({
			name: 'Unassigned · 2',
			value: '**b\\*b\\_\\<t:1:R\\>** 1/1\n**Ghost** 0/0',
			inline: false
		});
	});
	test('a full 100-slot server stays inside every limit', () => {
		const many = Array.from({ length: 100 }, (_, i) =>
			p(`Player_with_a_long_name_${i}`, ['Valkyra', 'Lonestar', 'Manticore'][i % 3], 100 - i, i)
		);
		const e = buildStatusEmbed(
			opts,
			server,
			live({ players: many, status: { ...status, playerCount: 100 } })
		);
		for (const f of (e.fields ?? []).slice(0, 3)) {
			expect(f.value.length).toBeLessThanOrEqual(LIMITS.field);
			expect(f.value).toMatch(/and \d+ more$/);
		}
		expect(embedLength(e)).toBeLessThanOrEqual(LIMITS.message);
	});
});

describe('map art', () => {
	test('a live server names the map for display; the art lives under the id', () => {
		const e = buildStatusEmbed(
			opts,
			server,
			live({ status: { ...status, map: 'Bakurani', lighting: 'DayLateGrayFog' } })
		);
		expect(e.image?.url).toBe('https://rcon.example.com/maps/Kavkazi/DayLateGrayFog-wide.webp');
	});
	test('a lighting with no art falls back to day clear; an unknown map has no picture', () => {
		const night = buildStatusEmbed(
			opts,
			server,
			live({ status: { ...status, lighting: 'Night' } })
		);
		expect(night.image?.url).toBe('https://rcon.example.com/maps/Kavkazi/DayClear-wide.webp');
		const nowhere = buildStatusEmbed(
			opts,
			server,
			live({ status: { ...status, map: 'Atlantis' } })
		);
		expect(nowhere.image).toBeUndefined();
	});
});

describe('styles', () => {
	test('compact: thumbnail, one score line, counts per faction, the top three and the clock', () => {
		const e = buildStatusEmbed({ ...opts, style: 'compact' }, server, live());
		expect(e.thumbnail?.url).toBe('https://rcon.example.com/maps/Kavkazi/DayLateClear-square.webp');
		expect(e.image).toBeUndefined();
		expect(e.color).toBe(0xd86060);
		const lines = e.description.split('\n');
		expect(lines[2]).toBe('🟥 Valkyra **34** · 🟩 Manticore **30** · 🟦 Lonestar **27**');
		expect(lines[3]).toBe('First to 100 · 0:25:23 played');
		expect(e.fields?.slice(0, 3)).toEqual([
			{ name: '🟥 Valkyra', value: '2 players', inline: true },
			{ name: '🟩 Manticore', value: '2 players', inline: true },
			{ name: '🟦 Lonestar', value: '2 players', inline: true }
		]);
		expect(e.fields?.at(-1)?.value).toMatch(
			/^Top: \*\*Nomad\*\* 17\/8 · \*\*Ghostpepper\*\* 14\/6 · \*\*QuietStorm\*\* 13\/7\nUpdated <t:\d+:R>$/
		);
	});
	test('scoreboard: bars first, one ranked table across factions, top 20 noted', () => {
		const e = buildStatusEmbed({ ...opts, style: 'scoreboard' }, server, live());
		const lines = e.description.split('\n');
		expect(lines[0]).toBe('🟥🟥🟥⬛⬛⬛⬛⬛⬛⬛ **34** Valkyra');
		expect(lines[3]).toBe('First to 100 · 0:25:23 played');
		expect(lines[4]).toContain('**6 / 100** online');
		const table = e.fields?.[0];
		expect(table?.name).toBe('Scoreboard');
		expect(table?.value.split('\n').slice(0, 3)).toEqual([
			'```',
			' K   D   Player            Faction',
			'17   8   Nomad             Lonestar'
		]);
		expect(table?.value.endsWith('```')).toBe(true);
		expect(e.fields?.at(-1)?.value).toMatch(/^Updated <t:\d+:R>$/);
		const many = Array.from({ length: 87 }, (_, i) => p(`P${i}`, 'Valkyra', 87 - i, i));
		const big = buildStatusEmbed({ ...opts, style: 'scoreboard' }, server, live({ players: many }));
		expect(big.fields?.[0].value.split('\n')).toHaveLength(TABLE_ROWS_EXPECTED);
		expect(big.fields?.at(-1)?.value).toMatch(/^Top 20 of 87 · Updated/);
		expect(big.fields?.[0].value.length).toBeLessThanOrEqual(LIMITS.field);
	});
	test('the style is part of the change key', () => {
		expect(statusMessage({ ...opts, style: 'compact' }, server, live()).key).not.toBe(
			statusMessage(opts, server, live()).key
		);
	});
});

const TABLE_ROWS_EXPECTED = 2 + 1 + 20; // fences, header, rows

describe('helpers', () => {
	test('fitLines keeps whole lines and says how many are left', () => {
		expect(fitLines([])).toBe('—');
		expect(fitLines(['a', 'b'])).toBe('a\nb');
		const lines = Array.from({ length: 50 }, (_, i) => `name_${i} 10/2`);
		const v = fitLines(lines, 200);
		expect(v.length).toBeLessThanOrEqual(200);
		expect(v.split('\n').at(-1)).toMatch(/^and \d+ more$/);
	});
	test('squareFor picks by colour, then by name, then by index', () => {
		expect(squareFor('#D86060', 'x')).toBe('🟥');
		expect(squareFor('5B95D8', 'x')).toBe('🟦');
		expect(squareFor('#7BC462', 'x')).toBe('🟩');
		expect(squareFor('#f0c020', 'x')).toBe('🟨');
		expect(squareFor('#9040c0', 'x')).toBe('🟪');
		expect(squareFor('#808080', 'x')).toBe('⬜');
		expect(squareFor('', 'GRN')).toBe('🟩');
		expect(squareFor(null, 'Other', 1)).toBe('🟦');
	});
	test('factionFields orders by score and players by kills', () => {
		const f = factionFields(status.scores, players);
		expect(f.map((x) => x.name.split(' ')[1])).toEqual(['Valkyra', 'Manticore', 'Lonestar']);
		expect(f[0].value.split('\n')[0]).toBe('**Ghostpepper** 14/6');
	});
	test('modeLabel and escapeMarkdown', () => {
		expect(modeLabel(['KOTH', 'KOTH_Infantry'])).toBe('King of the Hill + Infantry');
		expect(modeLabel(['Conquest', 'Hardcore'])).toBe('Conquest + Hardcore');
		expect(modeLabel([])).toBe('');
		expect(escapeMarkdown('a_b|c`d')).toBe('a\\_b\\|c\\`d');
	});
});

describe('statusMessage', () => {
	test('one embed, empty content, and a key that ignores the clocks', () => {
		const a = statusMessage(opts, server, live());
		expect(a.payload.content).toBe('');
		expect(a.payload.embeds).toHaveLength(1);
		const later = live({
			observedAt: '2026-09-13T12:05:00Z',
			statusAt: '2026-09-13T12:05:00Z',
			status: { ...status, matchSeconds: 1600 }
		});
		expect(statusMessage({ ...opts, now: opts.now + 60_000 }, server, later).key).toBe(a.key);
		expect(statusMessage(opts, server, live({ players: [] })).key).not.toBe(a.key);
		expect(
			statusMessage(
				opts,
				server,
				live({ players: [p('Ghostpepper', 'Valkyra', 15, 6), ...players.slice(1)] })
			).key
		).not.toBe(a.key);
		expect(statusMessage(opts, server, live({ ok: false })).key).not.toBe(a.key);
	});
});

describe('join code', () => {
	const id = 'fd6926f9-57b6-48ce-9608-ad5f7de8c92a';
	const codeField = { name: 'Join code', value: '```\n' + id + '\n```' };
	test('a code-block field (copyable in Discord) just above the clock, in every style', () => {
		expect(buildStatusEmbed(opts, server, live()).fields).not.toContainEqual(codeField);
		for (const style of ['banner', 'compact', 'scoreboard'] as const) {
			const e = buildStatusEmbed({ ...opts, style }, server, live({ gameServerId: id }));
			const fields = e.fields ?? [];
			expect(fields).toContainEqual(codeField);
			expect(fields[fields.length - 2]).toEqual(codeField);
			expect(fields[fields.length - 1].value).toContain('Updated');
			expect(e.footer?.text).toBe('Warcon');
		}
	});
	test('the unreachable card keeps it', () => {
		const e = buildStatusEmbed(opts, server, live({ ok: false, error: 'x', gameServerId: id }));
		expect(e.fields).toEqual([codeField]);
	});
	test('the code is part of the change key, so the message is edited once when it appears', () => {
		const before = statusMessage(opts, server, live()).key;
		expect(statusMessage(opts, server, live({ gameServerId: id })).key).not.toBe(before);
		expect(statusMessage(opts, server, live({ ok: false, gameServerId: id })).key).not.toBe(
			statusMessage(opts, server, live({ ok: false })).key
		);
	});
});

describe('uptime', () => {
	const startedAt = '2026-09-13T03:00:00Z'; // nine hours before opts.now
	const ts = (iso: string) => Date.parse(iso) / 1000;
	test('the start time renders as a relative clock above the update clock, in every style', () => {
		for (const style of ['banner', 'compact', 'scoreboard'] as const) {
			const e = buildStatusEmbed({ ...opts, style }, server, live({ startedAt }));
			expect(e.fields?.at(-1)?.value.split('\n')[0]).toBe(`Up since <t:${ts(startedAt)}:R>`);
			expect(e.fields?.at(-1)?.value.split('\n').at(-1)).toMatch(/^Updated <t:\d+:R>$/);
		}
	});
	test('no start time, no line', () => {
		const e = buildStatusEmbed(opts, server, live());
		expect(e.fields?.at(-1)?.value.startsWith('Updated')).toBe(true);
	});
	test('past 24 hours the card says the server restarts after this round', () => {
		const early = buildStatusEmbed(opts, server, live({ startedAt }));
		expect(early.fields?.at(-1)?.value).not.toContain('Restarts');
		const late = buildStatusEmbed(opts, server, live({ startedAt: '2026-09-12T11:30:00Z' }));
		expect(late.fields?.at(-1)?.value.split('\n')[0]).toBe(
			`Up since <t:${ts('2026-09-12T11:30:00Z')}:R> · 🔁 Restarts after this round`
		);
	});
	test('a daily restart schedule says so from its time of day', () => {
		// 06:30 in Chicago is 11:30 UTC, half an hour before opts.now, 23 hours into this start
		const daily = {
			...server,
			restartSchedule: { kind: 'daily', time: '06:30', timeZone: 'America/Chicago' } as const
		};
		const started = '2026-09-12T13:00:00Z';
		expect(
			buildStatusEmbed(opts, server, live({ startedAt: started })).fields?.at(-1)?.value
		).not.toContain('Restarts');
		expect(
			buildStatusEmbed(opts, daily, live({ startedAt: started })).fields?.at(-1)?.value
		).toContain('🔁 Restarts after this round');
	});
	test('the start time and the restart note are in the change key; the ticking uptime is not', () => {
		const k = (now: number, at: string | null) =>
			statusMessage({ ...opts, now }, server, live({ startedAt: at })).key;
		expect(k(opts.now, null)).not.toBe(k(opts.now, startedAt));
		// nine hours up, then ten: same card
		expect(k(opts.now, startedAt)).toBe(k(opts.now + 3600_000, startedAt));
		// crossing 24 hours: one edit
		expect(k(opts.now + 14 * 3600_000, startedAt)).not.toBe(k(opts.now + 16 * 3600_000, startedAt));
		// a restart is a new start time
		expect(k(opts.now, startedAt)).not.toBe(k(opts.now, '2026-09-13T11:00:00Z'));
	});
});

describe('score cap on live builds', () => {
	test('a status without a cap uses the game default for the line and the bars', () => {
		const e = buildStatusEmbed(
			{ ...opts, origin: 'http://localhost:5173' },
			server,
			live({
				status: {
					...status,
					scoreCap: null,
					scores: [
						{ name: 'Valkyra', colorHex: '#D86060', score: 50 },
						{ name: 'Lonestar', colorHex: '#5B95D8', score: 0 }
					]
				}
			})
		);
		expect(e.description).toContain('First to 100');
		expect(e.description).toContain('🟥🟥🟥🟥🟥⬛⬛⬛⬛⬛ **50** Valkyra');
	});
});

describe('links', () => {
	const flags = { linkStatus: true, linkLeaderboard: true, linkPanel: true };
	const on = { status: true, leaderboards: true };
	test('a public link goes out only while its page is on; the panel link whenever asked', () => {
		expect(cardLinks('https://x.io', 's1', flags, on)).toEqual([
			{ label: 'Live status', url: 'https://x.io/s/s1' },
			{ label: 'Leaderboard', url: 'https://x.io/s/s1/leaderboard' },
			{ label: 'Panel', url: 'https://x.io/server/s1' }
		]);
		expect(cardLinks('https://x.io', 's1', flags, { status: false, leaderboards: false })).toEqual([
			{ label: 'Panel', url: 'https://x.io/server/s1' }
		]);
		expect(
			cardLinks(
				'https://x.io',
				's1',
				{ ...flags, linkPanel: false },
				{ status: true, leaderboards: false }
			)
		).toEqual([{ label: 'Live status', url: 'https://x.io/s/s1' }]);
		expect(
			cardLinks(
				'https://x.io',
				's1',
				{ linkStatus: false, linkLeaderboard: false, linkPanel: false },
				on
			)
		).toEqual([]);
	});
	test('the title points at the first link and the rest close the body; no links, no url', () => {
		const links = cardLinks('https://x.io', 's1', flags, on);
		for (const style of ['banner', 'compact', 'scoreboard'] as const) {
			const e = buildStatusEmbed({ ...opts, style, links }, server, live());
			expect(e.url).toBe('https://x.io/s/s1');
			expect(e.description.split('\n').at(-1)).toBe(
				'[Leaderboard](https://x.io/s/s1/leaderboard) · [Panel](https://x.io/server/s1)'
			);
			expect(e.description.length).toBeLessThanOrEqual(LIMITS.description);
		}
		const one = buildStatusEmbed({ ...opts, links: [panelLink] }, server, live());
		expect(one.url).toBe(panelLink.url);
		expect(one.description).not.toContain('](');
		const none = buildStatusEmbed(opts, server, live());
		expect(none.url).toBeUndefined();
		expect(none.description).not.toContain('](');
		const down = buildStatusEmbed({ ...opts, links }, server, live({ ok: false, error: 'x' }));
		expect(down.url).toBe('https://x.io/s/s1');
		expect(down.description.split('\n').at(-1)).toContain('[Panel]');
	});
	test('the links are part of the change key', () => {
		const base = statusMessage(opts, server, live()).key;
		const withPanel = statusMessage({ ...opts, links: [panelLink] }, server, live()).key;
		expect(withPanel).not.toBe(base);
		expect(statusMessage({ ...opts, links: [panelLink] }, server, live()).key).toBe(withPanel);
		expect(
			statusMessage(
				{ ...opts, links: [{ label: 'Live status', url: 'https://x.io/s/s1' }] },
				server,
				live()
			).key
		).not.toBe(withPanel);
	});
});

describe('clampInterval', () => {
	test('30 to 300 seconds, whole, default 60', () => {
		expect(clampInterval(undefined)).toBe(60);
		expect(clampInterval('')).toBe(60);
		expect(clampInterval('abc')).toBe(60);
		expect(clampInterval(10)).toBe(30);
		expect(clampInterval(45.4)).toBe(45);
		expect(clampInterval('120')).toBe(120);
		expect(clampInterval(9999)).toBe(300);
	});
});
