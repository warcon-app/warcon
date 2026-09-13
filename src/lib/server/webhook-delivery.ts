// Mirrors audit rows to Discord webhooks. Called by writeAudit after every insert; delivery is
// asynchronous and batched per webhook (Discord accepts up to 10 embeds per message and rate
// limits each webhook), so a burst of kicks becomes one message rather than a flood of 429s.
// Only this module talks to Discord; webhooks.ts owns the records and their validation.
import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from './env';
import { decryptSecret } from './crypto';
import { servers, webhooks, type AuditRow, type WebhookRow } from './db/schema';

export const WEBHOOK_EVENTS = [
	'bans',
	'commands',
	'triggers',
	'players',
	'management',
	'auth'
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
	bans: 'Bans and unbans',
	commands: 'Other game commands (kick, broadcast, map, config…)',
	triggers: 'Automation (trigger actions)',
	players: 'Player notes and watchlist changes',
	management: 'Servers, members, invite links, accounts',
	auth: 'Sign-ins and sign-in failures'
};

/** Which event class an audit row belongs to. */
export function classify(row: Pick<AuditRow, 'category' | 'action'>): WebhookEvent | null {
	switch (row.category) {
		case 'rcon':
			return row.action === 'rcon.ban' || row.action === 'rcon.unban' ? 'bans' : 'commands';
		case 'trigger':
			return 'triggers';
		case 'player':
			return 'players';
		case 'org':
		case 'system':
			// org ban / reserved list changes and their sync belong with bans
			return row.action.startsWith('list') ? 'bans' : 'management';
		case 'server':
		case 'user':
			return 'management';
		case 'auth':
			return 'auth';
		default:
			return null;
	}
}

// ---- lookup caches (short-lived; CRUD invalidates) ---------------------------------------------

const ORG_TTL_MS = 30_000;
const orgWebhooks = new Map<string, { until: number; rows: WebhookRow[] }>();
const serverOrg = new Map<string, { until: number; orgId: string | null }>();

export function invalidateWebhookCache(orgId?: string): void {
	if (orgId) orgWebhooks.delete(orgId);
	else orgWebhooks.clear();
}

async function enabledWebhooks(env: Env, orgId: string): Promise<WebhookRow[]> {
	const hit = orgWebhooks.get(orgId);
	if (hit && hit.until > Date.now()) return hit.rows;
	const rows = await env.db
		.select()
		.from(webhooks)
		.where(and(eq(webhooks.orgId, orgId), eq(webhooks.enabled, true)));
	orgWebhooks.set(orgId, { until: Date.now() + ORG_TTL_MS, rows });
	return rows;
}

async function orgOfServer(env: Env, serverId: string): Promise<string | null> {
	const hit = serverOrg.get(serverId);
	if (hit && hit.until > Date.now()) return hit.orgId;
	const [row] = await env.db
		.select({ orgId: servers.orgId })
		.from(servers)
		.where(eq(servers.id, serverId))
		.limit(1);
	const orgId = row?.orgId ?? null;
	serverOrg.set(serverId, { until: Date.now() + ORG_TTL_MS, orgId });
	return orgId;
}

// ---- embeds -------------------------------------------------------------------------------------

export interface Embed {
	title: string;
	description: string;
	color: number;
	timestamp: string;
	footer?: { text: string };
	/** up to 25; a name of at most 256 characters and a value of at most 1024 */
	fields?: { name: string; value: string; inline?: boolean }[];
}

export const COLORS = { ok: 0x7bc462, error: 0xd86060, denied: 0x8a8a90 } as const;

