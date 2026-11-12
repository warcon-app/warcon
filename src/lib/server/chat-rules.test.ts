// The chat rules' settings and their step: what a Chat command and a Staff call take as config,
// which words a server's rules answer to, and what one read of the chat brings. The lines that
// are no command leave no trace in the memory; nothing a player typed reaches a message.
import { describe, expect, test } from 'bun:test';
import { MAX_CHAT } from '$lib/chat';
import type { ChatLine } from '$lib/chat-read';
import { STAFF_CALL_DEFAULTS } from '$lib/chat-commands';
import { MESSAGE_RULES, placeholdersFor, unfilled } from '$lib/placeholders';
import { CHAT_KINDS, NO_ACTIONS, ONE_PER_SERVER, RULE_KINDS } from '$lib/rule-kinds';
import {
	CHAT_COMMANDS_PER_MINUTE,
	CHAT_SENDS_PER_LOOK,
	CHAT_SENDS_PER_MINUTE,
	chatStep,
	chatWaitOf,
	chatWords,
	isChatKind,
	listedWords,
	newChatTracks,
	pruneChatTracks,
	repliesUse,
	rotationVars,
	sendsLeft,
	teamsLine,
	topLine,
	validateChatCommand,
	validateStaffCall,
	wordClash,
	wordsOf,
	type ChatAct,
	type ChatRule
} from './chat-rules';
import { TRIGGER_KINDS, TRIGGER_LABELS, validateConfig } from './trigger-rules';
import { buildStaffCallEmbed, type StaffCallCard } from './webhook-delivery';

const A = '76561198000000811';
const B = '76561198000000812';
const C = '76561198000000813';
const NOW = Date.parse('2026-11-12T18:00:00Z');

let seq = 0;
const line = (steamId: string, text: string, over: Partial<ChatLine> = {}): ChatLine => ({
	seq: ++seq,
	at: null,
	channel: 'Team',
	faction: 'RED',
	steamId,
	name: `p${steamId.slice(-3)}`,
	hiddenName: 'Amber Falcon',
	anonymous: false,
	text,
	typed: null,
	ping: false,
	...over
});

const command = (id: string, config: Record<string, unknown>): ChatRule => ({
	id,
	name: id,
	kind: 'chat_command',
	config: validateChatCommand(config)
});
const staff = (id: string, config: Record<string, unknown> = {}): ChatRule => ({
	id,
	name: id,
	kind: 'staff_call',
	config: validateStaffCall(config)
});
const summary = (acts: ChatAct[]) =>
	acts.map((a) => [a.type, a.rule.id, a.line.steamId, a.sends] as const);

describe('the two kinds', () => {
	test('are rules like any other, in a group of their own, and queue no actions', () => {
		expect(CHAT_KINDS).toEqual(['chat_command', 'staff_call']);
		for (const kind of CHAT_KINDS) {
			expect(TRIGGER_KINDS).toContain(kind);
			expect(isChatKind(kind)).toBe(true);
			expect(NO_ACTIONS).toContain(kind);
			expect(RULE_KINDS.find((k) => k.kind === kind)?.group).toBe('Chat commands');
		}
		expect(TRIGGER_LABELS.chat_command).toBe('Chat command');
		expect(TRIGGER_LABELS.staff_call).toBe('Staff call');
		// several commands on a server, one Staff call
		expect(ONE_PER_SERVER).toContain('staff_call');
		expect(ONE_PER_SERVER).not.toContain('chat_command');
		expect(isChatKind('welcome')).toBe(false);
	});

	test('what a rule waits for is read from its row, and nothing else is', () => {
		expect(chatWaitOf({ wait: 'terms' })).toBe('terms');
		expect(chatWaitOf({ wait: 'build' })).toBe('build');
		expect(chatWaitOf({ wait: 'failing' })).toBe('failing');
		expect(chatWaitOf({ wait: '' })).toBe('');
		for (const no of [null, undefined, {}, { wait: 'other' }, 'terms'])
			expect(chatWaitOf(no)).toBeNull();
	});
});

