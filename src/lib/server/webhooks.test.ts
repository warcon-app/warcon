import { describe, expect, test } from 'bun:test';
import { validateWebhookUrl } from './webhooks';
import { RULE_KINDS } from '../rule-kinds';
import { MAX_CHAT } from '../chat';
import {
	buildEmbed,
	buildTeamKillEmbed,
	buildWatchedJoinEmbed,
	classify,
	dossierUrl,
	nextBatch,
	takesRule,
	type Embed
} from './webhook-delivery';

const token = 'a'.repeat(68);

describe('validateWebhookUrl', () => {
	test('accepts Discord webhook URLs and hides the token in the hint', () => {
		const { url, hint } = validateWebhookUrl(
			`https://DISCORD.com/api/webhooks/123456789012345678/${token}?wait=true`
		);
		expect(url).toBe(`https://discord.com/api/webhooks/123456789012345678/${token}`);
		expect(hint).toBe('discord.com/api/webhooks/123456789012345678/…');
		expect(
			validateWebhookUrl(`https://ptb.discord.com/api/webhooks/123456789012345678/${token}`).url
		).toContain('ptb.discord.com');
	});
	test('refuses anything that is not a Discord webhook', () => {
		expect(() => validateWebhookUrl('not a url')).toThrow('not a URL');
		expect(() =>
			validateWebhookUrl(`http://discord.com/api/webhooks/123456789012345678/${token}`)
		).toThrow('Discord webhook URL');
		expect(() =>
			validateWebhookUrl(`https://example.com/api/webhooks/123456789012345678/${token}`)
		).toThrow('Discord webhook URL');
		expect(() => validateWebhookUrl('https://discord.com/api/channels/1/messages')).toThrow(
			'Discord webhook URL'
		);
		expect(() =>
			validateWebhookUrl('https://discord.com/api/webhooks/123456789012345678/short')
		).toThrow('Discord webhook URL');
	});
});

describe('classify', () => {
	test('routes rows to event classes', () => {
		expect(classify({ category: 'rcon', action: 'rcon.ban' })).toBe('bans');
		expect(classify({ category: 'rcon', action: 'rcon.kick' })).toBe('commands');
		expect(classify({ category: 'trigger', action: 'trigger.welcome' })).toBe('triggers');
		expect(classify({ category: 'player', action: 'player.note' })).toBe('players');
		expect(classify({ category: 'org', action: 'org.invite.create' })).toBe('management');
		expect(classify({ category: 'auth', action: 'login' })).toBe('auth');
		expect(classify({ category: 'weird', action: 'x' })).toBeNull();
	});
});

describe('takesRule', () => {
	test('every kind of rule when the webhook names none, else only the kinds it names', () => {
		expect(takesRule({ triggerKinds: null }, 'trigger.welcome')).toBe(true);
		expect(takesRule({ triggerKinds: ['team_kill'] }, 'trigger.team_kill')).toBe(true);
		expect(takesRule({ triggerKinds: ['team_kill'] }, 'trigger.welcome')).toBe(false);
		expect(takesRule({ triggerKinds: ['team_kill'] }, 'trigger.team_kill_x')).toBe(false);
	});
});

