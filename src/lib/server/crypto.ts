// Secrets at rest: stored RCON passwords are AES-256-GCM under ENCRYPTION_KEY.
// Blob format: `v1.<base64 iv>.<base64 ciphertext||tag>` (the 16-byte GCM tag is appended).
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Env } from './env';
import { ApiError } from './http';

const TAG_BYTES = 16;

/** Constant-time string comparison (length leaks, contents do not). */
export function timingSafeEqualStr(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Decodes ENCRYPTION_KEY (base64 or base64url of 32 bytes). Throws when it is unusable. */
export function encryptionKey(env: Pick<Env, 'ENCRYPTION_KEY'>): Buffer {
	const bytes = Buffer.from(env.ENCRYPTION_KEY || '', 'base64');
	if (bytes.length !== 32) {
		throw new ApiError(
			500,
			'ENCRYPTION_KEY secret is missing or is not base64 of 32 bytes. Set it in .env (openssl rand -base64 32).',
			'config'
		);
	}
	return bytes;
}

export function encryptSecret(env: Env, plaintext: string): string {
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', encryptionKey(env), iv);
	const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
	return `v1.${iv.toString('base64')}.${ct.toString('base64')}`;
}

export function decryptSecret(env: Env, blob: string): string {
	const [version, ivB64, ctB64] = blob.split('.');
	if (version !== 'v1' || !ivB64 || !ctB64) {
		throw new ApiError(500, 'Unknown secret format.', 'config');
	}
	const key = encryptionKey(env);
	try {
		const data = Buffer.from(ctB64, 'base64');
		if (data.length < TAG_BYTES) throw new Error('short');
		const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
		decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
		return Buffer.concat([
			decipher.update(data.subarray(0, data.length - TAG_BYTES)),
			decipher.final()
		]).toString('utf8');
	} catch {
		throw new ApiError(
			500,
			'Could not decrypt a stored server password. Has ENCRYPTION_KEY changed?',
			'config'
		);
	}
}