describe('a Chat command’s settings', () => {
	test('a word, its other words, up to four lines, to the player or to everyone', () => {
		expect(
			validateConfig('chat_command', {
				command: '!Rules',
				aliases: 'r, REGELN rules r',
				replies: 'No team killing.\n\n  Respect the staff.  ',
				cooldownSeconds: 30
			})
		).toEqual({
			command: 'rules',
			// each once, never the word itself
			aliases: ['r', 'regeln'],
			replies: ['No team killing.', 'Respect the staff.'],
			to: 'player',
			cooldownSeconds: 30
		});
		expect(
			validateChatCommand({ command: 'discord', aliases: ['dc'], replies: ['x'], to: 'everyone' })
		).toEqual({
			command: 'discord',
			aliases: ['dc'],
			replies: ['x'],
			to: 'everyone',
			cooldownSeconds: 60
		});
		// a player's own wait may be none at all; the longest is an hour
		expect(
			validateChatCommand({ command: 'a', replies: 'x', cooldownSeconds: 0 }).cooldownSeconds
		).toBe(0);
		expect(validateChatCommand({ command: 'a', replies: 'x' }).cooldownSeconds).toBe(10);
		expect(
			validateChatCommand({ command: 'a', replies: 'x', cooldownSeconds: 99999 }).cooldownSeconds
		).toBe(3600);
	});

	test('a line is one message of at most what the game takes', () => {
		const cfg = validateChatCommand({
			command: 'a',
			replies: ['x'.repeat(300), 'two\tlines\u0007here']
		});
		expect(cfg.replies[0]).toHaveLength(MAX_CHAT);
		expect(cfg.replies[1]).toBe('two lines here');
	});

	test('refused with a reason: no word, a word that is not one, too many, no reply', () => {
		const bad = (config: Record<string, unknown>) => {
			try {
				validateChatCommand(config);
			} catch (err) {
				return [(err as { status: number }).status, (err as Error).message];
			}
			return null;
		};
		expect(bad({ replies: 'x' })?.[0]).toBe(400);
		expect(bad({ command: 'two words', replies: 'x' })?.[0]).toBe(400);
		expect(bad({ command: 'rules', replies: '' })).toEqual([400, 'Add the reply.']);
		expect(bad({ command: 'rules', replies: ['a', 'b', 'c', 'd', 'e'] })?.[1]).toContain(
			'at most 4 lines'
		);
		expect(bad({ command: 'rules', aliases: ['ok', 'not ok'], replies: 'x' })?.[1]).toContain(
			'"not ok" is not a command'
		);
		expect(bad({ command: 'rules', aliases: 'a b c d e f', replies: 'x' })?.[1]).toContain(
			'at most 5 other words'
		);
		expect(bad({ command: 'rules', aliases: [7], replies: 'x' })?.[0]).toBe(400);
		// said to everyone, a wait of under ten seconds would let one player fill the screen
		expect(
			bad({ command: 'rules', replies: 'x', to: 'everyone', cooldownSeconds: 5 })?.[1]
		).toContain('at least 10 seconds');
		// the command's own word among its other words is not one of them
		expect(
			validateChatCommand({ command: 'rules', aliases: 'rules a b c d e', replies: 'x' }).aliases
		).toEqual(['a', 'b', 'c', 'd', 'e']);
		expect(bad({ command: 'rules', aliases: 'rules a b c d e f', replies: 'x' })?.[1]).toContain(
			'at most 5 other words'
		);
	});

	test('a list of words of any length costs no more than its reading', () => {
		// as many distinct words as a request body holds: refused at the first too many, not after
		// each has been compared with all before it
		const many = Array.from({ length: 150_000 }, (_, i) => `w${i.toString(36)}`).join(' ');
		const refused = (go: () => unknown) => {
			try {
				go();
			} catch (err) {
				return (err as Error).message;
			}
			return '';
		};
		const started = performance.now();
		expect(
			refused(() => validateChatCommand({ command: 'rules', aliases: many, replies: 'x' }))
		).toContain('at most 5 other words');
		expect(refused(() => validateStaffCall({ commands: many }))).toContain('at most 6 words');
		expect(refused(() => validateStaffCall({ reports: many.split(' ') }))).toContain(
			'at most 6 words'
		);
		// and as many of one word are one word
		expect(
			validateChatCommand({ command: 'rules', aliases: 'r '.repeat(150_000), replies: 'x' }).aliases
		).toEqual(['r']);
		expect(performance.now() - started).toBeLessThan(1500);
	});
});

