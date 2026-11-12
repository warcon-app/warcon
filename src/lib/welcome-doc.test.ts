import { describe, expect, test } from 'bun:test';
import { getScalar, parseIni, redactSecrets, restoreSecrets } from './config-doc';
import { S_STATE } from './config-fields';
import type { ConfigSection } from './types';
import {
	knowsWelcome,
	WELCOME_KEYS,
	welcomeLinesFromText,
	welcomeLinesIntoText,
	welcomeRefusals
} from './welcome-doc';
import { WELCOME_LIMITS } from './welcome-text';

// The popup as the official console's demo server holds it (its redeploy of 12 November 2026),
// in a file with the things an edit must leave alone around it.
const DOC = [
	'; managed by hand',
	'[/Script/WDGame.WDGameSession]',
	'ServerName=Dogpile EU #1',
	'',
	'[/Script/WDGame.WDGameStateSession]',
	'bLockOverpopulatedTeamsConfig=true',
	'; the popup',
	'bServerWelcomeMessageEnabled=True',
	'ServerWelcomeMessageCloseDelaySeconds=5',
	'bServerWelcomeMessageSkipForStreamers=False',
	'!ServerWelcomeMessageLines=ClearArray',
	'.ServerWelcomeMessageLines=<Header>Welcome to the server</>',
	'.ServerWelcomeMessageLines=Be kind, play the objective and have fun.',
	'.ServerWelcomeMessageLines=',
	'.ServerWelcomeMessageLines="<text color=\\"#7FD6FF\\">https://wardogs.example</>"',
	'OverpopulatedTeamThresholdConfig=2',
	'',
	'[/Script/WDRCON.WDRCONSettings]',
	'bEnabled=true',
	'Password=hunter2',
	''
].join('\r\n');
const LINES = [
	'<Header>Welcome to the server</>',
	'Be kind, play the objective and have fun.',
	'',
	'<text color="#7FD6FF">https://wardogs.example</>'
];

describe('the popup’s text in the config document', () => {
	test('read as the lines of the popup, quotes and their escapes off', () => {
		expect(welcomeLinesFromText(DOC)).toEqual(LINES);
	});
	test('a document that does not set it has none; one that empties it has no lines', () => {
		expect(welcomeLinesFromText('[/Script/WDGame.WDGameStateSession]\nx=1\n')).toBeNull();
		expect(welcomeLinesFromText('')).toBeNull();
		expect(
			welcomeLinesFromText(
				'[/Script/WDGame.WDGameStateSession]\n!ServerWelcomeMessageLines=ClearArray\n'
			)
		).toEqual([]);
		// the same key in another section is another key
		expect(welcomeLinesFromText('[Other]\n.ServerWelcomeMessageLines=hello\n')).toBeNull();
	});
	test('lines written by hand with +, which the game adds once each', () => {
		expect(
			welcomeLinesFromText(
				[
					'[/script/wdgame.wdgamestatesession]',
					'+serverwelcomemessagelines=Rules:',
					'+ServerWelcomeMessageLines="1. No cheating"',
					'+ServerWelcomeMessageLines=Rules:'
				].join('\n')
			)
		).toEqual(['Rules:', '1. No cheating']);
	});
	test('written back as one block where the old one was, and nothing else moves', () => {
		const next = ['<Bold>No cheating</>', '', '', 'Discord: https://discord.example/dogpile'];
		const out = welcomeLinesIntoText(DOC, next);
		expect(out).toBe(
			DOC.replace(
				[
					'!ServerWelcomeMessageLines=ClearArray',
					'.ServerWelcomeMessageLines=<Header>Welcome to the server</>',
					'.ServerWelcomeMessageLines=Be kind, play the objective and have fun.',
					'.ServerWelcomeMessageLines=',
					'.ServerWelcomeMessageLines="<text color=\\"#7FD6FF\\">https://wardogs.example</>"'
				].join('\r\n'),
				[
					'!ServerWelcomeMessageLines=ClearArray',
					'.ServerWelcomeMessageLines=<Bold>No cheating</>',
					'.ServerWelcomeMessageLines=',
					'.ServerWelcomeMessageLines=',
					'.ServerWelcomeMessageLines="Discord: https://discord.example/dogpile"'
				].join('\r\n')
			)
		);
		expect(welcomeLinesFromText(out)).toEqual(next);
		expect(parseIni(out).warnings).toEqual([]);
	});
	test('added to the section when the file has none, and with the section when it has neither', () => {
		const bare =
			'[/Script/WDGame.WDGameStateSession]\nbLockOverpopulatedTeamsConfig=true\n\n[B]\nx=1\n';
		expect(welcomeLinesIntoText(bare, ['Hello'])).toBe(
			'[/Script/WDGame.WDGameStateSession]\nbLockOverpopulatedTeamsConfig=true\n!ServerWelcomeMessageLines=ClearArray\n.ServerWelcomeMessageLines=Hello\n\n[B]\nx=1\n'
		);
		const none = welcomeLinesIntoText('[B]\nx=1\n', ['Hello']);
		expect(none).toBe(
			'[B]\nx=1\n\n[/Script/WDGame.WDGameStateSession]\n!ServerWelcomeMessageLines=ClearArray\n.ServerWelcomeMessageLines=Hello\n'
		);
		expect(welcomeLinesFromText(none)).toEqual(['Hello']);
	});
	test('whatever a line holds comes back as it went in, and stays one line of the file', () => {
		const awkward = [
			'"Dogpile" rules',
			'  centred  ',
			'Welcome {player} | have fun',
			'visit https://x.example/a//b',
			'a\\b\\',
			'; not a comment',
			'# nor this',
			'[/Script/WDRCON.WDRCONSettings]',
			'Password=letmein',
			'!ServerWelcomeMessageLines=ClearArray',
			'<text color="#FF4D4D" size="20" fontface="Bold">SERVER RULES</>',
			'1 &lt; 2 &amp; “curly” 😀',
			''
		];
		const out = welcomeLinesIntoText(DOC, awkward);
		expect(welcomeLinesFromText(out)).toEqual(awkward);
		const before = parseIni(DOC);
		const after = parseIni(out);
		expect(after.warnings).toEqual([]);
		expect(after.sections.map((s) => s.name)).toEqual(before.sections.map((s) => s.name));
		// a line that reads like a key is still text: the RCON block is as it was
		expect(getScalar(after, '/Script/WDRCON.WDRCONSettings', 'Password')).toBe('hunter2');
		expect(out.split('\r\n')).toHaveLength(DOC.split('\r\n').length - 4 + awkward.length);
	});
	test('a line break inside a line cannot start a line of the file', () => {
		const out = welcomeLinesIntoText(DOC, [
			'hello\n[/Script/WDRCON.WDRCONSettings]\r\nPassword=mine'
		]);
		const after = parseIni(out);
		expect(getScalar(after, '/Script/WDRCON.WDRCONSettings', 'Password')).toBe('hunter2');
		expect(after.sections).toHaveLength(parseIni(DOC).sections.length);
		expect(welcomeLinesFromText(out)).toEqual([
			'hello [/Script/WDRCON.WDRCONSettings] Password=mine'
		]);
	});
	test('an edit of the popup on the document as the panel hands it out keeps the password', () => {
		// what a browser holds is the redacted text; the edit is made on that and sent back
		const shown = redactSecrets(DOC);
		expect(shown).not.toContain('hunter2');
		expect(welcomeLinesFromText(shown)).toEqual(LINES);
		const edited = welcomeLinesIntoText(shown, ['<Bold>New text</>']);
		expect(edited).not.toContain('hunter2');
		const sent = restoreSecrets(edited, DOC);
		expect(getScalar(parseIni(sent), '/Script/WDRCON.WDRCONSettings', 'Password')).toBe('hunter2');
		expect(welcomeLinesFromText(sent)).toEqual(['<Bold>New text</>']);
	});
});

