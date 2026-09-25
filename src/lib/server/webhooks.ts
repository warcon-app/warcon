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
	deleteDiscord,
	invalidateWebhookCache,
	postDiscord,
	WEBHOOK_EVENTS,
	type PostResult,
	type WebhookEvent
} from './webhook-delivery';
import type { WebhookView } from '$lib/types';
import { isStatusStyle, type StatusStyle } from '$lib/status-styles';
import { gateway } from './gateway';
import { parseServerScope } from './server-scope';
import { servers } from './db/schema';
import { cardLinks, clampInterval, statusMessage } from './webhook-status-core';
import { effectiveFeatures } from '$lib/features';

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

/** A webhook must do something: mirror at least one event class, or keep the status message. */
function parseEvents(raw: unknown, statusEnabled: boolean): WebhookEvent[] {
	const list = Array.isArray(raw) ? raw : [];
	const events = WEBHOOK_EVENTS.filter((e) => list.includes(e));
	if (!events.length && !statusEnabled)
		throw new ApiError(
			400,
			'Pick at least one kind of event to mirror, or turn on the live status message.'
		);
	return events;
}

function parseStyle(raw: unknown): StatusStyle {
	if (!isStatusStyle(raw))
		throw new ApiError(400, 'Pick a card style: banner, compact or scoreboard.');
	return raw;
}

/** Takes the status messages out of the channel (best effort; Discord may already have lost them). */
async function removeStatusMessages(
	env: Env,
	row: Pick<WebhookRow, 'urlEnc' | 'statusMessages'>
): Promise<void> {
	const ids = Object.values((row.statusMessages as Record<string, string> | null) ?? {});
	for (const id of ids) await deleteDiscord(env, row, id);
}