describe('a Staff call’s settings', () => {
	test('a rule that names no words starts from !admin and !report, with the usual texts', () => {
		expect(validateConfig('staff_call', {})).toEqual({
			commands: ['admin'],
			reports: ['report'],
			ack: STAFF_CALL_DEFAULTS.ack,
			usage: STAFF_CALL_DEFAULTS.usage,
			wait: STAFF_CALL_DEFAULTS.wait,
			cooldownSeconds: 60
		});
	});

	test('its own words and texts; a blank text is none', () => {
		expect(
			validateStaffCall({
				commands: '!Admin, mods bug',
				reports: ['Report'],
				ack: '',
				usage: '  Say what is wrong.  ',
				wait: '',
				cooldownSeconds: 120
			})
		).toEqual({
			commands: ['admin', 'mods', 'bug'],
			reports: ['report'],
			ack: '',
			usage: 'Say what is wrong.',
			wait: '',
			cooldownSeconds: 120
		});
		// one list alone is a rule
		expect(validateStaffCall({ commands: [], reports: 'report' }).commands).toEqual([]);
		expect(validateStaffCall({ commands: 'admin' }).reports).toEqual([]);
	});

	test('refused: no word, a word in both lists, more than six, calls under ten seconds apart', () => {
		const bad = (config: Record<string, unknown>) => {
			try {
				validateStaffCall(config);
			} catch (err) {
				return [(err as { status: number }).status, (err as Error).message];
			}
			return null;
		};
		expect(bad({ commands: [], reports: [] })?.[1]).toContain('at least one word');
		expect(bad({ commands: 'admin', reports: 'admin' })?.[1]).toContain('!admin is in both lists');
		expect(bad({ commands: 'a b c d', reports: 'e f g' })?.[1]).toContain('at most 6 words');
		expect(bad({ commands: 'admin please' + '!' })?.[0]).toBe(400);
		expect(bad({ cooldownSeconds: 5 })?.[1]).toContain('at least 10 seconds apart');
		expect(bad({ cooldownSeconds: 0 })?.[1]).toContain('at least 10 seconds apart');
	});
});

describe('the words a server answers to', () => {
	const rules = command('rules', { command: 'rules', aliases: 'r', replies: 'x' });
	const calls = staff('calls', { commands: 'admin bug', reports: 'report' });

	test('every word of a rule, its own first; a word has one answer', () => {
		expect(chatWords('chat_command', rules.config)).toEqual(['rules', 'r']);
		expect(chatWords('staff_call', calls.config)).toEqual(['admin', 'bug', 'report']);
		expect(chatWords('chat_command', null)).toEqual([]);
		const words = wordsOf([rules, calls, command('late', { command: 'admin', replies: 'x' })]);
		expect([...words.keys()]).toEqual(['rules', 'r', 'admin', 'bug', 'report']);
		// the first rule to hold a word has it
		expect(words.get('admin')?.rule.id).toBe('calls');
		expect(words.get('report')?.report).toBe(true);
		expect(words.get('admin')?.report).toBe(false);
		expect(words.get('rules')?.report).toBe(false);
	});

	test('a clash is named with the rule that has the word; a rule does not clash with itself', () => {
		const other = command('other', { command: 'help', aliases: 'r', replies: 'x' });
		expect(wordClash(other, [rules, calls])).toEqual({ word: 'r', rule: 'rules' });
		expect(wordClash(staff('s2', { commands: 'rules' }), [rules])).toEqual({
			word: 'rules',
			rule: 'rules'
		});
		expect(wordClash(rules, [rules, calls])).toBeNull();
		expect(
			wordClash(command('free', { command: 'next', replies: 'x' }), [rules, calls])
		).toBeNull();
	});

	test('{commands} lists each command’s own word and every word that calls staff', () => {
		expect(listedWords([rules, calls])).toEqual(['rules', 'admin', 'bug', 'report']);
		expect(listedWords([])).toEqual([]);
	});
});