describe('buildEmbed', () => {
	const row = {
		id: 1,
		ts: new Date('2026-09-09T12:00:00Z'),
		actorId: 'u1',
		actorName: 'james',
		serverId: 's1',
		serverName: 'EU #1',
		orgId: 'o1',
		category: 'rcon',
		action: 'rcon.kick',
		target: '76561198000000001',
		detail: { reason: 'tk', password: 'x' },
		outcome: 'ok' as const,
		status: 200,
		message: 'Kicked Nomad.',
		userAgent: 'curl',
		durationMs: 12
	};
	test('names the action, actor, target and server', () => {
		const e = buildEmbed('Warcon', row);
		expect(e.title).toBe('Kick');
		expect(e.description).toContain('**james** → `76561198000000001`');
		expect(e.description).toContain('Server: EU #1');
		expect(e.description).toContain('Kicked Nomad.');
		expect(e.color).toBe(0x7bc462);
		expect(e.timestamp).toBe('2026-09-09T12:00:00.000Z');
	});
	test('a rule posts under the name the webhook dialog gives its kind', () => {
		for (const { kind, label } of RULE_KINDS) {
			const e = buildEmbed('Warcon', { ...row, category: 'trigger', action: `trigger.${kind}` });
			expect({ kind, title: e.title.toLowerCase() }).toEqual({
				kind,
				title: `trigger · ${label.toLowerCase()}`
			});
		}
	});
	test('failures are red and say so', () => {
		const e = buildEmbed('Warcon', {
			...row,
			outcome: 'denied',
			status: 403,
			message: 'needs admin'
		});
		expect(e.description).toContain('Outcome: **denied** (403)');
		expect(e.color).toBe(0x8a8a90);
	});
	const whisper = {
		...row,
		action: 'rcon.whisper',
		detail: { steamId: '76561198000000001', message: 'Stop camping our main' },
		message: 'OK: message delivered to Nomad.'
	};
	test("a whisper by hand says what it said, before the game's answer", () => {
		expect(buildEmbed('Warcon', whisper).description).toBe(
			'**james** → `76561198000000001`\nServer: EU #1\nMessage: Stop camping our main\nOK: message delivered to Nomad.'
		);
		const group = buildEmbed('Warcon', {
			...whisper,
			action: 'rcon.whisperMany',
			target: 'Valkyra',
			detail: { faction: 'Valkyra', message: 'Push B' },
			message: 'Whispered 12 players on Valkyra.'
		});
		expect(group.title).toBe('Group whisper');
		expect(group.description).toEndWith(
			'→ `Valkyra`\nServer: EU #1\nMessage: Push B\nWhispered 12 players on Valkyra.'
		);
		// a game that refused it: the words, then what went wrong
		const failed = buildEmbed('Warcon', {
			...whisper,
			outcome: 'error',
			status: 404,
			message: 'Error: no player matching it'
		});
		expect(failed.description).toEndWith(
			'\nMessage: Stop camping our main\nOutcome: **error** (404)\nError: no player matching it'
		);
	});
	test('the words are what the game was sent: cut where the action cut them, on one line', () => {
		const long = buildEmbed('Warcon', { ...whisper, detail: { message: ` ${'w'.repeat(300)} ` } });
		expect(long.description).toContain(`\nMessage: ${'w'.repeat(MAX_CHAT)}\n`);
		// spaces count toward the cut as the game counted them, so no word past it shows
		const spaced = buildEmbed('Warcon', {
			...whisper,
			detail: { message: `${'w'.repeat(MAX_CHAT - 6)}${' '.repeat(6)}unsent` }
		});
		expect(spaced.description).toContain(`\nMessage: ${'w'.repeat(MAX_CHAT - 6)}\n`);
		expect(spaced.description).not.toContain('uns');
		// the game was sent half an emoji: the card shows the replacement character, never half a pair
		const emoji = buildEmbed('Warcon', {
			...whisper,
			detail: { message: `${'w'.repeat(MAX_CHAT - 1)}😀` }
		});
		expect(emoji.description).toContain(`\nMessage: ${'w'.repeat(MAX_CHAT - 1)}\uFFFD\n`);
		expect(emoji.description.isWellFormed()).toBe(true);
		const lines = buildEmbed('Warcon', { ...whisper, detail: { message: 'one\ntwo\r\n\nthree' } });
		expect(lines.description).toContain('\nMessage: one two three\n');
	});
	test('no message line when nothing was said, for a refused whisper, or for anything else', () => {
		for (const detail of [{}, { message: '' }, { message: '   ' }, { message: 7 }, null])
			expect(buildEmbed('Warcon', { ...whisper, detail }).description).not.toContain('Message:');
		// someone without Chat: what they typed stays in the trail
		const denied = buildEmbed('Warcon', {
			...whisper,
			outcome: 'denied',
			status: 403,
			detail: { steamId: '76561198000000001', message: 'typed by a viewer' },
			message: "Needs 'chat.send', role 'viewer' lacks it"
		});
		expect(denied.description).not.toContain('typed by a viewer');
		// a rule's whisper says what became of it in the panel's words, never what it told the player
		for (const action of ['trigger.welcome', 'trigger.faction_change', 'trigger.team_kill']) {
			const rule = buildEmbed('Warcon', {
				...whisper,
				category: 'trigger',
				action,
				detail: { message: 'what the rule told the player' },
				message: 'Whispered Nomad.'
			});
			expect(rule.description).not.toContain('what the rule told the player');
		}
		// a broadcast's words are its target, said once
		const broadcast = buildEmbed('Warcon', {
			...whisper,
			action: 'rcon.broadcast',
			target: 'Restart in 5 minutes',
			detail: { message: 'Restart in 5 minutes' },
			message: 'OK'
		});
		expect(broadcast.description).not.toContain('Message:');
		expect(broadcast.description.split('Restart in 5 minutes')).toHaveLength(2);
	});
	test('a server added, refused or deleted never says where RCON listens', () => {
		for (const action of ['server.create', 'server.update', 'server.delete']) {
			const e = buildEmbed('Warcon', {
				...row,
				category: 'server',
				action,
				outcome: 'denied',
				status: 400,
				target: 'rcon.example.net:7776',
				message: 'rcon.example.net resolves to 10.0.0.5, a private address.'
			});
			expect(e.description).toContain('**james**');
			expect(e.description).toContain('Server: EU #1');
			expect(e.description).not.toContain('example.net');
			expect(e.description).not.toContain('7776');
			expect(e.description).not.toContain('10.0.0.5');
		}
	});
});

