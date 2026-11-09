import { describe, expect, test } from 'bun:test';
import {
	getScalar,
	hideSecretValues,
	parseIni,
	quoteIfNeeded,
	redactSecrets,
	restoreSecrets,
	setScalarInText
} from './config-doc';

const SAMPLE = [
	'; generated',
	'[/Script/WDGame.WDGameSession]',
	'ServerName=WARDOGS EU #1',
	'ServerPassword=',
	'+DefaultBannedPlayerIds="76561198000000001"',
	'+DefaultBannedPlayerIds="76561198000000002"',
	'',
	'[/Script/Engine.GameSession]',
	'MaxPlayers=128',
	'',
	'[MatchState.Playing.KOTH]',
	'ScorePeriod=24',
	''
].join('\r\n');

describe('parseIni', () => {
	test('reads scalars, arrays and sections case-insensitively', () => {
		const doc = parseIni(SAMPLE);
		expect(doc.warnings).toEqual([]);
		expect(getScalar(doc, '/script/wdgame.wdgamesession', 'servername')).toBe('WARDOGS EU #1');
		expect(getScalar(doc, '/Script/WDGame.WDGameSession', 'ServerPassword')).toBe('');
		expect(getScalar(doc, '/Script/Engine.GameSession', 'MaxPlayers')).toBe('128');
		expect(getScalar(doc, '/Script/Engine.GameSession', 'Missing')).toBeNull();
		const bans = doc.sections[0].keys.find((k) => k.key === 'DefaultBannedPlayerIds');
		expect(bans?.isArray).toBe(true);
		expect(bans?.values).toHaveLength(2);
	});
	test('strips quotes from scalar values and warns on junk', () => {
		const doc = parseIni('[A]\nUrl="https://x/y//z"\nnoequals\n');
		expect(getScalar(doc, 'A', 'Url')).toBe('https://x/y//z');
		expect(doc.warnings).toEqual(["line 3: no '=' found, skipped"]);
	});
	test('handles a BOM and array commands', () => {
		const doc = parseIni('﻿[A]\n+L=1\n+L=1\n.L=2\n-L=1\n');
		expect(doc.sections[0].keys[0].values).toEqual(['2']);
	});
});

describe('setScalarInText', () => {
	test('rewrites an existing key in place and keeps everything else byte for byte', () => {
		const out = setScalarInText(SAMPLE, '/Script/Engine.GameSession', 'MaxPlayers', '64');
		expect(out).toBe(SAMPLE.replace('MaxPlayers=128', 'MaxPlayers=64'));
		expect(out.includes('\r\n')).toBe(true);
	});
	test('matches keys case-insensitively but keeps the caller spelling', () => {
		const out = setScalarInText('[A]\nfoo=1\n', 'a', 'Foo', '2');
		expect(out).toBe('[A]\nFoo=2\n');
	});
	test('adds a missing key at the end of its section, before the blank separator', () => {
		const out = setScalarInText(SAMPLE, '/Script/Engine.GameSession', 'NewKey', 'x');
		expect(out).toContain('MaxPlayers=128\r\nNewKey=x\r\n\r\n[MatchState.Playing.KOTH]');
	});
	test('appends a missing section', () => {
		const out = setScalarInText('[A]\nk=1\n', 'B', 'x', 'y');
		expect(out).toBe('[A]\nk=1\n\n[B]\nx=y\n');
		expect(setScalarInText('', 'B', 'x', 'y')).toBe('[B]\nx=y\n');
	});
	test('does not mistake array lines for the scalar', () => {
		const out = setScalarInText('[A]\n+Ids=1\n', 'A', 'Ids', 'z');
		expect(out).toBe('[A]\n+Ids=1\nIds=z\n');
	});
	test('quotes values that need it', () => {
		expect(quoteIfNeeded('https://a//b')).toBe('"https://a//b"');
		expect(quoteIfNeeded('plain')).toBe('plain');
		expect(quoteIfNeeded(' pad')).toBe('" pad"');
		expect(setScalarInText('[A]\n', 'A', 'U', 'http://x//y')).toBe('[A]\nU="http://x//y"\n');
	});
	test('a parse of the edited text sees the new value', () => {
		const out = setScalarInText(SAMPLE, '/Script/WDGame.WDGameSession', 'ServerName', 'New');
		expect(getScalar(parseIni(out), '/Script/WDGame.WDGameSession', 'ServerName')).toBe('New');
	});
});