const shape = (w: WebhookRow): WebhookView => ({
	id: w.id,
	label: w.label,
	urlHint: w.urlHint,
	events: (w.events as string[]) || [],
	serverIds: (w.serverIds as string[] | null) ?? null,
	enabled: w.enabled,
	statusEnabled: w.statusEnabled,
	statusStyle: w.statusStyle,
	statusIntervalS: w.statusIntervalS,
	linkStatus: w.linkStatus,
	linkLeaderboard: w.linkLeaderboard,
	linkMatches: w.linkMatches,
	linkPanel: w.linkPanel,
	statusSentAt: w.statusSentAt ? w.statusSentAt.toISOString() : null,
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
	const statusEnabled = !!body.statusEnabled;
	const statusStyle = body.statusStyle === undefined ? 'banner' : parseStyle(body.statusStyle);
	const events = parseEvents(body.events, statusEnabled);
	const serverIds = await parseServerScope(env, org.id, body.serverIds);
	const label = str(body.label, 60) || 'Discord';
	const card = {
		statusIntervalS: clampInterval(body.statusIntervalS),
		linkStatus: body.linkStatus === undefined ? true : !!body.linkStatus,
		linkLeaderboard: body.linkLeaderboard === undefined ? true : !!body.linkLeaderboard,
		linkMatches: body.linkMatches === undefined ? true : !!body.linkMatches,
		linkPanel: !!body.linkPanel
	};
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
			statusEnabled,
			statusStyle,
			...card,
			createdBy: user.id
		})
		.returning();
	invalidateWebhookCache(org.id);
	if (statusEnabled) gateway().statusChanged();
	await writeAudit(env, req, {
		actor: user,
		orgId: org.id,
		category: 'org',
		action: 'org.webhook.create',
		target: label,
		outcome: 'ok',
		detail: {
			orgId: org.id,
			webhookId: row.id,
			hint,
			events,
			serverIds,
			statusEnabled,
			statusStyle,
			...card
		}
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
	// The status messages belong to one channel and one webhook: a new URL, a pause or switching
	// them off all take the old messages down rather than leave stale ones behind.
	let dropMessage = false;
	if (typeof body.url === 'string' && body.url.trim()) {
		const { url, hint } = validateWebhookUrl(body.url);
		set.urlEnc = encryptSecret(env, url);
		set.urlHint = hint;
		set.lastError = '';
		set.lastStatus = null;
		changes.hint = hint;
		dropMessage = true;
	}
	if (body.statusEnabled !== undefined) {
		changes.statusEnabled = set.statusEnabled = !!body.statusEnabled;
		if (!set.statusEnabled) dropMessage = true;
	}
	if (body.statusStyle !== undefined)
		changes.statusStyle = set.statusStyle = parseStyle(body.statusStyle);
	if (body.statusIntervalS !== undefined)
		changes.statusIntervalS = set.statusIntervalS = clampInterval(body.statusIntervalS);
	for (const key of ['linkStatus', 'linkLeaderboard', 'linkMatches', 'linkPanel'] as const)
		if (body[key] !== undefined) changes[key] = set[key] = !!body[key];
	const statusEnabled = set.statusEnabled ?? row.statusEnabled;
	if (body.events !== undefined)
		changes.events = set.events = parseEvents(body.events, statusEnabled);
	else if (!statusEnabled && !((row.events as string[]) || []).length)
		throw new ApiError(
			400,
			'Pick at least one kind of event to mirror, or keep the live status message on.'
		);
	if (body.serverIds !== undefined)
		changes.serverIds = set.serverIds = await parseServerScope(env, org.id, body.serverIds);
	if (body.enabled !== undefined) {
		changes.enabled = set.enabled = !!body.enabled;
		if (!set.enabled) dropMessage = true;
	}
	if (!Object.keys(changes).length) throw new ApiError(400, 'Nothing to update.');
	if (dropMessage && row.statusMessages) {
		await removeStatusMessages(env, row);
		set.statusMessages = null;
		set.statusSentAt = null;
	}
	set.updatedAt = new Date();
	const [updated] = await env.db
		.update(webhooks)
		.set(set)
		.where(eq(webhooks.id, row.id))
		.returning();
	invalidateWebhookCache(org.id);
	if (updated.statusEnabled && updated.enabled) gateway().statusChanged();
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
	await removeStatusMessages(env, row);
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

/** How long a test card stays in the channel. */
const TEST_CARD_MS = 60_000;

/**
 * Posts one status card for a server this webhook covers, from the worker's latest look, and
 * takes it down again a minute later: a way to see a style before living with it.
 */
export async function sendTestCard(
	env: Env,
	req: Request,
	user: SessionUser,
	org: OrgRow,
	id: string,
	serverId: string
): Promise<PostResult> {
	const row = await webhookOf(env, org.id, id);
	if (!row.statusEnabled) throw new ApiError(400, 'This webhook does not keep status cards.');
	const only = row.serverIds as string[] | null;
	if (only && only.length && !only.includes(serverId))
		throw new ApiError(400, 'This webhook does not cover that server.');
	const [server] = await env.db
		.select()
		.from(servers)
		.where(and(eq(servers.id, serverId), eq(servers.orgId, org.id)))
		.limit(1);
	if (!server) throw new ApiError(404, 'Server not found.');
	const live = (await gateway().live(env, [server.id])).get(server.id) ?? null;
	const { payload } = statusMessage(
		{
			appName: env.APP_NAME || 'Warcon',
			orgName: org.name,
			origin: env.ORIGIN,
			now: Date.now(),
			style: row.statusStyle,
			links: cardLinks(env.ORIGIN, server.id, row, effectiveFeatures(org, server))
		},
		{ id: server.id, name: server.name },
		live
	);
	const result = await postDiscord(env, row, {
		...payload,
		content: `Test card from **${user.username}** · gone in a minute`
	});
	if (result.ok && result.messageId) {
		const messageId = result.messageId;
		setTimeout(() => void deleteDiscord(env, row, messageId), TEST_CARD_MS);
	}
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
		server,
		category: 'org',
		action: 'org.webhook.testcard',
		target: row.label,
		outcome: result.ok ? 'ok' : 'error',
		status: result.status || undefined,
		message: result.ok ? 'Test card delivered.' : result.error,
		detail: { orgId: org.id, webhookId: row.id, serverId: server.id, style: row.statusStyle }
	});
	return result;
}