describe('names a player chose, in a staff channel', () => {
	// A masked link renders as its text in an embed: a player named like this would put a sign-in
	// lookalike in front of every admin who reads the channel.
	const name = '[Sign in](https://evil.example) **x** <@&1>\n# big';
	const shown = '\\[Sign in\\](https:\u200B//evil.example) \\*\\*x\\*\\* \\<@&1\\> # big';
	const intact = (text: string) => {
		expect(text).not.toContain('[Sign in](');
		// nor a bare address, which Discord links on its own
		expect(text).not.toContain('https://evil.example');
		expect(text).not.toContain('\n# big');
		expect(text).toContain(shown);
	};
	test('a flag or a kick carries the name as text', () => {
		const base = {
			id: 1,
			ts: new Date('2026-09-28T12:00:00Z'),
			actorId: 'u1',
			actorName: 'trigger: Name change watch',
			serverId: 's1',
			serverName: 'EU #1',
			orgId: 'o1',
			category: 'trigger',
			action: 'trigger.name_filter',
			target: '76561198000000001` [x](evil.example) `',
			detail: {},
			outcome: 'ok' as const,
			status: 200,
			message: `Flagged ${name}: blocked word 'x'`,
			userAgent: 'curl',
			durationMs: 12
		};
		const e = buildEmbed('Warcon', base);
		intact(e.description);
		// the target stays inside its code span
		expect(e.description).toContain('→ `76561198000000001ˋ [x](evil.example) ˋ`\nServer: EU #1');
		// a message that starts with outside text starts no heading
		const heading = buildEmbed('Warcon', {
			...base,
			message: '# Free admin at https://evil.example'
		});
		expect(heading.description).toContain('\n\\# Free admin at https:\u200B//evil.example');
	});
	test('a whisper carries its words as text', () => {
		const e = buildEmbed('Warcon', {
			id: 1,
			ts: new Date('2026-09-28T12:00:00Z'),
			actorId: 'u1',
			actorName: 'james',
			serverId: 's1',
			serverName: 'EU #1',
			orgId: 'o1',
			category: 'rcon',
			action: 'rcon.whisper',
			target: '76561198000000001',
			detail: { steamId: '76561198000000001', message: name },
			outcome: 'ok',
			status: 200,
			message: 'OK: message delivered to Nomad.',
			userAgent: 'curl',
			durationMs: 12
		});
		intact(e.description);
		expect(e.description).toContain(`\nMessage: ${shown}\nOK: message delivered to Nomad.`);
	});
	test('a team kill and a watched join carry the names as text', () => {
		intact(
			buildTeamKillEmbed('Warcon', 'EU #1', {
				eventId: 'x',
				ts: '2026-09-28T12:00:00.000Z',
				map: 'Kavkazi',
				eventTime: 12,
				killer: { steamId: '76561198000000001', name, faction: 'Valkyra' },
				victim: { steamId: '76561198000000002', name, faction: 'Valkyra' },
				cause: 'Id.Item.AK74M',
				distanceM: 39.6,
				headshot: true,
				suicide: false,
				teamKill: true,
				tags: []
			}).description
		);
		intact(
			buildWatchedJoinEmbed(
				'Warcon',
				'EU #1',
				{ steamId: '76561198000000001', name, reason: 'alt' },
				'2026-09-28T12:00:00.000Z'
			).description
		);
	});
});