describe('one read of the chat', () => {
	const rules = command('rules', { command: 'rules', aliases: 'r', replies: ['one', 'two'] });
	const discord = command('discord', {
		command: 'discord',
		replies: 'join us',
		to: 'everyone',
		cooldownSeconds: 60
	});
	const calls = staff('calls', { commands: 'admin', reports: 'report', cooldownSeconds: 60 });
	const words = wordsOf([rules, discord, calls]);

	test('chat that is no command of this server leaves nothing behind', () => {
		const tracks = newChatTracks();
		const { acts, passed } = chatStep(
			words,
			tracks,
			[
				line(A, 'push the hill from the east side'),
				line(A, '!unknown'),
				line(B, 'type !rules to see them'),
				line(C, '!rules', { ping: true }),
				line('', '!rules')
			],
			NOW,
			CHAT_SENDS_PER_LOOK
		);
		expect(acts).toEqual([]);
		expect(passed).toEqual({ capped: 0, cooling: 0, cut: 0 });
		expect(tracks).toEqual(newChatTracks());
	});

	test('a command is answered: once per player inside its wait, by any of its words', () => {
		const tracks = newChatTracks();
		const first = chatStep(
			words,
			tracks,
			[line(A, '!rules'), line(B, '!R'), line(A, '!rules')],
			NOW,
			CHAT_SENDS_PER_LOOK
		);
		expect(summary(first.acts)).toEqual([
			['reply', 'rules', A, 2],
			['reply', 'rules', B, 2]
		]);
		expect(first.passed.cooling).toBe(1);
		// nine seconds on: still inside the ten; then past it
		expect(chatStep(words, tracks, [line(A, '!rules')], NOW + 9000, 8).acts).toEqual([]);
		expect(summary(chatStep(words, tracks, [line(A, '!rules')], NOW + 10_000, 8).acts)).toEqual([
			['reply', 'rules', A, 2]
		]);
	});

	test('said to everyone, a command answers once in its wait whoever types it', () => {
		const tracks = newChatTracks();
		const got = chatStep(words, tracks, [line(A, '!discord'), line(B, '!discord')], NOW, 8);
		expect(summary(got.acts)).toEqual([['reply', 'discord', A, 1]]);
		expect(chatStep(words, tracks, [line(C, '!discord')], NOW + 59_000, 8).acts).toEqual([]);
		expect(chatStep(words, tracks, [line(C, '!discord')], NOW + 60_000, 8).acts).toHaveLength(1);
	});

	test('a player gets so many answers a minute, whatever the rule', () => {
		const many = Array.from({ length: 8 }, (_, i) =>
			command(`c${i}`, { command: `c${i}`, replies: 'x', cooldownSeconds: 0 })
		);
		const all = wordsOf(many);
		const tracks = newChatTracks();
		const got = chatStep(
			all,
			tracks,
			many.map((_, i) => line(A, `!c${i}`)),
			NOW,
			100
		);
		expect(got.acts).toHaveLength(CHAT_COMMANDS_PER_MINUTE);
		expect(got.passed.capped).toBe(2);
		// another player is not held by it, and a minute on neither is the first
		expect(chatStep(all, tracks, [line(B, '!c0')], NOW + 1000, 100).acts).toHaveLength(1);
		expect(chatStep(all, tracks, [line(A, '!c7')], NOW + 59_000, 100).acts).toEqual([]);
		expect(chatStep(all, tracks, [line(A, '!c7')], NOW + 60_000, 100).acts).toHaveLength(1);
	});

	test('an answer that does not fit what the look may send is let go whole, and costs nothing', () => {
		const tracks = newChatTracks();
		const got = chatStep(words, tracks, [line(A, '!rules'), line(B, '!rules')], NOW, 3);
		// two lines each: the second player's does not fit in the one send left
		expect(summary(got.acts)).toEqual([['reply', 'rules', A, 2]]);
		expect(got.passed.cut).toBe(1);
		// B was not answered, so B's wait has not started and B has used none of their minute
		expect(summary(chatStep(words, tracks, [line(B, '!rules')], NOW + 2000, 8).acts)).toEqual([
			['reply', 'rules', B, 2]
		]);
	});

	test('a call to staff: taken once in the wait, told to wait inside it, shown how when empty', () => {
		const tracks = newChatTracks();
		const got = chatStep(
			words,
			tracks,
			[
				line(A, '!admin'),
				line(A, '!admin he is stuck at B'),
				line(A, '!admin and now he is gone'),
				line(B, '!report owl team killing')
			],
			NOW,
			8
		);
		expect(got.acts.map((a) => a.type)).toEqual(['usage', 'call', 'wait', 'call']);
		const [, call, wait, report] = got.acts;
		expect(call).toMatchObject({ rest: 'he is stuck at B', report: false, ack: true, sends: 1 });
		expect(wait).toMatchObject({ type: 'wait', seconds: 60 });
		expect(report).toMatchObject({ rest: 'owl team killing', report: true, word: 'report' });
		// half a minute on, half a minute left; then the wait is over
		expect(chatStep(words, tracks, [line(A, '!admin x')], NOW + 30_000, 8).acts[0]).toMatchObject({
			type: 'wait',
			seconds: 30
		});
		expect(chatStep(words, tracks, [line(A, '!admin x')], NOW + 60_000, 8).acts[0].type).toBe(
			'call'
		);
	});

	test('a rule with no text for it says nothing when empty or too soon', () => {
		const quiet = staff('quiet', { commands: 'mods', ack: '', usage: '', wait: '' });
		const tracks = newChatTracks();
		const got = chatStep(
			wordsOf([quiet]),
			tracks,
			[line(A, '!mods'), line(A, '!mods help'), line(A, '!mods again')],
			NOW,
			8
		);
		// the call still goes to Discord; nothing is whispered for it
		expect(got.acts.map((a) => [a.type, a.sends])).toEqual([['call', 0]]);
		expect(got.acts[0]).toMatchObject({ ack: false });
	});

	test('a call goes to Discord even when the look may send nothing more', () => {
		const tracks = newChatTracks();
		const got = chatStep(words, tracks, [line(A, '!admin help'), line(B, '!admin')], NOW, 0);
		expect(got.acts.map((a) => [a.type, a.sends])).toEqual([['call', 0]]);
		expect(got.acts[0]).toMatchObject({ ack: false });
		expect(got.passed.cut).toBe(1);
	});

	test('no rule, no reading of any line', () => {
		const tracks = newChatTracks();
		expect(chatStep(new Map(), tracks, [line(A, '!rules')], NOW, 8).acts).toEqual([]);
		expect(tracks).toEqual(newChatTracks());
	});
});

