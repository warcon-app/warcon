// Guards the decision to use Better Auth's stock hasher: on Bun it must be native scrypt,
// round-trip, and never accept a hash from the retired PBKDF2 format.
import { describe, expect, test } from 'bun:test';
import { hashPassword, verifyPassword } from 'better-auth/crypto';

describe('password hashing (Better Auth default)', () => {
	test('round-trips and rejects wrong passwords', async () => {
		const hash = await hashPassword('correct horse battery');
		expect(hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
		expect(await verifyPassword({ hash, password: 'correct horse battery' })).toBe(true);
		expect(await verifyPassword({ hash, password: 'wrong' })).toBe(false);
	});

	test('salts every hash', async () => {
		expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
	});

	test('rejects the retired pbkdf2$ format outright', async () => {
		// Any row still carrying an old hash needs an owner reset; it must not verify.
		const legacy =
			'pbkdf2$100000$pRBYRopw0yNNdnvsxxyfuQ==$h2E9pH9rZaJh4UaRF9MSyVa5eve409nsU0mc7quhiPQ=';
		await expect(verifyPassword({ hash: legacy, password: 'correct horse' })).rejects.toThrow(
			'Invalid password hash'
		);
	});
});
