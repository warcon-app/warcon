// The pure part of API keys: token format, hashing, expiry, and what a key may do on a server.
// No db, no SvelteKit, so it is unit tested with plain objects and shared by the hook (which
// resolves bearers) and access.ts (which answers "may this key do X here?").
import { createHash, randomBytes } from 'node:crypto';
import { knownCapabilities, type Capability } from '../capabilities';

export const TOKEN_PREFIX = 'wck_';
/** 32 random bytes, base64url: 43 characters after the prefix. */
const TOKEN_RE = /^wck_[A-Za-z0-9_-]{43}$/;

export const mintToken = (): string => TOKEN_PREFIX + randomBytes(32).toString('base64url');

/** Only the hash is stored; a database leak yields nothing usable. */
export const hashToken = (token: string): string =>
	createHash('sha256').update(token, 'utf8').digest('hex');

/** The prefix plus the first eight random characters: enough to tell keys apart, useless to guess. */
export const tokenHint = (token: string): string => token.slice(0, TOKEN_PREFIX.length + 8) + '…';

/** The bearer token in an Authorization header, if it is shaped like one of ours; else null. */
export function parseBearer(header: string | null | undefined): string | null {
	if (!header) return null;
	const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
	if (!m) return null;
	return TOKEN_RE.test(m[1]) ? m[1] : null;
}

export const looksLikeOurToken = (header: string | null | undefined): boolean =>
	!!header && /^Bearer\s+wck_/i.test(header);

/** What a resolved key carries through a request (kept on the synthetic session user). */
export interface ApiKeyPrincipal {
	id: string;
	orgId: string;
	label: string;
	capabilities: Capability[];
	/** null = every server in the org */
	serverIds: string[] | null;
}

export interface KeyLike {
	id: string;
	orgId: string;
	label: string;
	capabilities: unknown;
	serverIds: unknown;
	expiresAt: Date | null;
	revokedAt: Date | null;
}

export type KeyProblem = 'revoked' | 'expired';

export function keyProblem(
	key: Pick<KeyLike, 'expiresAt' | 'revokedAt'>,
	now = new Date()
): KeyProblem | null {
	if (key.revokedAt) return 'revoked';
	if (key.expiresAt && key.expiresAt <= now) return 'expired';
	return null;
}

export const principalOf = (key: KeyLike): ApiKeyPrincipal => ({
	id: key.id,
	orgId: key.orgId,
	label: key.label,
	capabilities: knownCapabilities(key.capabilities),
	serverIds: Array.isArray(key.serverIds)
		? key.serverIds.filter((v): v is string => typeof v === 'string')
		: null
});

/** May this key act on a server at all? Same org, and on the allowlist when there is one. */
export const keyCoversServer = (
	key: Pick<ApiKeyPrincipal, 'orgId' | 'serverIds'>,
	server: { id: string; orgId: string }
): boolean =>
	server.orgId === key.orgId && (key.serverIds === null || key.serverIds.includes(server.id));

/** The actor id keys write into audit rows and author columns: never collides with a user id. */
export const keyActorId = (keyId: string): string => `key:${keyId}`;
export const keyActorName = (label: string): string => `${label} (API key)`;