describe('what the rules may send, and what they forget', () => {
	test('so many messages a look, so many a minute', () => {
		const tracks = newChatTracks();
		expect(sendsLeft(tracks, NOW)).toBe(CHAT_SENDS_PER_LOOK);
		tracks.sent = Array.from({ length: CHAT_SENDS_PER_MINUTE - 3 }, () => NOW - 1000);
		expect(sendsLeft(tracks, NOW)).toBe(3);
		tracks.sent.push(NOW, NOW, NOW, NOW);
		expect(sendsLeft(tracks, NOW)).toBe(0);
		// a minute on they are forgotten
		expect(sendsLeft(tracks, NOW + 61_000)).toBe(CHAT_SENDS_PER_LOOK);
		expect(tracks.sent).toEqual([]);
	});

	test('a player past a rule’s wait, a rule that is gone, a quiet player: all forgotten', () => {
		const rules = command('rules', { command: 'rules', replies: 'x', cooldownSeconds: 30 });
		const tracks = newChatTracks();
		chatStep(wordsOf([rules]), tracks, [line(A, '!rules')], NOW, 8);
		tracks.players.set('gone', new Map([[B, NOW]]));
		tracks.said.set('gone', NOW);
		tracks.said.set('rules', NOW);
		pruneChatTracks(tracks, [rules], NOW + 29_000);
		expect(tracks.players.get('rules')?.has(A)).toBe(true);
		expect(tracks.players.has('gone')).toBe(false);
		expect([...tracks.said.keys()]).toEqual(['rules']);
		expect(tracks.typed.has(A)).toBe(true);
		pruneChatTracks(tracks, [rules], NOW + 61_000);
		expect(tracks.players.size).toBe(0);
		expect(tracks.typed.size).toBe(0);
	});
});

