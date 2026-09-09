import { describe, expect, test } from 'bun:test';
import { getScalar, parseIni, quoteIfNeeded, setScalarInText } from './config-doc';

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
