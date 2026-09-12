import { describe, expect, test } from 'bun:test';
import {
	hashToken,
	keyCoversServer,
	keyProblem,
	mintToken,
	parseBearer,
	principalOf,
	tokenHint
} from './apikeys-core';

describe('tokens', () => {
	test('mint produces a wck_ token that parses back from a bearer header', () => {
		const t = mintToken();
		expect(t.startsWith('wck_')).toBe(true);
		expect(t.length).toBe(4 + 43);
		expect(parseBearer(`Bearer ${t}`)).toBe(t);
		expect(parseBearer(`bearer  ${t} `)).toBe(t);
		expect(mintToken()).not.toBe(t);
	});

	test('rejects headers that are not one of ours', () => {
		expect(parseBearer(null)).toBeNull();
		expect(parseBearer('Bearer nope')).toBeNull();
		expect(parseBearer('Basic d2Fy')).toBeNull();
		expect(parseBearer('Bearer wck_short')).toBeNull();
	});

	test('hash is stable and the hint never reveals more than eight random characters', () => {
		const t = mintToken();
		expect(hashToken(t)).toBe(hashToken(t));
		expect(hashToken(t)).toHaveLength(64);
		expect(hashToken(t)).not.toBe(hashToken(mintToken()));
		expect(tokenHint(t)).toBe(t.slice(0, 12) + '…');
	});
});

describe('keys', () => {
	const now = new Date('2026-09-12T12:00:00Z');
	test('revoked beats expired; a future expiry is fine', () => {
		expect(keyProblem({ expiresAt: null, revokedAt: null }, now)).toBeNull();
		expect(keyProblem({ expiresAt: new Date('2026-09-13'), revokedAt: null }, now)).toBeNull();
		expect(keyProblem({ expiresAt: new Date('2026-09-11'), revokedAt: null }, now)).toBe('expired');
		expect(keyProblem({ expiresAt: new Date('2026-09-11'), revokedAt: now }, now)).toBe('revoked');
	});

	test('principal keeps known capabilities and string server ids only', () => {
		const p = principalOf({
			id: 'k1',
			orgId: 'o1',
			label: 'bot',
			capabilities: ['lists.edit', 'bogus'],
			serverIds: ['s1', 3],
			expiresAt: null,
			revokedAt: null
		});
		expect(p.capabilities).toEqual(['lists.edit']);
		expect(p.serverIds).toEqual(['s1']);
		expect(
			principalOf({ ...p, capabilities: [], serverIds: null, expiresAt: null, revokedAt: null })
				.serverIds
		).toBeNull();
	});

	test('a key covers its org servers, narrowed by the allowlist, never another org', () => {
		const all = { orgId: 'o1', serverIds: null };
		const some = { orgId: 'o1', serverIds: ['s1'] };
		expect(keyCoversServer(all, { id: 's9', orgId: 'o1' })).toBe(true);
		expect(keyCoversServer(all, { id: 's9', orgId: 'o2' })).toBe(false);
		expect(keyCoversServer(some, { id: 's1', orgId: 'o1' })).toBe(true);
		expect(keyCoversServer(some, { id: 's2', orgId: 'o1' })).toBe(false);
	});
});
