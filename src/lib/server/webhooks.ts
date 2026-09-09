// Discord webhook records for an org: which event classes to mirror, to which channel, for which
// servers. The URL is a credential (anyone holding it can post to the channel) and is stored
// encrypted like an RCON password; the UI only ever sees a hint. Delivery lives in webhook-delivery.ts.
import { and, asc, eq } from 'drizzle-orm';
import type { Env } from './env';
import { ApiError, newId, str } from './http';
import { encryptSecret } from './crypto';
import { writeAudit } from './audit';
import type { OrgRow, SessionUser } from './access';
import { webhooks, type WebhookRow } from './db/schema';
import {
	invalidateWebhookCache,
	orgServerIds,
	postDiscord,
	WEBHOOK_EVENTS,
	type PostResult,
	type WebhookEvent
} from './webhook-delivery';
import type { WebhookView } from '$lib/types';

export { WEBHOOK_EVENTS, WEBHOOK_EVENT_LABELS } from './webhook-delivery';

const DISCORD_HOSTS = new Set([
	'discord.com',
	'discordapp.com',
	'ptb.discord.com',
	'canary.discord.com'
]);
const PATH = /^\/api\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{30,200})$/;

/** Accepts only a Discord webhook URL (https, a Discord host, /api/webhooks/<id>/<token>). */
export function validateWebhookUrl(raw: unknown): { url: string; hint: string } {
	const text = str(raw, 400);
	let u: URL;
	try {
		u = new URL(text);
	} catch {
		throw new ApiError(400, 'That is not a URL.');
	}
	const m = PATH.exec(u.pathname);
	if (u.protocol !== 'https:' || !DISCORD_HOSTS.has(u.hostname.toLowerCase()) || !m)
		throw new ApiError(
			400,
			'Paste a Discord webhook URL: https://discord.com/api/webhooks/<id>/<token> (Channel settings → Integrations → Webhooks).'
		);
	return {
		url: `https://${u.hostname.toLowerCase()}/api/webhooks/${m[1]}/${m[2]}`,
		hint: `${u.hostname.toLowerCase()}/api/webhooks/${m[1]}/…`
	};
}

function parseEvents(raw: unknown): WebhookEvent[] {
	const list = Array.isArray(raw) ? raw : [];
	const events = WEBHOOK_EVENTS.filter((e) => list.includes(e));
	if (!events.length) throw new ApiError(400, 'Pick at least one kind of event to mirror.');
	return events;
}

async function parseServers(env: Env, orgId: string, raw: unknown): Promise<string[] | null> {
	if (raw === null || raw === undefined) return null;
	const wanted = Array.isArray(raw) ? raw.map((v) => str(v, 64)).filter(Boolean) : [];
	if (!wanted.length) return null;
	const known = await orgServerIds(env, orgId, wanted);
	return known.length ? known : null;
}

const shape = (w: WebhookRow): WebhookView => ({
	id: w.id,
	label: w.label,
	urlHint: w.urlHint,
	events: (w.events as string[]) || [],
	serverIds: (w.serverIds as string[] | null) ?? null,
	enabled: w.enabled,
	lastSentAt: w.lastSentAt ? w.lastSentAt.toISOString() : null,
	lastStatus: w.lastStatus,
	lastError: w.lastError,
	createdAt: w.createdAt ? w.createdAt.toISOString() : null
});

export async function listWebhooks(env: Env, orgId: string): Promise<WebhookView[]> {
	const rows = await env.db
		.select()
		.from(webhooks)
		.where(eq(webhooks.orgId, orgId))
		.orderBy(asc(webhooks.createdAt));
	return rows.map(shape);
}

async function webhookOf(env: Env, orgId: string, id: string): Promise<WebhookRow> {
	const [row] = await env.db
		.select()
		.from(webhooks)
		.where(and(eq(webhooks.id, id), eq(webhooks.orgId, orgId)))
		.limit(1);
	if (!row) throw new ApiError(404, 'Webhook not found.');
	return row;
}