describe('a Chat command’s own placeholders', () => {
	test('{teams}: the players on each side, in the scoreboard’s order', () => {
		const players = [
			{ faction: 'Valkyra' },
			{ faction: 'Lonestar' },
			{ faction: 'Valkyra' },
			{ faction: null },
			{ faction: 'Holding' }
		];
		expect(teamsLine(players, ['Lonestar', 'Valkyra', 'Manticore'])).toBe(
			'Lonestar 1 · Valkyra 2 · Manticore 0'
		);
		// no scoreboard yet: the sides the players are on
		expect(teamsLine(players.slice(0, 3), [])).toBe('Lonestar 1 · Valkyra 2');
		expect(teamsLine([], [])).toBe('');
	});

	test('{next_map} and {rotation}: from the server’s rotation, unknown where the game does not say', () => {
		const entries = [
			{ map: 'Kavkazi', denied: false },
			{ map: 'Russia', denied: false },
			{ map: 'Kavkazi', denied: false },
			{ map: 'Europe', denied: true }
		];
		expect(rotationVars(entries, 1)).toEqual({
			next_map: 'Sabatulo',
			rotation: 'Bakurani, Sabatulo'
		});
		expect(rotationVars(entries, -1).next_map).toBe('…');
		expect(rotationVars(entries, 9).next_map).toBe('…');
		expect(rotationVars([], 0)).toEqual({ next_map: '…', rotation: '…' });
	});

	test('{top}: the board’s first three, each name on one line and cut short', () => {
		expect(
			topLine([
				{ name: 'Night Owl', kills: 1204 },
				{ name: 'A very long name that goes on and on', kills: 988 },
				{ name: 'Brick', kills: 951 },
				{ name: 'Fourth', kills: 900 }
			])
		).toBe('1. Night Owl 1204 · 2. A very long name that go 988 · 3. Brick 951');
		expect(topLine([])).toBe('…');
	});

	test('which placeholders a reply names is read once, in any case', () => {
		const cfg = validateChatCommand({ command: 'a', replies: ['{Commands} {NEXT_MAP}', '{name}'] });
		expect([...repliesUse(cfg)].sort()).toEqual(['commands', 'name', 'next_map']);
		expect(repliesUse(cfg)).toBe(repliesUse(cfg));
	});

	test('the catalogue: a reply has the player’s and their stats, a staff call’s texts no stats', () => {
		const names = (kind: 'chat_command' | 'staff_call', said = false) =>
			Object.fromEntries(placeholdersFor(kind, said).map((g) => [g.key, g.names]));
		expect(names('chat_command').own).toEqual([
			'commands',
			'teams',
			'next_map',
			'rotation',
			'rank',
			'top'
		]);
		expect(names('chat_command').org).toContain('org_kills');
		expect(names('chat_command').stats).toContain('kills');
		// said to everyone, a reply has no org-wide stats: they are the player's alone
		expect(names('chat_command', true).org).toBeUndefined();
		expect(names('chat_command', true).stats).toContain('kills');
		expect(unfilled(['{org_kills} {kills} {teams}'], 'chat_command', true)).toEqual([
			'{org_kills}'
		]);
		expect(unfilled(['{org_kills} {kills} {teams}'], 'chat_command')).toEqual([]);
		expect(names('staff_call')).toEqual({
			own: ['command', 'seconds'],
			player: ['name', 'faction', 'steamid', 'ping'],
			server: ['server', 'map', 'players', 'max', 'scores', 'cap', 'uptime']
		});
		expect(unfilled(['{kills} {command}'], 'staff_call')).toEqual(['{kills}']);
		// no placeholder of either kind carries what the player typed
		for (const kind of CHAT_KINDS)
			for (const name of MESSAGE_RULES[kind]!.own)
				expect(['args', 'text', 'message', 'rest', 'typed', 'said']).not.toContain(name);
	});
});

