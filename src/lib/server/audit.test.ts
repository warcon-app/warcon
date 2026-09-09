import { describe, expect, test } from 'bun:test';
import { redact } from './audit';

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
