// What counts as a command in the in-game chat, and whom a report names: one line read on its own.
import { describe, expect, test } from 'bun:test';
import {
	byCommand,
	commandRow,
	commandsLine,
	commandWord,
	MAX_COMMAND_WORD,
	namedPlayer,
	readCommand,
	typedCommand,
	type CommandRow
} from './chat-commands';

const line = (text: string, over: Record<string, unknown> = {}) => ({
	text,
	typed: null as string | null,
	ping: false,
	steamId: '76561198000000801',
	...over
});

describe('a command word', () => {
	test('letters and digits, kept in lower case without the "!"', () => {
		expect(commandWord('rules')).toBe('rules');
		expect(commandWord('!Rules')).toBe('rules');
		expect(commandWord('  R2  ')).toBe('r2');
		expect(commandWord('a'.repeat(MAX_COMMAND_WORD))).toBe('a'.repeat(MAX_COMMAND_WORD));
	});

	test('anything else is no word', () => {
		for (const no of [
			'',
			' ',
			'!',
			'two words',
			'rules!',
			'!!rules',
			'règles',
			'a-b',
			'a_b',
			'{name}',
			'a'.repeat(MAX_COMMAND_WORD + 1)
		])
			expect(commandWord(no)).toBe('');
		for (const no of [5, null, undefined, ['rules'], { word: 'rules' }])
			expect(commandWord(no)).toBe('');
	});
});

describe('a line read as a command', () => {
	test('"!" and a word, alone or with what follows it', () => {
		expect(readCommand('!rules')).toEqual({ word: 'rules', rest: '' });
		expect(readCommand('  !Admin   he is stuck  at B ')).toEqual({
			word: 'admin',
			rest: 'he is stuck  at B'
		});
		expect(readCommand('!report owl')).toEqual({ word: 'report', rest: 'owl' });
	});

	test('chat that is not a command is not one', () => {
		for (const no of [
			'rules',
			'! rules',
			'!!rules',
			'!rules.',
			'!rules,now',
			'say !rules',
			'!',
			'',
			'/rules',
			`!${'a'.repeat(MAX_COMMAND_WORD + 1)}`
		])
			expect(readCommand(no)).toBeNull();
	});

	test('never a ping callout, never a line with nobody to answer', () => {
		expect(typedCommand(line('!rules'))).toEqual({ word: 'rules', rest: '' });
		expect(typedCommand(line('!rules', { ping: true }))).toBeNull();
		expect(typedCommand(line('!rules', { steamId: '' }))).toBeNull();
	});

	test('read as the others saw it, and as typed where the chat filter left no command', () => {
		// the filter starred a word of the message: the command stands, with the message as shown
		expect(
			typedCommand(line('!admin that **** is cheating', { typed: '!admin that fool is cheating' }))
		).toEqual({ word: 'admin', rest: 'that **** is cheating' });
		// it starred the word itself: what was typed says which command it was
		expect(typedCommand(line('!**** help', { typed: '!admin help' }))).toEqual({
			word: 'admin',
			rest: 'help'
		});
		// typed chat that the filter turned into something that looks like nothing
		expect(typedCommand(line('****', { typed: 'hello there' }))).toBeNull();
	});

	test('the words as players type them', () => {
		expect(commandsLine(['rules', 'discord', 'admin'])).toBe('!rules !discord !admin');
		expect(commandsLine([])).toBe('');
	});
});

describe('whom a report names', () => {
	const OWL = { steamId: '76561198000000701', name: '[ABC] Night Owl' };
	const KOVA = { steamId: '76561198000000702', name: 'Kova' };
	const KOVACS = { steamId: '76561198000000703', name: 'Kovacs' };
	const BRICK = { steamId: '76561198000000704', name: 'Brick' };
	const ME = '76561198000000799';
	const on = [OWL, KOVA, KOVACS, BRICK, { steamId: ME, name: 'Caller Brickson' }];
	const outright = <P>(player: P) => ({ player, guess: '' });

	test('a whole name the text starts with names its player outright', () => {
		expect(namedPlayer('kova is wallhacking', on, ME)).toEqual(outright(KOVA));
		expect(namedPlayer('Kovacs is wallhacking', on, ME)).toEqual(outright(KOVACS));
		expect(namedPlayer('[abc] night owl team kills', on, ME)).toEqual(outright(OWL));
		expect(namedPlayer('brick', on, ME)).toEqual(outright(BRICK));
	});

	test('the longest of several whole names is a guess: the shorter one may have been meant', () => {
		const BOB = { steamId: '76561198000000706', name: 'Bob' };
		const BOB_IS = { steamId: '76561198000000707', name: 'Bob is' };
		expect(namedPlayer('bob is cheating', [BOB, BOB_IS], ME)).toEqual({
			player: BOB_IS,
			guess: 'bob is'
		});
		expect(namedPlayer('bob cheats', [BOB, BOB_IS], ME)).toEqual(outright(BOB));
	});

	test('else the one player whose name starts with the first word, or has it in it: a guess, and it says from what', () => {
		expect(namedPlayer('bri shooting teammates', on, ME)).toEqual({ player: BRICK, guess: 'bri' });
		expect(namedPlayer('owl shooting teammates', on, ME)).toEqual({ player: OWL, guess: 'owl' });
		expect(namedPlayer('Night shooting teammates', on, ME)).toEqual({
			player: OWL,
			guess: 'night'
		});
		// a report that starts with no name at all finds one too, which is why a guess is marked
		const PANTHER = { steamId: '76561198000000708', name: 'Panther' };
		const ROCKET = { steamId: '76561198000000709', name: 'TeamRocket' };
		expect(namedPlayer('the tank at north is tking', [...on, PANTHER], ME)).toEqual({
			player: PANTHER,
			guess: 'the'
		});
		expect(namedPlayer('team killer at spawn', [...on, ROCKET], ME)).toEqual({
			player: ROCKET,
			guess: 'team'
		});
	});

	test('nobody when more than one fits, or the word is too short to mean anyone', () => {
		// "kov" starts two names
		expect(namedPlayer('kov cheats', on, ME)).toBeNull();
		expect(namedPlayer('ow cheats', on, ME)).toBeNull();
		expect(namedPlayer('he is cheating', on, ME)).toBeNull();
		expect(namedPlayer('', on, ME)).toBeNull();
		expect(namedPlayer('kova', [], ME)).toBeNull();
		// two players under one name
		expect(namedPlayer('kova cheats', [KOVA, { ...KOVA, steamId: '76561198000000705' }], ME)).toBe(
			null
		);
	});

	test('never the caller, and a SteamID typed out is that player or nobody', () => {
		expect(namedPlayer('caller brickson is great', on, ME)).toBeNull();
		// without the caller on the list "brick" would have two takers; with them left out it has one
		expect(namedPlayer('brick', on, ME)).toEqual(outright(BRICK));
		expect(namedPlayer(`${KOVACS.steamId} aimbot`, on, ME)).toEqual(outright(KOVACS));
		expect(namedPlayer('76561198000000999 aimbot', on, ME)).toBeNull();
		expect(namedPlayer(`${ME} aimbot`, on, ME)).toBeNull();
	});
});

