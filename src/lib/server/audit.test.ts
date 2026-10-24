import { describe, expect, test } from 'bun:test';
import { auditMessage, redact } from './audit';
import { MAX_CHAT } from '../chat';

describe('manual whisper audit summaries', () => {
	test('single and group whispers include the text without replacing the delivery result', () => {
		for (const action of ['rcon.whisper', 'rcon.whisperMany']) {
			for (const message of ['Message sent.', 'Sent to 2 of 3 players.', 'Player not found.']) {
				expect(auditMessage({ action, message, detail: { message: 'Please switch teams.' } })).toBe(
					`Whisper: Please switch teams.\n${message}`
				);
			}
		}
	});

	test('only includes the bounded text the action sends, leaving room after a long result', () => {
		const result = auditMessage({
			action: 'rcon.whisper',
			message: 'x'.repeat(1000),
			detail: { message: `  ${'m'.repeat(400)}  ` }
		});
		expect(result).toStartWith(`Whisper: ${'m'.repeat(MAX_CHAT)}\n`);
		expect(result.length).toBeLessThanOrEqual(1000);
	});

	test('redacts credential lines before labelling the whisper', () => {
		const result = auditMessage({
			action: 'rcon.whisper',
			message: 'Sent.',
			detail: { message: 'Password=hunter2\nPlease reconnect.\nToken=secret-value' }
		});
		expect(result).toBe('Whisper: Password=[redacted]\nPlease reconnect.\nToken=[redacted]\nSent.');
	});

	test('does not expose automated text or change other action summaries', () => {
		for (const action of [
			'trigger.welcome',
			'trigger.faction_change',
			'rcon.broadcast',
			'rcon.kick'
		]) {
			expect(auditMessage({ action, message: 'Done.', detail: { message: 'private stats' } })).toBe(
				'Done.'
			);
		}
	});

	test('missing, empty and malformed text leaves the existing summary alone', () => {
		for (const detail of [
			null,
			undefined,
			{},
			{ message: '' },
			{ message: '  ' },
			{ message: 42 }
		]) {
			expect(auditMessage({ action: 'rcon.whisper', message: 'Not sent.', detail })).toBe(
				'Not sent.'
			);
		}
	});
});

describe('redact', () => {
	test('replaces values whose key looks like a credential', () => {
		expect(redact({ password: 'x', token: 't', name: 'n', nested: { apiKey: 'k' } })).toEqual({
			password: '[redacted]',
			token: '[redacted]',
			name: 'n',
			nested: { apiKey: '[redacted]' }
		});
	});

	test('scrubs Password= style lines inside text, wherever the text sits', () => {
		const ini = [
			'[/Script/WDGame.WDGameSession]',
			'ServerName=Demo',
			'ServerPassword=join-me',
			'MaxPlayers=32',
			'[/Script/WDRCON.WDRCONSettings]',
			'Password = hunter2',
			'PasswordHash=abc',
			'Port=7776'
		].join('\r\n');
		const out = redact({ text: ini, body: ini }) as { text: string; body: string };
		for (const s of [out.text, out.body]) {
			expect(s).not.toContain('hunter2');
			expect(s).not.toContain('join-me');
			expect(s).not.toContain('=abc');
			expect(s).toContain('ServerName=Demo');
			expect(s).toContain('Port=7776');
			expect(s).toContain('ServerPassword=[redacted]');
			expect(s).toContain('Password =[redacted]');
		}
		expect(redact('Password=x')).toBe('Password=[redacted]');
	});

	test('truncates long text after scrubbing', () => {
		const long = 'a'.repeat(5000);
		expect(String(redact(long))).toMatch(/^a{4000}…\[1000 more chars\]$/);
	});
});