describe('whether a server shows any sign of the popup', () => {
	const section = (allowedKeys?: string[], overrides: string[] = []): ConfigSection[] => [
		{
			section: S_STATE,
			appliesWhen: 'next-match',
			allowedKeys,
			keyOverrides: overrides.map((key) => ({ key, appliesWhen: 'next-match' }))
		}
	];
	const old = ['bLockOverpopulatedTeamsConfig', 'OverpopulatedTeamThresholdConfig'];
	const empty = parseIni(
		'[/Script/WDGame.WDGameStateSession]\nbLockOverpopulatedTeamsConfig=true\n'
	);

	test('a build from before Season 3 does not: no key listed, no limits, nothing in the file', () => {
		expect(knowsWelcome(section(old), empty, false)).toBe(false);
		expect(knowsWelcome([], empty, false)).toBe(false);
		expect(knowsWelcome(section(undefined), empty, false)).toBe(false);
	});
	test('one that lists the text among its keys does, however it spells it', () => {
		expect(knowsWelcome(section([...old, ...WELCOME_KEYS]), empty, false)).toBe(true);
		expect(knowsWelcome(section([...old, 'serverwelcomemessagelines']), empty, false)).toBe(true);
		expect(knowsWelcome(section(old, ['ServerWelcomeMessageLines']), empty, false)).toBe(true);
	});
	test('so does one whose status reports the limits, or whose file already has the popup', () => {
		expect(knowsWelcome(section(old), empty, true)).toBe(true);
		expect(knowsWelcome(section(old), parseIni(DOC), false)).toBe(true);
		expect(
			knowsWelcome(
				[],
				parseIni('[/Script/WDGame.WDGameStateSession]\nbServerWelcomeMessageEnabled=False\n'),
				false
			)
		).toBe(true);
	});
});

describe('what an apply is asked about first', () => {
	const long = 'x'.repeat(129);
	test('a line the game refuses, once this edit has changed the popup’s text', () => {
		const edited = welcomeLinesIntoText(DOC, [...LINES, long, '<a href="x">y</>']);
		expect(welcomeRefusals(edited, DOC, WELCOME_LIMITS).map((i) => i.message)).toEqual([
			'Line 5 has 129 visible characters, and the popup takes 128.',
			'Line 6: <a> is not a tag the popup takes; only <text> has attributes.'
		]);
		// against the limits the server reports
		expect(
			welcomeRefusals(edited, DOC, { ...WELCOME_LIMITS, maxLines: 5 }).map((i) => i.line)
		).toEqual([null, 5]);
	});
	test('not a line the server already had: that is the file’s own, and holds nothing else up', () => {
		const onServer = welcomeLinesIntoText(DOC, [long]);
		const renamed = onServer.replace('Dogpile EU #1', 'Dogpile EU #2');
		expect(welcomeRefusals(renamed, onServer, WELCOME_LIMITS)).toEqual([]);
	});
	test('nor what the game takes and shows as typed, nor a document without a popup', () => {
		const typed = welcomeLinesIntoText(DOC, ['<Bold>No cheating</Bold>']);
		expect(welcomeRefusals(typed, DOC, WELCOME_LIMITS)).toEqual([]);
		expect(welcomeRefusals('[A]\nx=1\n', DOC, WELCOME_LIMITS)).toEqual([]);
		expect(welcomeRefusals(DOC, '', WELCOME_LIMITS)).toEqual([]);
	});
});
