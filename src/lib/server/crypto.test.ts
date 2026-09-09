import { describe, expect, test } from 'bun:test';
import {
	authSecretProblem,
	decryptSecret,
	encryptSecret,
	encryptionKey,
	SECRET_PLACEHOLDER,
	timingSafeEqualStr
} from './crypto';
import type { Env } from './env';

// Bytes 0..31, base64. The blob below was produced by the earlier WebCrypto implementation;
// decrypting it proves the node:crypto rewrite reads existing rows unchanged.
const KEY = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const LEGACY_BLOB = 'v1.47md1B5egPZL0Syh.Qn/5zgG1uOLcL6jZNLJaxdnsDCCyGJf0Hh25u46EYmp2EeqP6A==';
const env = { ENCRYPTION_KEY: KEY } as Env;

describe('stored secrets (AES-256-GCM)', () => {
	test('round-trips and uses a fresh iv each time', () => {
		const a = encryptSecret(env, 'rcon password');
		const b = encryptSecret(env, 'rcon password');
		expect(a).not.toBe(b);
		expect(a).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
		expect(decryptSecret(env, a)).toBe('rcon password');
		expect(decryptSecret(env, b)).toBe('rcon password');
	});

	test('decrypts blobs written by the previous implementation', () => {
		expect(decryptSecret(env, LEGACY_BLOB)).toBe('hunter2 correct horse');
	});

	test('rejects a tampered blob and a changed key', () => {
		const blob = encryptSecret(env, 'x');
		const [v, iv, ct] = blob.split('.');
		const flipped = Buffer.from(ct, 'base64');
		flipped[0] ^= 1;
		expect(() => decryptSecret(env, `${v}.${iv}.${flipped.toString('base64')}`)).toThrow(
			'Could not decrypt'
		);
		const other = { ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') } as Env;
		expect(() => decryptSecret(other, blob)).toThrow('Could not decrypt');
		expect(() => decryptSecret(env, 'v0.a.b')).toThrow('Unknown secret format');
	});

	test('validates the key up front', () => {
		expect(encryptionKey(env)).toHaveLength(32);
		expect(encryptionKey({ ENCRYPTION_KEY: KEY.replace(/\+/g, '-').replace(/\//g, '_') })).toEqual(
			encryptionKey(env)
		);
		expect(() => encryptionKey({ ENCRYPTION_KEY: '' })).toThrow('ENCRYPTION_KEY');
		expect(() => encryptionKey({ ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow('32 bytes');
	});
});

describe('authSecretProblem', () => {
	test('accepts a real secret, refuses the placeholder and short values', () => {
		expect(authSecretProblem('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=')).toBeNull();
		expect(authSecretProblem('x'.repeat(32))).toBeNull();
		expect(authSecretProblem(undefined)).toBeNull(); // "not set" is reported elsewhere
		expect(authSecretProblem(SECRET_PLACEHOLDER)).toMatch(/placeholder/);
		expect(authSecretProblem('short-secret')).toMatch(/at least 32/);
		expect(authSecretProblem('x'.repeat(31))).toMatch(/at least 32/);
	});
});

describe('timingSafeEqualStr', () => {
	test('compares by content', () => {
		expect(timingSafeEqualStr('token', 'token')).toBe(true);
		expect(timingSafeEqualStr('token', 'tokem')).toBe(false);
		expect(timingSafeEqualStr('token', 'token ')).toBe(false);
		expect(timingSafeEqualStr('', '')).toBe(true);
	});
});
