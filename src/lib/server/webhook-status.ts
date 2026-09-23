// Keeps each webhook's live status messages current: one message per server it covers. Every
// STATUS_TICK_MS the process that owns the worker reads the webhooks that asked for them, builds
// each card from what the poller has in memory (webhook-status-core.ts) and edits it when its
// substance changed, or after HEARTBEAT_MS so the clocks in it stay honest. A message somebody
// deleted in Discord is posted afresh; a server the webhook stopped covering has its message
// removed; a webhook Discord no longer knows shows as failing on the org page like the mirror.
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { Env } from './env';
import { organizations, servers, webhooks, type WebhookRow } from './db/schema';
import { isOwner } from './leadership';
import { memoryOf } from './observe';
import { liveView } from './live';
import { deleteDiscord, editDiscord, postDiscord, type PostResult } from './webhook-delivery';
import { cardLinks, statusMessage, type StatusServer } from './webhook-status-core';
import { effectiveFeatures, type FeatureSet } from '$lib/features';
import { readRestartSchedule } from '$lib/uptime';

export const STATUS_TICK_MS = 20_000;
/** Re-edit an unchanged message this often so its embed timestamps do not drift into the past. */
const HEARTBEAT_MS = 5 * 60_000;
/**
 * Edits of one message are at least the webhook's own interval apart (30 s to 5 min), and further
 * apart the more servers share one webhook: Discord allows ~30 requests a minute.
 */
const GAP_PER_SERVER_MS = 4000;

/** What a card needs of its server: the label and which public pages it has. */
interface CardServer extends StatusServer {
	features: FeatureSet;
}
/** After a failed request, leave that webhook alone for this long. */
const BACKOFF_MS = 60_000;

interface Sent {
	messageId: string;
	key: string;
	/** when the message last went out successfully */
	at: number;
}
/** keyed by webhook id + server id */
const sent = new Map<string, Sent>();
/** webhooks to leave alone until this time (rate limited, or failing) */
const retryAt = new Map<string, number>();
let ticking = false;

type MessageMap = Record<string, string>;

declare global {
	// Survive Vite HMR re-evaluation in dev so we never run two tickers.
	var __warconStatus: ReturnType<typeof setInterval> | undefined;
}

export function startStatusMirror(env: Env): void {
	stopStatusMirror();
	envRef = env;
	globalThis.__warconStatus = setInterval(() => void tick(env), STATUS_TICK_MS);
}

export function stopStatusMirror(): void {
	if (globalThis.__warconStatus) clearInterval(globalThis.__warconStatus);
	globalThis.__warconStatus = undefined;
	if (nudge) clearTimeout(nudge);
	nudge = null;
	envRef = null;
}

let envRef: Env | null = null;
let nudge: ReturnType<typeof setTimeout> | null = null;

/** Run a pass shortly (a webhook was just added or changed) instead of waiting for the tick. */
export function nudgeStatusMirror(): void {
	if (!envRef || nudge) return;
	nudge = setTimeout(() => {
		nudge = null;
		if (envRef) void tick(envRef);
	}, 1500);
}

async function tick(env: Env): Promise<void> {
	if (ticking || !isOwner()) return;
	ticking = true;
	try {
		await refreshStatusMessages(env);
	} catch (err) {
		console.error('[warcon] status messages', err);
	} finally {
		ticking = false;
	}
}

/** One pass over every webhook that keeps status messages. */
export async function refreshStatusMessages(env: Env, now = Date.now()): Promise<void> {
	const hooks = await env.db
		.select({ hook: webhooks, orgName: organizations.name })
		.from(webhooks)
		.innerJoin(organizations, eq(organizations.id, webhooks.orgId))
		.where(and(eq(webhooks.enabled, true), eq(webhooks.statusEnabled, true)));
	for (const k of sent.keys())
		if (!hooks.some((h) => k.startsWith(h.hook.id + ':'))) sent.delete(k);
	for (const id of retryAt.keys()) if (!hooks.some((h) => h.hook.id === id)) retryAt.delete(id);
	if (!hooks.length) return;
	const rows = await env.db
		.select({ server: servers, org: organizations })
		.from(servers)
		.innerJoin(organizations, eq(organizations.id, servers.orgId))
		.where(inArray(servers.orgId, [...new Set(hooks.map((h) => h.hook.orgId))]))
		.orderBy(asc(servers.sortOrder), asc(servers.name));
	const byOrg = new Map<string, CardServer[]>();
	for (const { server, org } of rows) {
		const list = byOrg.get(server.orgId) ?? [];
		list.push({
			id: server.id,
			name: server.name,
			restartSchedule: readRestartSchedule(server.restartSchedule),
			features: effectiveFeatures(org, server)
		});
		byOrg.set(server.orgId, list);
	}
	// Different webhooks are different rate-limit buckets, so they need not wait on each other;
	// the servers of one webhook go one after another, in the order the dashboard shows them.
	await Promise.all(
		hooks.map(({ hook, orgName }) => {
			const all = byOrg.get(hook.orgId) ?? [];
			const only = hook.serverIds as string[] | null;
			const list = only && only.length ? all.filter((s) => only.includes(s.id)) : all;
			return refreshHook(env, hook, orgName, list, now).catch((err) =>
				console.error(`[warcon] status messages ${hook.label}`, err)
			);
		})
	);
}

