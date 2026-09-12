// Organisation API keys: the records, their creation and revocation, and turning a bearer token
// into a principal for the hook. Format, hashing and scope rules live in apikeys-core.ts.
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, int, newId, str } from './http';
import { writeAudit } from './audit';
import type { OrgRow, SessionUser } from './access';
import { apiKeys, organizations, servers, user, type ApiKeyRow } from './db/schema';
import { parseCapabilities } from '../capabilities';
import {
	hashToken,
	keyProblem,
	mintToken,
	principalOf,
	tokenHint,
	type ApiKeyPrincipal
} from './apikeys-core';
import type { ApiKeyView } from '$lib/types';

const LABEL_MAX = 60;
/** last_used_at is bumped at most this often per key: bots poll, the column is for people. */
const TOUCH_MS = 60_000;
const iso = (v: Date | null | undefined): string | null => (v ? v.toISOString() : null);

const shape = (
	k: ApiKeyRow,
	creator: { username: string | null; name: string } | null
): ApiKeyView => ({
	id: k.id,
	label: k.label,
	hint: k.hint,
	capabilities: principalOf(k).capabilities,
	serverIds: principalOf(k).serverIds,
	createdBy: creator ? { username: creator.username ?? '', name: creator.name } : null,
	createdAt: iso(k.createdAt),
	lastUsedAt: iso(k.lastUsedAt),
	expiresAt: iso(k.expiresAt),
	revokedAt: iso(k.revokedAt)
});

export async function listKeys(env: Env, orgId: string): Promise<ApiKeyView[]> {
	const rows = await env.db
		.select({ k: apiKeys, creator: { username: user.username, name: user.name } })
		.from(apiKeys)
		.leftJoin(user, eq(user.id, apiKeys.createdBy))
		.where(eq(apiKeys.orgId, orgId))
		.orderBy(asc(apiKeys.createdAt));
	return rows.map((r) => shape(r.k, r.creator?.name !== undefined ? r.creator : null));
}

/** null = every server; otherwise only ids that are this org's servers (unknown ones dropped). */
async function parseServers(env: Env, orgId: string, raw: unknown): Promise<string[] | null> {
	if (raw === null || raw === undefined) return null;
	const wanted = Array.isArray(raw) ? raw.map((v) => str(v, 64)).filter(Boolean) : [];
	if (!wanted.length) return null;
	const known = await env.db
		.select({ id: servers.id })
		.from(servers)
		.where(and(eq(servers.orgId, orgId), inArray(servers.id, wanted)));
	if (!known.length) throw new ApiError(400, 'None of those servers belong to this organisation.');
	return known.map((s) => s.id);
}

/** Mints a key; the plaintext token is returned here and never again. */
export async function createKey(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<{ key: ApiKeyView; token: string }> {
	const label = str(body.label, LABEL_MAX).trim();
	if (label.length < 2) throw new ApiError(400, 'Give the key a label of at least 2 characters.');
	let capabilities;
	try {
		capabilities = parseCapabilities(body.capabilities ?? []);
	} catch (err) {
		throw new ApiError(400, err instanceof Error ? err.message : 'Bad capabilities.');
	}
	if (!capabilities.length) throw new ApiError(400, 'Pick at least one capability for the key.');
	const serverIds = await parseServers(env, org.id, body.serverIds);
	const days = int(body.expiresDays, 0, 0, 3650);
	const expiresAt = days ? new Date(Date.now() + days * 86400_000) : null;
	const token = mintToken();
	const [row] = await env.db
		.insert(apiKeys)
		.values({
			id: newId(),
			orgId: org.id,
			label,
			keyHash: hashToken(token),
			hint: tokenHint(token),
			capabilities,
			serverIds,
			createdBy: actor.id,
			expiresAt
		})
		.returning();
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.apikey.create',
		outcome: 'ok',
		target: label,
		detail: {
			orgId: org.id,
			keyId: row.id,
			hint: row.hint,
			capabilities,
			serverIds,
			expiresAt: iso(expiresAt)
		}
	});
	return { key: shape(row, { username: actor.username, name: actor.name }), token };
}

/** Ends a key at once; the row stays so the audit trail keeps its label and hint. */
export async function revokeKey(
	env: Env,
	req: Request,
	actor: SessionUser,
	org: OrgRow,
	keyId: string
): Promise<void> {
	const [row] = await env.db
		.update(apiKeys)
		.set({ revokedAt: new Date() })
		.where(and(eq(apiKeys.id, keyId), eq(apiKeys.orgId, org.id), isNull(apiKeys.revokedAt)))
		.returning({ id: apiKeys.id, label: apiKeys.label, hint: apiKeys.hint });
	if (!row) throw new ApiError(404, 'API key not found.', 'not_found');
	await writeAudit(env, req, {
		actor,
		orgId: org.id,
		category: 'org',
		action: 'org.apikey.revoke',
		outcome: 'ok',
		target: row.label,
		detail: { orgId: org.id, keyId: row.id, hint: row.hint }
	});
}

const touched = new Map<string, number>();

/**
 * The principal behind a bearer token. Throws 401 for an unknown, revoked or expired key and 403
 * when its organisation is suspended, so the hook can answer without touching the session.
 */
export async function resolveBearer(env: Env, token: string): Promise<ApiKeyPrincipal> {
	const [row] = await env.db
		.select({ k: apiKeys, suspendedAt: organizations.suspendedAt, orgName: organizations.name })
		.from(apiKeys)
		.innerJoin(organizations, eq(organizations.id, apiKeys.orgId))
		.where(eq(apiKeys.keyHash, hashToken(token)))
		.limit(1);
	if (!row) throw new ApiError(401, 'Unknown API key.', 'invalid_api_key');
	const problem = keyProblem(row.k);
	if (problem) throw new ApiError(401, `This API key has been ${problem}.`, `api_key_${problem}`);
	if (row.suspendedAt)
		throw new ApiError(403, `${row.orgName} is suspended. Contact the site owner.`, 'suspended');
	const now = Date.now();
	if ((touched.get(row.k.id) ?? 0) <= now - TOUCH_MS) {
		touched.set(row.k.id, now);
		void env.db
			.update(apiKeys)
			.set({ lastUsedAt: new Date(now) })
			.where(eq(apiKeys.id, row.k.id))
			.catch(() => {});
	}
	return principalOf(row.k);
}
