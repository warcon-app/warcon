import { describe, expect, test } from 'bun:test';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { addressKey, ApiError, CLIENT_IP_HEADER, forLog, publicMessage } from './http';

describe('publicMessage', () => {
	test('passes our own errors through', () => {
		expect(publicMessage(new ApiError(400, 'name is required.'))).toBe('name is required.');
	});

	test('hides everything else behind a generic line', () => {
		const quiet = console.error;
		console.error = () => {};
		try {
			expect(publicMessage(new Error('password authentication failed for user "warcon"'))).toBe(
				'Internal error.'
			);
			expect(publicMessage('boom', 'Poll failed.')).toBe('Poll failed.');
		} finally {
			console.error = quiet;
		}
	});
});

test('the stored lockout key is a keyed hash of the address, never the address', () => {
	const from = (ip: string) =>
		new Request('http://localhost/', { headers: ip ? { [CLIENT_IP_HEADER]: ip } : {} });
	const key = addressKey(from('203.0.113.7'), 'secret-one');
	expect(key).toMatch(/^[0-9a-f]{32}$/);
	expect(key).toBe(addressKey(from('203.0.113.7'), 'secret-one'));
	expect(key).not.toBe(addressKey(from('203.0.113.8'), 'secret-one'));
	expect(key).not.toBe(addressKey(from('203.0.113.7'), 'secret-two'));
	expect(addressKey(from(''), 'secret-one')).toBe('unknown');
});

test('a failed query is logged without its parameters: for the servers table they are the stored RCON password and the address', () => {
	const failed = new DrizzleQueryError(
		'insert into "servers" ("id", "host", "password_enc", "notes") values ($1, $2, $3, $4)',
		['s1', 'rcon.example.net', 'v1.aaaa.bbbbcccc', 'two\nlines'],
		new Error('duplicate key value violates unique constraint "servers_pkey"')
	);
	const logged = String(forLog(failed));
	expect(logged).toContain('insert into "servers"');
	expect(logged).toContain('duplicate key value');
	expect(logged).not.toContain('v1.aaaa.bbbbcccc');
	expect(logged).not.toContain('rcon.example.net');
	expect(logged).not.toContain('lines');
	expect(forLog('plain')).toBe('plain');
});

test('a parameter with a line like a stack frame does not end the cut early', () => {
	for (const note of [
		'first line\n   at the base, SECRET-REST-OF-PARAMS',
		'first line\n    at fake (file.ts:1:1)\nSECRET-REST-OF-PARAMS'
	]) {
		const failed = new DrizzleQueryError(
			'update "players" set "note" = $1',
			[note],
			new Error('canceling statement due to user request')
		);
		for (const logged of [String(forLog(failed)), String(forLog(failed.message))]) {
			expect(logged).not.toContain('SECRET-REST-OF-PARAMS');
			expect(logged).not.toContain('first line');
			expect(logged).toContain('update "players" set "note" = $1\nparams: (not logged)');
		}
		const logged = String(forLog(failed));
		// the frames are still there, and the cause
		expect(logged).toMatch(/\n\s+at .*http\.test\.ts/);
		expect(logged).toContain('cause: canceling statement due to user request');
	}
});
