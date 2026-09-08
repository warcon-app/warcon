import { and, desc, eq, gte, inArray, like, lt, lte, or, type SQL } from 'drizzle-orm';
import type { Env } from './env';
import { clientIp, userAgent, int, str } from './http';
import { auditLog, user, type AuditRow } from './db/schema';

export type { AuditRow };
export type Outcome = 'ok' | 'error' | 'denied';

export interface AuditEvent {
	actor?: { id: string; username: string } | null;
	server?: { id: string; name: string } | null;
	category: 'auth' | 'user' | 'server' | 'rcon' | 'system';
	action: string;
	target?: string;
	detail?: unknown;
	outcome: Outcome;
	status?: number;
	message?: string;
	durationMs?: number;
	ip?: string;
	userAgent?: string;
}

const SECRET_KEYS = /pass|secret|token|key|authorization|cookie/i;

/** Strips anything that looks like a credential before it is persisted. */
export function redact(value: unknown, depth = 0): unknown {
	if (depth > 6) return '[deep]';
	if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			out[k] = SECRET_KEYS.test(k) ? (v ? '[redacted]' : v) : redact(v, depth + 1);
		}
		return out;
	}
	if (typeof value === 'string' && value.length > 4000)
		return value.slice(0, 4000) + `…[${value.length - 4000} more chars]`;
	return value;
}

export async function writeAudit(env: Env, req: Request | null, ev: AuditEvent): Promise<void> {
	// Session-create hooks only know the user id; fill the name from the user table.
	let actorName = ev.actor?.username ?? '';
	if (ev.actor?.id && !actorName) {
		const [row] = await env.db
			.select({ username: user.username, name: user.name })
			.from(user)
			.where(eq(user.id, ev.actor.id))
			.limit(1);
		actorName = row?.username || row?.name || '';
	}
	await env.db.insert(auditLog).values({
		ts: new Date(),
		actorId: ev.actor?.id ?? null,
		actorName,
		serverId: ev.server?.id ?? null,
		serverName: ev.server?.name ?? '',
		category: ev.category,
		action: ev.action,
		target: str(ev.target, 300),
		detail: ev.detail === undefined || ev.detail === null ? null : redact(ev.detail),
		outcome: ev.outcome,
		status: ev.status ?? null,
		message: str(ev.message, 1000),
		ip: ev.ip ?? (req ? clientIp(req) : ''),
		userAgent: ev.userAgent ?? (req ? userAgent(req) : ''),
		durationMs: ev.durationMs ?? null
	});
}

export interface AuditQuery {
	serverId?: string;
	actorId?: string;
	category?: string;
	action?: string;
	outcome?: string;
	q?: string;
	from?: string;
	to?: string;
	before?: number;
	limit?: number;
	/** Non-owners: their own rows, or rows on servers they admin. */
	visibleTo?: { userId: string; adminServerIds: string[] } | null;
}

const parseDate = (v: string | undefined): Date | null => {
	if (!v) return null;
	const d = new Date(v);
	return Number.isNaN(d.getTime()) ? null : d;
};

export async function queryAudit(
	env: Env,
	q: AuditQuery
): Promise<{ entries: AuditRow[]; nextBefore: number | null }> {
	const where: SQL[] = [];
	if (q.serverId) where.push(eq(auditLog.serverId, q.serverId));
	if (q.actorId) where.push(eq(auditLog.actorId, q.actorId));
	if (q.category) where.push(eq(auditLog.category, q.category));
	if (q.action) where.push(eq(auditLog.action, q.action));
	if (q.outcome === 'ok' || q.outcome === 'error' || q.outcome === 'denied')
		where.push(eq(auditLog.outcome, q.outcome));
	const from = parseDate(q.from);
	const to = parseDate(q.to);
	if (from) where.push(gte(auditLog.ts, from));
	if (to) where.push(lte(auditLog.ts, to));
	if (q.before) where.push(lt(auditLog.id, q.before));
	if (q.q) {
		const pattern = `%${q.q}%`;
		where.push(
			or(
				like(auditLog.actorName, pattern),
				like(auditLog.serverName, pattern),
				like(auditLog.action, pattern),
				like(auditLog.target, pattern),
				like(auditLog.message, pattern),
				like(auditLog.ip, pattern)
			)!
		);
	}
	if (q.visibleTo) {
		const ids = q.visibleTo.adminServerIds;
		where.push(
			ids.length
				? or(eq(auditLog.actorId, q.visibleTo.userId), inArray(auditLog.serverId, ids))!
				: eq(auditLog.actorId, q.visibleTo.userId)
		);
	}
	const limit = int(q.limit, 100, 1, 500);
	const found = await env.db
		.select()
		.from(auditLog)
		.where(where.length ? and(...where) : undefined)
		.orderBy(desc(auditLog.id))
		.limit(limit + 1);
	const entries = found.slice(0, limit);
	const nextBefore = found.length > limit ? entries[entries.length - 1].id : null;
	return { entries, nextBefore };
}

export function auditFilters(params: URLSearchParams) {
	return {
		serverId: str(params.get('server'), 64) || undefined,
		actorId: str(params.get('actor'), 64) || undefined,
		category: str(params.get('category'), 32) || undefined,
		action: str(params.get('action'), 64) || undefined,
		outcome: str(params.get('outcome'), 16) || undefined,
		q: str(params.get('q'), 200) || undefined,
		from: str(params.get('from'), 40) || undefined,
		to: str(params.get('to'), 40) || undefined,
		before: int(params.get('before'), 0, 0) || undefined,
		limit: int(params.get('limit'), 100, 1, 500)
	};
}

/** Distinct actions and actors for filter dropdowns. */
export async function auditMeta(env: Env) {
	const actions = await env.db
		.selectDistinct({ category: auditLog.category, action: auditLog.action })
		.from(auditLog)
		.orderBy(auditLog.category, auditLog.action);
	const actors = await env.db
		.selectDistinct({ actorId: auditLog.actorId, actorName: auditLog.actorName })
		.from(auditLog)
		.where(eq(auditLog.actorId, auditLog.actorId))
		.orderBy(auditLog.actorName);
	return {
		actions,
		actors: actors.filter((a): a is { actorId: string; actorName: string } => !!a.actorId)
	};
}