const ACTION_TITLES: Record<string, string> = {
	'rcon.kick': 'Kick',
	'rcon.ban': 'Ban',
	'rcon.unban': 'Unban',
	'rcon.kill': 'Kill',
	'rcon.whisper': 'Whisper',
	'rcon.broadcast': 'Broadcast',
	'rcon.changeTeam': 'Change team',
	'rcon.changeMap': 'Change map',
	'rcon.setNextMap': 'Set next map',
	'rcon.endMatch': 'End match',
	'rcon.restartMatch': 'Restart match',
	'rcon.setWeather': 'Set weather',
	'rcon.configApply': 'Apply configuration',
	'rcon.settings': 'Change settings',
	'rcon.reservedAdd': 'Add reserved slot',
	'rcon.reservedRemove': 'Remove reserved slot',
	'rcon.raw': 'Raw request',
	'trigger.welcome': 'Trigger · welcome whisper',
	'trigger.broadcast': 'Trigger · scheduled broadcast',
	'trigger.empty_reset': 'Trigger · empty-server map reset',
	'trigger.risk_kick': 'Trigger · risk kick',
	'player.note': 'Player note',
	'player.watch': 'Watchlist',
	'list.add': 'Org list · added',
	'list.remove': 'Org list · removed',
	'list.import': 'Org list · imported from a server',
	'list.expire': 'Org list · ban expired',
	'lists.sync': 'Org list · sync',
	login: 'Sign-in',
	'login.failed': 'Sign-in failed'
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function buildEmbed(appName: string, row: AuditRow): Embed {
	const title = ACTION_TITLES[row.action] || row.action;
	const lines: string[] = [];
	const who = row.actorName || 'someone';
	const target = row.target ? ` → \`${clip(row.target, 120)}\`` : '';
	lines.push(`**${clip(who, 60)}**${target}`);
	if (row.serverName) lines.push(`Server: ${clip(row.serverName, 80)}`);
	if (row.outcome !== 'ok')
		lines.push(`Outcome: **${row.outcome}**${row.status ? ` (${row.status})` : ''}`);
	if (row.message) lines.push(clip(row.message, 600));
	return {
		title: clip(title, 200),
		description: clip(lines.join('\n'), 2000),
		color: COLORS[row.outcome] ?? COLORS.denied,
		timestamp: row.ts.toISOString(),
		footer: { text: appName }
	};
}

// ---- delivery queue -----------------------------------------------------------------------------

const FLUSH_AFTER_MS = 1500;
const MAX_EMBEDS = 10;
const MAX_QUEUE = 100;

interface Queue {
	embeds: Embed[];
	timer: ReturnType<typeof setTimeout> | null;
	/** serialises flushes for one webhook */
	chain: Promise<void>;
}
const queues = new Map<string, Queue>();

function queueFor(id: string): Queue {
	let q = queues.get(id);
	if (!q) {
		q = { embeds: [], timer: null, chain: Promise.resolve() };
		queues.set(id, q);
	}
	return q;
}

function enqueue(env: Env, hook: WebhookRow, embed: Embed): void {
	const q = queueFor(hook.id);
	if (q.embeds.length >= MAX_QUEUE) q.embeds.shift();
	q.embeds.push(embed);
	if (q.embeds.length >= MAX_EMBEDS) {
		if (q.timer) clearTimeout(q.timer);
		q.timer = null;
		scheduleFlush(env, hook, q);
	} else if (!q.timer) {
		q.timer = setTimeout(() => {
			q.timer = null;
			scheduleFlush(env, hook, q);
		}, FLUSH_AFTER_MS);
	}
}

function scheduleFlush(env: Env, hook: WebhookRow, q: Queue): void {
	q.chain = q.chain
		.then(() => flush(env, hook, q))
		.catch((err) => {
			console.error('[warcon] webhook flush', err);
		});
}

async function flush(env: Env, hook: WebhookRow, q: Queue): Promise<void> {
	while (q.embeds.length) {
		const batch = q.embeds.splice(0, MAX_EMBEDS);
		const result = await postDiscord(env, hook, { embeds: batch });
		await recordResult(env, hook.id, result);
		if (result.retryAfterMs) {
			q.embeds.unshift(...batch);
			await new Promise((r) => setTimeout(r, result.retryAfterMs));
			continue;
		}
		if (!result.ok) {
			// 4xx other than 429: the webhook is gone or the payload was refused. Drop this batch
			// rather than retrying forever; the status is on the org page.
			continue;
		}
	}
}

export interface PostResult {
	ok: boolean;
	status: number;
	error: string;
	retryAfterMs?: number;
	/** the message Discord created (a post) or changed (an edit) */
	messageId?: string;
}

export interface DiscordPayload {
	content?: string;
	embeds?: Embed[];
}

export interface DiscordRequest {
	/** POST a new message (the default), or PATCH / DELETE one this webhook sent */
	method?: 'POST' | 'PATCH' | 'DELETE';
	messageId?: string;
	payload?: DiscordPayload;
}

/**
 * One request to the webhook: a post, or an edit or removal of a message it sent earlier (Discord
 * lets a webhook change only its own messages). Never throws.
 */
export async function callDiscord(
	env: Env,
	hook: Pick<WebhookRow, 'urlEnc'>,
	req: DiscordRequest = {}
): Promise<PostResult> {
	const method = req.method ?? 'POST';
	let url: string;
	try {
		url = decryptSecret(env, hook.urlEnc);
	} catch (err) {
		return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
	}
	if (req.messageId) url += `/messages/${encodeURIComponent(req.messageId)}`;
	// wait=true makes a post answer with the message it created, as an edit does anyway.
	if (method === 'POST') url += '?wait=true';
	const body =
		method === 'DELETE'
			? undefined
			: JSON.stringify({
					...(method === 'POST' ? { username: env.APP_NAME || 'Warcon' } : {}),
					allowed_mentions: { parse: [] },
					...req.payload
				});
	try {
		const res = await fetch(url, {
			method,
			headers: body === undefined ? {} : { 'content-type': 'application/json' },
			body,
			signal: AbortSignal.timeout(10_000)
		});
		if (res.status === 429) {
			const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
			const retry = Number(res.headers.get('retry-after')) || Number(body.retry_after) || 5;
			return {
				ok: false,
				status: 429,
				error: 'Discord is rate limiting this webhook.',
				retryAfterMs: Math.min(60_000, Math.ceil(retry * 1000))
			};
		}
		if (!res.ok) {
			const text = (await res.text().catch(() => '')).slice(0, 200);
			return {
				ok: false,
				status: res.status,
				error: `Discord answered ${res.status}. ${text}`.trim()
			};
		}
		const data =
			res.status === 204 ? null : ((await res.json().catch(() => null)) as { id?: unknown } | null);
		return {
			ok: true,
			status: res.status,
			error: '',
			...(typeof data?.id === 'string' ? { messageId: data.id } : {})
		};
	} catch (err) {
		return {
			ok: false,
			status: 0,
			error:
				err instanceof Error && err.name === 'TimeoutError'
					? 'Discord did not answer.'
					: 'Could not reach Discord.'
		};
	}
}

/** Posts one message. */
export const postDiscord = (
	env: Env,
	hook: Pick<WebhookRow, 'urlEnc'>,
	payload: DiscordPayload
): Promise<PostResult> => callDiscord(env, hook, { payload });

export async function recordResult(env: Env, id: string, result: PostResult): Promise<void> {
	try {
		await env.db
			.update(webhooks)
			.set({
				lastSentAt: result.ok ? new Date() : undefined,
				lastStatus: result.status,
				lastError: result.ok ? '' : result.error.slice(0, 300)
			})
			.where(eq(webhooks.id, id));
	} catch (err) {
		console.error('[warcon] webhook status', err);
	}
}

/** Fans one audit row out to the org's webhooks that want its event class. Never throws. */
export async function notifyWebhooks(env: Env, row: AuditRow): Promise<void> {
	try {
		const event = classify(row);
		if (!event) return;
		const orgId = row.orgId ?? (row.serverId ? await orgOfServer(env, row.serverId) : null);
		if (!orgId) return;
		const hooks = await enabledWebhooks(env, orgId);
		if (!hooks.length) return;
		let embed: Embed | null = null;
		for (const hook of hooks) {
			const events = (hook.events as string[]) || [];
			if (!events.includes(event)) continue;
			const only = hook.serverIds as string[] | null;
			if (only && only.length && (!row.serverId || !only.includes(row.serverId))) continue;
			embed ??= buildEmbed(env.APP_NAME || 'Warcon', row);
			enqueue(env, hook, embed);
		}
	} catch (err) {
		console.error('[warcon] webhook notify', err);
	}
}

/** Test-only: drop everything queued. */
export function resetWebhookQueues(): void {
	for (const q of queues.values()) if (q.timer) clearTimeout(q.timer);
	queues.clear();
	orgWebhooks.clear();
	serverOrg.clear();
}

/** Servers of an org, for validating a server filter. */
export async function orgServerIds(env: Env, orgId: string, ids: string[]): Promise<string[]> {
	if (!ids.length) return [];
	const rows = await env.db
		.select({ id: servers.id })
		.from(servers)
		.where(and(eq(servers.orgId, orgId), inArray(servers.id, ids)));
	return rows.map((r) => r.id);
}
