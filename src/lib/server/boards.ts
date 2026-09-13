// Discord status boards of an org: which channel (a webhook URL, a credential stored encrypted
// like an RCON password), which servers, how often. The worker keeps each board's message current
// (board-delivery.ts); this module owns the records and their validation, and takes a board's
// message down when it is paused, re-pointed or removed.
import { and, asc, eq } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, int, newId, str } from './http';
import { encryptSecret } from './crypto';
import { writeAudit } from './audit';
import type { OrgRow, SessionUser } from './access';
import { statusBoards, type StatusBoardRow } from './db/schema';
import { gateway } from './gateway';
import { validateWebhookUrl } from './webhooks';
import { callDiscord, orgServerIds } from './webhook-delivery';
import { BOARD_MAX_EMBEDS } from './board-render';
import type { StatusBoardView } from '$lib/types';

/** Discord rate limits a webhook (about thirty requests a minute), so a board edits at most every ten seconds. */
export const BOARD_INTERVAL_MIN_MS = 10_000;
export const BOARD_INTERVAL_MAX_MS = 3_600_000;
export const BOARD_INTERVAL_DEFAULT_MS = 30_000;

/** A refresh interval within bounds; absent means the fallback, out of range is refused. */
export function parseInterval(raw: unknown, fallback = BOARD_INTERVAL_DEFAULT_MS): number {
	const ms = int(raw, fallback);
	if (ms < BOARD_INTERVAL_MIN_MS || ms > BOARD_INTERVAL_MAX_MS)
		throw new ApiError(
			400,
			`intervalMs must be between ${BOARD_INTERVAL_MIN_MS} and ${BOARD_INTERVAL_MAX_MS} (ten seconds to an hour).`
		);
	return ms;
}

/** null = every server in the org; a list is checked against the org and capped at one embed each. */
async function parseServers(env: Env, orgId: string, raw: unknown): Promise<string[] | null> {
	if (raw === null || raw === undefined) return null;
	const wanted = Array.isArray(raw) ? raw.map((v) => str(v, 64)).filter(Boolean) : [];
	if (!wanted.length) return null;
	const known = await orgServerIds(env, orgId, [...new Set(wanted)]);
	if (known.length > BOARD_MAX_EMBEDS)
		throw new ApiError(
			400,
			`Pick at most ${BOARD_MAX_EMBEDS} servers: Discord shows ten embeds in one message.`
		);
	return known.length ? known : null;
}

const shape = (b: StatusBoardRow): StatusBoardView => ({
	id: b.id,
	label: b.label,
	urlHint: b.urlHint,
	heading: b.heading,
	serverIds: (b.serverIds as string[] | null) ?? null,
	intervalMs: b.intervalMs,
	showPlayers: b.showPlayers,
	enabled: b.enabled,
	posted: !!b.messageId,
	lastSentAt: b.lastSentAt ? b.lastSentAt.toISOString() : null,
	lastStatus: b.lastStatus,
	lastError: b.lastError,
	createdAt: b.createdAt ? b.createdAt.toISOString() : null
});

export async function listBoards(env: Env, orgId: string): Promise<StatusBoardView[]> {
	const rows = await env.db
		.select()
		.from(statusBoards)
		.where(eq(statusBoards.orgId, orgId))
		.orderBy(asc(statusBoards.createdAt));
	return rows.map(shape);
}

async function boardOf(env: Env, orgId: string, id: string): Promise<StatusBoardRow> {
	const [row] = await env.db
		.select()
		.from(statusBoards)
		.where(and(eq(statusBoards.id, id), eq(statusBoards.orgId, orgId)))
		.limit(1);
	if (!row) throw new ApiError(404, 'Status board not found.');
	return row;
}

export async function createBoard(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<StatusBoardView> {
	const { url, hint } = validateWebhookUrl(body.url);
	const serverIds = await parseServers(env, org.id, body.serverIds);
	const intervalMs = parseInterval(body.intervalMs);
	const label = str(body.label, 60) || 'Status board';
	const heading = str(body.heading, 200);
	const [row] = await env.db
		.insert(statusBoards)
		.values({
			id: newId(),
			orgId: org.id,
			label,
			urlEnc: encryptSecret(env, url),
			urlHint: hint,
			heading,
			serverIds,
			intervalMs,
			showPlayers: body.showPlayers === undefined ? true : !!body.showPlayers,
			enabled: body.enabled === undefined ? true : !!body.enabled,
			createdBy: user.id
		})
		.returning();
	gateway().boardsChanged();
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.board.create',
		target: label,
		outcome: 'ok',
		detail: { orgId: org.id, boardId: row.id, hint, serverIds, intervalMs }
	});
	return shape(row);
}

export async function updateBoard(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	id: string,
	body: Record<string, unknown>
): Promise<StatusBoardView> {
	const row = await boardOf(env, org.id, id);
	const set: Partial<typeof statusBoards.$inferInsert> = {};
	const changes: Record<string, unknown> = {};
	/** the message to take down, through the webhook that posted it */
	let takeDown: { urlEnc: string; messageId: string } | null = null;
	if (body.label !== undefined) changes.label = set.label = str(body.label, 60) || row.label;
	if (typeof body.url === 'string' && body.url.trim()) {
		const { url, hint } = validateWebhookUrl(body.url);
		set.urlEnc = encryptSecret(env, url);
		set.urlHint = hint;
		set.lastError = '';
		set.lastStatus = null;
		changes.hint = hint;
		// Another channel: the old message belongs to the old webhook and cannot follow.
		if (row.messageId) takeDown = { urlEnc: row.urlEnc, messageId: row.messageId };
		set.messageId = null;
	}
	if (body.heading !== undefined) changes.heading = set.heading = str(body.heading, 200);
	if (body.serverIds !== undefined)
		changes.serverIds = set.serverIds = await parseServers(env, org.id, body.serverIds);
	if (body.intervalMs !== undefined)
		changes.intervalMs = set.intervalMs = parseInterval(body.intervalMs, row.intervalMs);
	if (body.showPlayers !== undefined) changes.showPlayers = set.showPlayers = !!body.showPlayers;
	if (body.enabled !== undefined) {
		changes.enabled = set.enabled = !!body.enabled;
		// Pausing takes the message down; enabling again posts a fresh one.
		if (!set.enabled && row.messageId) {
			takeDown ??= { urlEnc: row.urlEnc, messageId: row.messageId };
			set.messageId = null;
		}
	}
	if (!Object.keys(changes).length) throw new ApiError(400, 'Nothing to update.');
	set.updatedAt = new Date();
	const [updated] = await env.db
		.update(statusBoards)
		.set(set)
		.where(eq(statusBoards.id, row.id))
		.returning();
	gateway().boardsChanged();
	if (takeDown)
		void callDiscord(env, takeDown, { method: 'DELETE', messageId: takeDown.messageId });
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.board.update',
		target: updated.label,
		outcome: 'ok',
		detail: { orgId: org.id, boardId: row.id, ...changes }
	});
	return shape(updated);
}

export async function deleteBoard(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	id: string
): Promise<void> {
	const row = await boardOf(env, org.id, id);
	await env.db.delete(statusBoards).where(eq(statusBoards.id, row.id));
	gateway().boardsChanged();
	// Best effort: the row is gone either way, and the worker never posts for a board it cannot find.
	if (row.messageId) void callDiscord(env, row, { method: 'DELETE', messageId: row.messageId });
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.board.delete',
		target: row.label,
		outcome: 'ok',
		detail: { orgId: org.id, boardId: row.id, hint: row.urlHint }
	});
}
