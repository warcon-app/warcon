import type { Env } from './env';
import { ApiError } from './http';

const te = new TextEncoder();
const td = new TextDecoder();

export function b64(bytes: Uint8Array): string {
	let s = '';
	for (const b of bytes) {
		s += String.fromCharCode(b);
	}
	return btoa(s);
}

export function unb64(text: string): Uint8Array<ArrayBuffer> {
	const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) {
		out[i] = bin.charCodeAt(i);
	}
	return out;
}

export const b64url = (bytes: Uint8Array): string =>
	b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function randomToken(bytes = 32): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return b64url(buf);
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', te.encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Workers cap PBKDF2 at 100k iterations; that is what we use.
const PBKDF2_ITERATIONS = 100000;

async function pbkdf2(
	password: string,
	salt: Uint8Array<ArrayBuffer>,
	iterations: number
): Promise<Uint8Array> {
	const key = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, [
		'deriveBits'
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
		key,
		256
	);
	return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
	const salt = new Uint8Array(16);
	crypto.getRandomValues(salt);
	const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
	return `pbkdf2$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const [algo, iterText, saltB64, hashB64] = stored.split('$');
	if (algo !== 'pbkdf2') {
		return false;
	}
	const expected = unb64(hashB64);
	const actual = await pbkdf2(password, unb64(saltB64), Number(iterText));
	return ctEqual(expected, actual);
}

/** Constant-time byte comparison (workerd has crypto.subtle.timingSafeEqual, Node's WebCrypto does not). */
export function ctEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a[i] ^ b[i];
	}
	return diff === 0;
}

let aesKeyCache: { raw: string; key: CryptoKey } | null = null;

async function aesKey(env: Env): Promise<CryptoKey> {
	const raw = env.ENCRYPTION_KEY || '';
	if (aesKeyCache && aesKeyCache.raw === raw) {
		return aesKeyCache.key;
	}
	let bytes: Uint8Array<ArrayBuffer>;
	try {
		bytes = unb64(raw);
	} catch {
		bytes = new Uint8Array(0);
	}
	if (bytes.length !== 32) {
		throw new ApiError(
			500,
			'ENCRYPTION_KEY secret is missing or is not base64 of 32 bytes. Run: wrangler secret put ENCRYPTION_KEY',
			'config'
		);
	}
	const key = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, [
		'encrypt',
		'decrypt'
	]);
	aesKeyCache = { raw, key };
	return key;
}

export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
	const key = await aesKey(env);
	const iv = new Uint8Array(12);
	crypto.getRandomValues(iv);
	const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plaintext));
	return `v1.${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

export async function decryptSecret(env: Env, blob: string): Promise<string> {
	const [version, ivB64, ctB64] = blob.split('.');
	if (version !== 'v1') {
		throw new ApiError(500, 'Unknown secret format.', 'config');
	}
	const key = await aesKey(env);
	try {
		const pt = await crypto.subtle.decrypt(
			{ name: 'AES-GCM', iv: unb64(ivB64) },
			key,
			unb64(ctB64)
		);
		return td.decode(pt);
	} catch {
		throw new ApiError(
			500,
			'Could not decrypt a stored server password. Has ENCRYPTION_KEY changed?',
			'config'
		);
	}
}

export function timingSafeEqualStr(a: string, b: string): boolean {
	return ctEqual(te.encode(a), te.encode(b));
}