async function refreshHook(
	env: Env,
	hook: WebhookRow,
	orgName: string,
	list: CardServer[],
	now: number
): Promise<void> {
	if ((retryAt.get(hook.id) ?? 0) > now) return;
	const map: MessageMap = { ...((hook.statusMessages as MessageMap | null) ?? {}) };
	// Servers the webhook no longer covers (filter changed, server removed): take their cards down.
	const stale = Object.keys(map).filter((id) => !list.some((s) => s.id === id));
	if (stale.length) {
		for (const id of stale) {
			await deleteDiscord(env, hook, map[id]);
			delete map[id];
			sent.delete(`${hook.id}:${id}`);
		}
		await env.db.update(webhooks).set({ statusMessages: map }).where(eq(webhooks.id, hook.id));
	}
	const gap = Math.max(hook.statusIntervalS * 1000, list.length * GAP_PER_SERVER_MS);
	const opts = {
		appName: env.APP_NAME || 'Warcon',
		orgName,
		origin: env.ORIGIN,
		now,
		style: hook.statusStyle
	};
	for (const server of list) {
		const key = `${hook.id}:${server.id}`;
		const st = sent.get(key);
		const m = memoryOf(server.id);
		const { payload, key: substance } = statusMessage(
			{ ...opts, links: cardLinks(env.ORIGIN, server.id, hook, server.features) },
			server,
			m && m.observedAt ? liveView(m) : null
		);
		let messageId: string | null = map[server.id] ?? null;
		if (messageId && st && st.messageId === messageId) {
			if (st.key === substance && now - st.at < HEARTBEAT_MS) continue;
			if (now - st.at < gap) continue;
		}
		let result: PostResult | null = null;
		let posted = false;
		if (messageId) {
			result = await editDiscord(env, hook, messageId, payload);
			// Someone removed it from the channel: start a new one rather than fail forever.
			if (result.unknownMessage) messageId = null;
		}
		if (!messageId) {
			result = await postDiscord(env, hook, payload);
			posted = true;
			messageId = result.ok ? (result.messageId ?? null) : null;
		}
		const set: Partial<typeof webhooks.$inferInsert> = {
			lastStatus: result!.status,
			lastError: result!.ok ? '' : result!.error.slice(0, 300)
		};
		if (result!.ok) set.lastSentAt = set.statusSentAt = new Date(now);
		if (posted && messageId) {
			// This process is the map's only writer (the web only ever clears it), so the whole map
			// goes back; the claim below still refuses it once the cards were switched off.
			map[server.id] = messageId;
			set.statusMessages = { ...map };
		}
		const claimed = await env.db
			.update(webhooks)
			.set(set)
			.where(
				posted
					? // Only while the cards are still wanted: switched off meanwhile, it must not linger.
						and(
							eq(webhooks.id, hook.id),
							eq(webhooks.enabled, true),
							eq(webhooks.statusEnabled, true)
						)
					: eq(webhooks.id, hook.id)
			)
			.returning({ id: webhooks.id });
		if (posted && messageId && !claimed.length) {
			await deleteDiscord(env, hook, messageId);
			sent.delete(key);
			return;
		}
		// Remember what the channel actually shows: a failed edit leaves the previous key in place
		// so the retry is not mistaken for "nothing changed".
		sent.set(key, {
			messageId: messageId ?? '',
			key: result!.ok ? substance : (st?.key ?? ''),
			at: result!.ok ? now : (st?.at ?? 0)
		});
		if (!result!.ok) {
			retryAt.set(hook.id, now + (result!.retryAfterMs ?? BACKOFF_MS));
			return;
		}
	}
}

/** Test-only. */
export function resetStatusMirror(): void {
	sent.clear();
	retryAt.clear();
}