describe('the card a staff call sends', () => {
	const call: StaffCallCard = {
		at: '2026-11-12T18:00:00.000Z',
		word: 'admin',
		report: false,
		text: 'he is stuck under the map at B',
		channel: 'Team',
		caller: { steamId: A, name: 'Night Owl', hiddenName: 'Amber Falcon', anonymous: false },
		about: null,
		map: 'Kavkazi',
		players: 3
	};
	const body = (over: Partial<StaffCallCard> = {}, origin = 'https://panel.test') =>
		buildStaffCallEmbed(
			'Warcon',
			origin,
			{ id: 'srv1', name: 'Example Clan #1' },
			{ ...call, ...over }
		).description;
	const page = (steamId: string) => `https://panel.test/server/srv1/players/${steamId}`;

	test('who sent it, what they wrote, and where', () => {
		expect(body().split('\n')).toEqual([
			`[**Night Owl**](${page(A)}) \`${A}\``,
			'> he is stuck under the map at B',
			'Server: Example Clan #1 · Bakurani · 3 on · Team chat'
		]);
		// a panel that does not know its own address links nothing
		expect(body({}, '').split('\n')[0]).toBe(`**Night Owl** \`${A}\``);
	});

	test('a report names its player outright, says when it is a guess, or names nobody', () => {
		const report = (about: StaffCallCard['about']) =>
			body({ report: true, word: 'report', about }).split('\n')[2];
		expect(report({ steamId: B, name: 'Kova', guess: '' })).toBe(
			`About: [**Kova**](${page(B)}) \`${B}\``
		);
		expect(report({ steamId: B, name: 'Kova', guess: 'kov' })).toBe(
			`Perhaps about: [**Kova**](${page(B)}) \`${B}\` · guessed from "kov"`
		);
		expect(report(null)).toBe('About: no player on the server fits the name given');
		// a call that is no report says nothing of anyone else
		expect(body({ about: { steamId: B, name: 'Kova', guess: '' } })).not.toContain('bout:');
	});

	test('nothing a player wrote is more than text: no markdown, mention or link, theirs or the card’s', () => {
		const text = '**@everyone** ](https:/evil.example) [x](https://evil.example) <@&1> (now)';
		const d = body({ text, caller: { ...call.caller, name: 'a](https:/evil.example' } });
		expect(d).toContain(
			'> \\*\\*@everyone\\*\\* \\]\\(https:/evil.example\\) \\[x\\]\\(https:\u200B//evil.example\\) \\<@&1\\> \\(now\\)'
		);
		// one link, the card's own to the caller's page, which nothing they wrote ends or extends
		expect(d.match(/(?<!\\)\]\(/g)).toHaveLength(1);
		expect(d.match(/(?<!\\)[()]/g)).toHaveLength(2);
		expect(d).toContain(`**](${page(A)}) `);
	});

	test('a text or a name is never cut through a character, nor passed on with half of one', () => {
		// the game's cut of a long line can leave half an emoji at its end; a name can be cut here
		const d = body({
			text: 'x'.repeat(40) + '\uD83D',
			caller: { ...call.caller, name: 'n'.repeat(58) + '\u{1F600}zz' }
		});
		expect(/\p{Cs}/u.test(d)).toBe(false);
		expect(d).toContain(`**${'n'.repeat(58)}…**`);
		expect(d).toContain(`> ${'x'.repeat(40)}\uFFFD`);
	});
});