export async function createWebhook(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	body: Record<string, unknown>
): Promise<WebhookView> {
	const { url, hint } = validateWebhookUrl(body.url);
	const events = parseEvents(body.events);
	const serverIds = await parseServers(env, org.id, body.serverIds);
	const label = str(body.label, 60) || 'Discord';
	const [row] = await env.db
		.insert(webhooks)
		.values({
			id: newId(),
			orgId: org.id,
			label,
			urlEnc: encryptSecret(env, url),
			urlHint: hint,
			events,
			serverIds,
			enabled: body.enabled === undefined ? true : !!body.enabled,
			createdBy: user.id
		})
		.returning();
	invalidateWebhookCache(org.id);
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.webhook.create',
		target: label,
		outcome: 'ok',
		detail: { orgId: org.id, webhookId: row.id, hint, events, serverIds }
	});
	return shape(row);
}

export async function updateWebhook(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	id: string,
	body: Record<string, unknown>
): Promise<WebhookView> {
	const row = await webhookOf(env, org.id, id);
	const set: Partial<typeof webhooks.$inferInsert> = {};
	const changes: Record<string, unknown> = {};
	if (body.label !== undefined) changes.label = set.label = str(body.label, 60) || row.label;
	if (typeof body.url === 'string' && body.url.trim()) {
		const { url, hint } = validateWebhookUrl(body.url);
		set.urlEnc = encryptSecret(env, url);
		set.urlHint = hint;
		set.lastError = '';
		set.lastStatus = null;
		changes.hint = hint;
	}
	if (body.events !== undefined) changes.events = set.events = parseEvents(body.events);
	if (body.serverIds !== undefined)
		changes.serverIds = set.serverIds = await parseServers(env, org.id, body.serverIds);
	if (body.enabled !== undefined) changes.enabled = set.enabled = !!body.enabled;
	if (!Object.keys(changes).length) throw new ApiError(400, 'Nothing to update.');
	set.updatedAt = new Date();
	const [updated] = await env.db
		.update(webhooks)
		.set(set)
		.where(eq(webhooks.id, row.id))
		.returning();
	invalidateWebhookCache(org.id);
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.webhook.update',
		target: updated.label,
		outcome: 'ok',
		detail: { orgId: org.id, webhookId: row.id, ...changes }
	});
	return shape(updated);
}

export async function deleteWebhook(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	id: string
): Promise<void> {
	const row = await webhookOf(env, org.id, id);
	await env.db.delete(webhooks).where(eq(webhooks.id, row.id));
	invalidateWebhookCache(org.id);
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.webhook.delete',
		target: row.label,
		outcome: 'ok',
		detail: { orgId: org.id, webhookId: row.id, hint: row.urlHint }
	});
}

/** Posts a test message right away and records the outcome on the row. */
export async function testWebhook(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	id: string
): Promise<PostResult> {
	const row = await webhookOf(env, org.id, id);
	const result = await postDiscord(env, row, {
		embeds: [
			{
				title: 'Webhook test',
				description: `**${user.username}** connected ${org.name} to this channel. Events: ${(row.events as string[]).join(', ')}.`,
				color: 0xd4a843,
				timestamp: new Date().toISOString(),
				footer: { text: env.APP_NAME || 'Warcon' }
			}
		]
	});
	await env.db
		.update(webhooks)
		.set({
			lastSentAt: result.ok ? new Date() : undefined,
			lastStatus: result.status,
			lastError: result.ok ? '' : result.error.slice(0, 300)
		})
		.where(eq(webhooks.id, row.id));
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.webhook.test',
		target: row.label,
		outcome: result.ok ? 'ok' : 'error',
		status: result.status || undefined,
		message: result.ok ? 'Test message delivered.' : result.error,
		detail: { orgId: org.id, webhookId: row.id }
	});
	return result;
}