describe('buildTeamKillEmbed', () => {
	test('names both players, the weapon, the distance and the server', () => {
		const e = buildTeamKillEmbed('Warcon', 'TLR #1', {
			eventId: 'x',
			ts: '2026-09-16T20:00:00.000Z',
			map: 'Kavkazi',
			eventTime: 12,
			killer: { steamId: '76561198000000001', name: 'Alpha', faction: 'Valkyra' },
			victim: { steamId: '76561198000000002', name: 'Bravo', faction: 'Valkyra' },
			cause: 'Id.Item.AK74M',
			distanceM: 39.6,
			headshot: true,
			suicide: false,
			teamKill: true,
			tags: []
		});
		expect(e.title).toBe('Team kill');
		expect(e.description).toBe(
			'**Alpha** → **Bravo** (Valkyra)\nAK74 · 40 m · headshot\nServer: TLR #1 · Kavkazi'
		);
		expect(e.timestamp).toBe('2026-09-16T20:00:00.000Z');
		expect(e.footer?.text).toBe('Warcon');
	});
});

describe('watched join and dossier links', () => {
	test("a player's page, only with an origin and a SteamID", () => {
		expect(dossierUrl('https://rcon.example.com/', 's 1', '76561198000000001')).toBe(
			'https://rcon.example.com/server/s%201/players/76561198000000001'
		);
		expect(dossierUrl('', 's1', '76561198000000001')).toBeUndefined();
		expect(dossierUrl('https://rcon.example.com', 's1', 'not-an-id')).toBeUndefined();
	});
	test('the post names the player, why, and where, and opens their page', () => {
		const e = buildWatchedJoinEmbed(
			'Warcon',
			'TLR #1',
			{ steamId: '76561198000000001', name: 'Krieger', reason: 'alt of a banned player' },
			'2026-09-22T00:00:00.000Z',
			'https://rcon.example.com/server/s1/players/76561198000000001'
		);
		expect(e.title).toBe('Watched player joined');
		expect(e.url).toBe('https://rcon.example.com/server/s1/players/76561198000000001');
		expect(e.description).toContain('Krieger');
		expect(e.description).toContain('alt of a banned player');
		expect(e.description).toContain('TLR #1');
		expect(
			buildWatchedJoinEmbed('Warcon', 'x', { steamId: '1', name: 'a', reason: '' }, 't').url
		).toBeUndefined();
	});
});

describe('nextBatch', () => {
	/** a card of `chars` characters as Discord counts them: title, description and footer */
	const card = (chars: number, title = 'Ban'): Embed => ({
		title,
		description: 'x'.repeat(chars - title.length - 'Warcon'.length),
		color: 0,
		timestamp: '2026-10-24T00:00:00.000Z',
		footer: { text: 'Warcon' }
	});
	/** the messages a queue goes out as, by the number of cards in each */
	const messages = (queue: Embed[]) => {
		const out: Embed[][] = [];
		// a few rounds at most, so a batch that takes nothing fails the test rather than spinning
		for (let i = 0; queue.length && i < 20; i++) out.push(nextBatch(queue));
		return out;
	};

	test('ten short cards go as one message, the eleventh as the next', () => {
		expect(messages(Array.from({ length: 11 }, () => card(150))).map((m) => m.length)).toEqual([
			10, 1
		]);
		expect(nextBatch([])).toEqual([]);
	});

	test('no message holds more than the 6,000 characters Discord takes, and every card goes, in order', () => {
		const queue = Array.from({ length: 10 }, (_, i) => card(650, `Ban ${i}`));
		const sent = messages([...queue]);
		expect(sent.map((m) => m.length)).toEqual([9, 1]);
		expect(sent.flat()).toEqual(queue);
		// to the character: 6,000 is taken, one more goes in the next message
		const full = [card(1500), card(1500), card(1500), card(1500), card(10)];
		expect(messages(full).map((m) => m.length)).toEqual([4, 1]);
		const over = [card(1500), card(1500), card(1500), card(1501)];
		expect(messages(over).map((m) => m.length)).toEqual([3, 1]);
	});

	test('a card longer than Discord takes goes alone, so the queue moves on', () => {
		expect(messages([card(100), card(7000), card(100)]).map((m) => m.length)).toEqual([1, 1, 1]);
	});
});