describe('a rule as a line of the Chat commands list', () => {
	test('a Chat command: its word first, its first line, the lines after it counted', () => {
		expect(
			commandRow('chat_command', {
				command: 'rules',
				aliases: ['r', 'regeln'],
				replies: ['No team killing.', 'Respect the staff.', 'More on our Discord.'],
				to: 'player',
				cooldownSeconds: 10
			})
		).toEqual({
			words: ['!rules', '!r', '!regeln'],
			reports: [],
			reply: 'No team killing.',
			more: 2,
			to: 'player',
			seconds: 10
		});
		expect(
			commandRow('chat_command', { command: 'top', replies: ['{top}'], to: 'everyone' })
		).toEqual({
			words: ['!top'],
			reports: [],
			reply: '{top}',
			more: 0,
			to: 'everyone',
			seconds: 0
		});
	});

	test('a Staff call: the words that call staff, then those that report, and what it whispers back', () => {
		expect(
			commandRow('staff_call', {
				commands: ['admin', 'staff'],
				reports: ['report'],
				ack: ' On its way. ',
				usage: 'Say what is wrong.',
				cooldownSeconds: 60
			})
		).toEqual({
			words: ['!admin', '!staff', '!report'],
			reports: ['!report'],
			reply: 'On its way.',
			more: 0,
			to: 'staff',
			seconds: 60
		});
		// one that whispers nothing back, and reports only
		expect(
			commandRow('staff_call', { commands: [], reports: ['report', 'cheater'], ack: '' })
		).toEqual({
			words: ['!report', '!cheater'],
			reports: ['!report', '!cheater'],
			reply: '',
			more: 0,
			to: 'staff',
			seconds: 0
		});
	});

	test('a config the panel did not save gives an empty line, never an error', () => {
		const empty: CommandRow = {
			words: [],
			reports: [],
			reply: '',
			more: 0,
			to: 'player',
			seconds: 0
		};
		expect(commandRow('chat_command', {})).toEqual(empty);
		expect(
			commandRow('chat_command', {
				command: 'two words',
				aliases: 'r',
				replies: [' ', 7, null],
				to: 'nobody',
				cooldownSeconds: -5
			})
		).toEqual(empty);
		expect(commandRow('staff_call', { commands: null, reports: [{}], ack: 7 })).toEqual({
			...empty,
			to: 'staff'
		});
		// a word listed twice is one word, and one in both of a Staff call's lists calls staff
		expect(commandRow('chat_command', { command: 'r', aliases: ['r', 'R'] }).words).toEqual(['!r']);
		const both = commandRow('staff_call', {
			commands: ['admin', 'admin'],
			reports: ['admin', 'x']
		});
		expect(both.words).toEqual(['!admin', '!x']);
		expect(both.reports).toEqual(['!x']);
	});

	test('the list starts with the Staff call, then goes by the first word', () => {
		const rule = (kind: 'chat_command' | 'staff_call', config: Record<string, unknown>) => ({
			kind,
			row: commandRow(kind, config)
		});
		// by the first word, not the least or the last of a rule's words: !zeta has !alpha too, !beta
		// has !zz; and by the letters as written, digits before letters
		const sorted = [
			rule('chat_command', { command: 'zeta', aliases: ['alpha'] }),
			rule('chat_command', {}),
			rule('staff_call', { commands: ['zulu'] }),
			rule('chat_command', { command: 'beta', aliases: ['zz'] }),
			rule('chat_command', { command: 'b2' }),
			rule('chat_command', { command: '9lives' })
		].sort(byCommand);
		expect(sorted.map((r) => r.row.words[0] ?? '')).toEqual([
			'!zulu',
			'',
			'!9lives',
			'!b2',
			'!beta',
			'!zeta'
		]);
		// two that start alike stay in the order they came
		expect(
			byCommand(rule('chat_command', { command: 'a' }), rule('chat_command', { command: 'a' }))
		).toBe(0);
	});
});