describe('credentials', () => {
	const LIVE = [
		'[/Script/WDGame.WDGameSession]',
		'ServerName=EU #1',
		'ServerPassword=scrim-night',
		'',
		'[/Script/WDRCON.WDRCONSettings]',
		'bEnabled=true',
		'; Password=last-years',
		'Password=hunter2',
		'PasswordHash=',
		'',
		'[WDServerFeed]',
		'Url=https://console.example',
		'Token=wcf_abc',
		''
	].join('\r\n');

	test('the RCON password, its hash and the feed token are hidden, commented out or not', () => {
		const out = redactSecrets(LIVE);
		expect(out).not.toContain('hunter2');
		expect(out).not.toContain('last-years');
		expect(out).not.toContain('wcf_abc');
		expect(out).toContain('Password=(hidden)');
		expect(out).toContain('; Password=(hidden)');
		expect(out).toContain('Token=(hidden)');
	});
	test('nothing else moves: the join password, empty values, line endings', () => {
		const out = redactSecrets(LIVE);
		expect(out).toContain('ServerPassword=scrim-night');
		expect(out).toContain('PasswordHash=\r\n');
		expect(out.split('\r\n')).toHaveLength(LIVE.split('\r\n').length);
		expect(redactSecrets('[A]\nk=1\n')).toBe('[A]\nk=1\n');
	});
	test('keys match whatever their case or array prefix', () => {
		expect(redactSecrets('[x]\n  password = a\n+TOKEN=b\n')).toBe(
			'[x]\n  password =(hidden)\n+TOKEN=(hidden)\n'
		);
	});
	test('an untouched document goes back exactly as the server had it', () => {
		expect(restoreSecrets(redactSecrets(LIVE), LIVE)).toBe(LIVE);
	});
	test('an edit elsewhere keeps the credentials; a typed credential stays as typed', () => {
		const shown = redactSecrets(LIVE);
		const renamed = restoreSecrets(shown.replace('EU #1', 'EU #2'), LIVE);
		expect(renamed).toBe(LIVE.replace('EU #1', 'EU #2'));
		const rotated = restoreSecrets(
			shown.replace('\r\nPassword=(hidden)', '\r\nPassword=new-one'),
			LIVE
		);
		expect(rotated).toContain('\r\nPassword=new-one\r\n');
		expect(rotated).toContain('; Password=last-years');
		expect(rotated).toContain('Token=wcf_abc');
	});
	test('a removed credential line stays removed', () => {
		const shown = redactSecrets(LIVE).replace('Token=(hidden)\r\n', '');
		expect(restoreSecrets(shown, LIVE)).not.toContain('Token=');
	});
	test('a placeholder with nothing behind it is refused, never written as the password', () => {
		expect(() =>
			restoreSecrets('[/Script/WDRCON.WDRCONSettings]\nPassword=(hidden)\n', '[A]\nk=1\n')
		).toThrow(/does not have/);
	});
	test('a byte order mark the client dropped does not orphan the first section', () => {
		const live = '\uFEFF[WDServerFeed]\nToken=t1\n';
		expect(restoreSecrets('[WDServerFeed]\nToken=(hidden)\n', live)).toBe(
			'[WDServerFeed]\nToken=t1\n'
		);
	});

	// CL-516586 reads the kill feed from the RCON block, a list the game itself writes this way.
	const FEED = [
		'[/Script/WDRCON.WDRCONSettings]',
		'bEnabled=true',
		'Password=hunter2',
		'bEventFeedEnabled=True',
		'!EventFeedEndpoints=ClearArray',
		'.EventFeedEndpoints=(Url="https://console.example",Token="wkf_first")',
		'.EventFeedEndpoints=(Url="https://bot.example/hook",Token=wkf_second)',
		'EventFeedServerName="EU #1"',
		'',
		'[/Script/WDGame.WDServerMapRotationSettings]',
		'!RotationEntries=ClearArray',
		'.RotationEntries=(Map="Kavkazi",Experiences="Bakurani_KOTH_01",Lighting="DayClear")',
		''
	].join('\n');

	test('each feed endpoint is hidden whole, its token and its address', () => {
		const out = redactSecrets(FEED);
		for (const s of ['wkf_first', 'wkf_second', 'console.example', 'bot.example'])
			expect(out).not.toContain(s);
		expect(out).toContain('\n.EventFeedEndpoints=(hidden)\n.EventFeedEndpoints=(hidden)\n');
	});
	test('the feed switch, its name and the list commands stay readable', () => {
		const out = redactSecrets(FEED);
		expect(out).toContain('\nbEventFeedEnabled=True\n');
		expect(out).toContain('\n!EventFeedEndpoints=ClearArray\n');
		expect(out).toContain('\nEventFeedServerName="EU #1"\n');
		expect(out).toContain('\n!RotationEntries=ClearArray\n');
		expect(out).toContain('\n.RotationEntries=(Map="Kavkazi",');
	});
	test("an endpoint's token quoted alone in the game's answer is hidden, and nothing else", () => {
		const answer = { errors: ['Token wkf_second was refused', '!RotationEntries=ClearArray'] };
		expect(hideSecretValues(answer, FEED)).toEqual({
			errors: ['Token (hidden) was refused', '!RotationEntries=ClearArray']
		});
	});
	test('both endpoints go back in their places', () => {
		expect(restoreSecrets(redactSecrets(FEED), FEED)).toBe(FEED);
	});
	test('a token among the fields of any other struct is a credential too', () => {
		const live = '[x]\n+WebhookTargets=(Url="https://h.example",token="s3cret")\n';
		expect(redactSecrets(live)).toBe('[x]\n+WebhookTargets=(hidden)\n');
		expect(restoreSecrets(redactSecrets(live), live)).toBe(live);
	});
});
