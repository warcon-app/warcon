// Mirrors audit rows to Discord webhooks. Called by writeAudit after every insert; delivery is
// asynchronous and batched per webhook (Discord accepts up to 10 embeds per message and rate
// limits each webhook), so a burst of kicks becomes one message rather than a flood of 429s.
// Only this module talks to Discord; webhooks.ts owns the records and their validation.
import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from './env';
import { decryptSecret } from './crypto';
import { forLog } from './http';
import { playerMarks, servers, webhooks, type AuditRow, type WebhookRow } from './db/schema';
import { OWNERS_ROWS } from './audit-rows';
import { escapeMarkdown } from './webhook-status-core';
import { KILL_DISTANCE_SKIP } from './kill-distance';
import { causeLabel } from '$lib/causes';
import { mapName } from '$lib/format';
import type { BountyLapse } from './bounty';
import { FAILURES_ONLY } from '$lib/rule-kinds';
import type { KillView } from '$lib/types';

export const WEBHOOK_EVENTS = [
	'bans',
	'commands',
	'triggers',
	'players',
	'management',
	'auth',
	'teamkills',
	'watched',
	'bounties'
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
	bans: 'Bans and unbans',
	commands: 'Other game commands (kick, broadcast, map, config…)',
	triggers: 'Automation (trigger actions)',
	players: 'Player notes and watchlist changes',
	management: 'Servers, members, invite links, accounts',
	auth: 'Sign-ins and sign-in failures',
	teamkills: 'Team kills (from the kill feed)',
	watched: 'Watched players joining',
	bounties: "Bounties (set, claimed and lapsed, for a players' channel)"
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

export interface EmbedField {
	name: string;
	value: string;
	inline?: boolean;
}
export interface Embed {
	title: string;
	description: string;
	color: number;
	timestamp: string;
	url?: string;
	author?: { name: string; icon_url?: string; url?: string };
	thumbnail?: { url: string };
	image?: { url: string };
	fields?: EmbedField[];
	footer?: { text: string; icon_url?: string };
}

export interface DiscordPayload {
	content?: string;
	embeds?: Embed[];
}

const COLORS = { ok: 0x7bc462, error: 0xd86060, denied: 0x8a8a90 } as const;

const ACTION_TITLES: Record<string, string> = {
	'rcon.kick': 'Kick',
	'rcon.ban': 'Ban',
	'rcon.unban': 'Unban',
	'rcon.kill': 'Kill',
	'rcon.whisper': 'Whisper',
	'rcon.whisperMany': 'Group whisper',
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
	'trigger.faction_change': 'Trigger · faction change whisper',
	'trigger.broadcast': 'Trigger · scheduled broadcast',
	'trigger.empty_reset': 'Trigger · empty-server map reset',
	'trigger.risk_kick': 'Trigger · kick on connect risk',
	'trigger.ping_kick': 'Trigger · high ping kick',
	'trigger.restart_notice': 'Trigger · restart notice',
	'trigger.team_kill': 'Trigger · team kill limit',
	'trigger.seed_reward': 'Trigger · seeding reward',
	'trigger.match_broadcast': 'Trigger · match broadcast',
	'trigger.name_filter': 'Trigger · name filter',
	'trigger.kill_rate': 'Trigger · kill rate watch',
	'trigger.two_teams': 'Trigger · team balance',
	'trigger.kill_distance': 'Trigger · kill distance watch',
	'trigger.afk_protection': 'Trigger · AFK protection',
	'trigger.name_change': 'Trigger · name change watch',
	'trigger.bounty': 'Trigger · bounty',
	'trigger.rotation_shuffle': 'Trigger · rotation shuffle',
	'trigger.live_name': 'Trigger · live server name',
	'player.note': 'Player note',
	'player.watch': 'Watchlist',
	'list.add': 'Org list · added',
	'list.remove': 'Org list · removed',
	'list.update': 'Org list · changed',
	'list.import': 'Org list · imported from a server',
	'list.expire': 'Org list · expired',
	'list.group.create': 'Reserved-slot group · made',
	'list.group.update': 'Reserved-slot group · changed',
	'list.group.switch': 'Reserved-slot group · switched',
	'list.group.archive': 'Reserved-slot group · removed',
	'lists.sync': 'Org list · sync',
	'ban.enforce': 'Ban · banned player removed',
	login: 'Sign-in',
	'login.failed': 'Sign-in failed'
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
/** Text from outside (a player's name, a rule's result) as it reads: no link, markdown or mention,
 *  on one line so nothing it holds starts a heading or a quote, and no address Discord would make
 *  a link of (a zero-width space after the scheme's colon). */
const plain = (s: string, n: number) =>
	escapeMarkdown(clip(s.replace(/\s*[\r\n]+\s*/g, ' '), n))
		.replace(/:\/\//g, ':\u200B//')
		.replace(/^([#-])/, '\\$1');
/** The same inside a code span, which no escape reaches: its own backtick would close the span. */
const code = (s: string, n: number) => `\`${clip(s.replace(/`/g, 'ˋ'), n)}\``;

export function buildEmbed(appName: string, row: AuditRow): Embed {
	const title = ACTION_TITLES[row.action] || row.action;
	const lines: string[] = [];
	const who = row.actorName || 'someone';
	// A server being added, edited or deleted names it and who did it, no more: the row's target is
	// where RCON listens and a refusal's message says what the host resolves to, and a channel is
	// read by people the Audit trail would not show these rows to.
	const bare = OWNERS_ROWS.includes(row.action);
	const target = row.target && !bare ? ` → ${code(row.target, 120)}` : '';
	lines.push(`**${plain(who, 60)}**${target}`);
	if (row.serverName) lines.push(`Server: ${plain(row.serverName, 80)}`);
	if (row.outcome !== 'ok')
		lines.push(`Outcome: **${row.outcome}**${row.status ? ` (${row.status})` : ''}`);
	if (row.message && !bare) lines.push(plain(row.message, 600));
	return {
		title: clip(title, 200),
		description: clip(lines.join('\n'), 2000),
		color: COLORS[row.outcome] ?? COLORS.denied,
		timestamp: row.ts.toISOString(),
		footer: { text: appName }
	};
}

/** A Kill rate, Kill distance or Name change post is a prompt to go and look: it opens the player's
 *  page. */
const DOSSIER_LINKED = new Set([
	'trigger.kill_rate',
	'trigger.kill_distance',
	'trigger.name_change'
]);
function withDossierLink(env: Env, row: AuditRow, embed: Embed): Embed {
	if (!DOSSIER_LINKED.has(row.action) || !row.serverId || !row.target) return embed;
	const url = dossierUrl(env.ORIGIN, row.serverId, row.target);
	return url ? { ...embed, url } : embed;
}

const TEAM_KILL_COLOR = 0xe0a83a;

/** One team kill from the feed as an embed: who, whom, with what, how far. */
export function buildTeamKillEmbed(appName: string, serverName: string, k: KillView): Embed {
	const cause = causeLabel(k.cause);
	const how = [
		cause,
		k.distanceM === null ? '' : `${Math.round(k.distanceM)} m`,
		k.headshot ? 'headshot' : ''
	]
		.filter(Boolean)
		.join(' · ');
	const lines = [
		`**${plain(k.killer?.name ?? '?', 60)}** → **${plain(k.victim.name, 60)}**${k.killer?.faction ? ` (${plain(k.killer.faction, 30)})` : ''}`,
		how,
		`Server: ${plain(serverName, 80)}${k.map ? ` · ${plain(k.map, 40)}` : ''}`
	].filter(Boolean);
	return {
		title: 'Team kill',
		description: clip(lines.join('\n'), 2000),
		color: TEAM_KILL_COLOR,
		timestamp: k.ts,
		footer: { text: appName }
	};
}

const WATCHED_COLOR = 0x5b8def;

const BOUNTY_COLORS = { set: 0xd4a843, claim: 0x7bc462, lapse: 0x8a8a90 } as const;

/** A bounty as a Bounties channel shows it: for players, so names only, never a SteamID. */
export type BountyCard = {
	/** when it happened (ISO) */
	at: string;
	/** the map's id, as the game names it */
	map: string | null;
	/** the reward in words; '' for none */
	reward: string;
	/** the slot is on every server of the organisation */
	orgWide: boolean;
} & (
	| { kind: 'set'; name: string; faction: string | null; streak: number }
	| { kind: 'claim'; claimer: string; target: string; run: number }
	| { kind: 'lapse'; name: string; run: number; why: BountyLapse }
);

/** One bounty set, claimed or lapsed as an embed: who, the run, the reward, where. */
export function buildBountyEmbed(appName: string, serverName: string, c: BountyCard): Embed {
	const reward = c.reward
		? `Reward: ${plain(c.reward, 80)}${c.orgWide ? ', on every server' : ''}`
		: '';
	const where = `${plain(serverName, 80)}${c.map ? ` · ${plain(mapName(c.map), 40)}` : ''}`;
	const card =
		c.kind === 'set'
			? {
					// the name goes in the body, where it is escaped like every other name (titles are not)
					title: 'Bounty set',
					lines: [
						`**${plain(c.name, 60)}**: ${c.streak} kills without dying${c.faction ? `, for ${plain(c.faction, 30)}` : ''}`,
						reward
					]
				}
			: c.kind === 'claim'
				? {
						title: 'Bounty claimed',
						lines: [
							`**${plain(c.claimer, 60)}** ended **${plain(c.target, 60)}**'s run at ${c.run}`,
							reward
						]
					}
				: {
						title: 'Bounty lapsed',
						lines: [
							c.why === 'left'
								? `**${plain(c.name, 60)}** left the server on a run of ${c.run}`
								: `The match ended with **${plain(c.name, 60)}** on a run of ${c.run}`
						]
					};
	return {
		title: card.title,
		description: clip([...card.lines, where].filter(Boolean).join('\n'), 2000),
		color: BOUNTY_COLORS[c.kind],
		timestamp: c.at,
		footer: { text: appName }
	};
}

/** Posts a bounty to the org's webhooks with Bounties ticked for the server. Never throws. */
export async function notifyBounty(
	env: Env,
	serverId: string,
	serverName: string,
	cards: BountyCard[]
): Promise<void> {
	try {
		if (!cards.length) return;
		const orgId = await orgOfServer(env, serverId);
		if (!orgId) return;
		const hooks = hooksFor(await enabledWebhooks(env, orgId), 'bounties', serverId);
		if (!hooks.length) return;
		for (const c of cards) {
			const embed = buildBountyEmbed(env.APP_NAME || 'Warcon', serverName, c);
			for (const hook of hooks) enqueue(env, hook, embed);
		}
	} catch (err) {
		console.error('[warcon] webhook bounties', forLog(err));
	}
}

/** The player's page in the panel, for a staff post about one player; none without an origin. */
export function dossierUrl(origin: string | undefined, serverId: string, steamId: string) {
	if (!origin || !/^\d{17}$/.test(steamId)) return undefined;
	return `${origin.replace(/\/$/, '')}/server/${encodeURIComponent(serverId)}/players/${steamId}`;
}

/** A watched player joining: who, why they are watched, where; the title opens their page. */
export function buildWatchedJoinEmbed(
	appName: string,
	serverName: string,
	p: { steamId: string; name: string; reason: string },
	at: string,
	url?: string
): Embed {
	const lines = [
		`**${plain(p.name || p.steamId, 60)}** ${code(p.steamId, 20)}`,
		p.reason ? plain(p.reason, 600) : '',
		`Server: ${plain(serverName, 80)}`
	].filter(Boolean);
	return {
		title: 'Watched player joined',
		...(url ? { url } : {}),
		description: clip(lines.join('\n'), 2000),
		color: WATCHED_COLOR,
		timestamp: at,
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
			console.error('[warcon] webhook flush', forLog(err));
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
	/** the id of the message Discord created or edited */
	messageId?: string;
	/** Discord no longer has the message we tried to edit or delete (someone removed it) */
	unknownMessage?: boolean;
}

/** Discord's error code for "Unknown Message". */
const UNKNOWN_MESSAGE = 10008;

/**
 * One request to the webhook: `path` is appended to the webhook URL (the message subresource
 * for edits and deletes). The URL is the credential, so it is decrypted here and nowhere else.
 * Never throws.
 */
async function discordCall(
	env: Env,
	hook: Pick<WebhookRow, 'urlEnc'>,
	method: 'POST' | 'PATCH' | 'DELETE',
	path: string,
	body?: Record<string, unknown>
): Promise<PostResult> {
	let url: string;
	try {
		url = decryptSecret(env, hook.urlEnc);
	} catch (err) {
		return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
	}
	try {
		const res = await fetch(url + path, {
			method,
			headers: body ? { 'content-type': 'application/json' } : undefined,
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.timeout(10_000)
		});
		if (res.status === 429) {
			const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
			const retry = Number(res.headers.get('retry-after')) || Number(data.retry_after) || 5;
			return {
				ok: false,
				status: 429,
				error: 'Discord is rate limiting this webhook.',
				retryAfterMs: Math.min(60_000, Math.ceil(retry * 1000))
			};
		}
		if (!res.ok) {
			const text = (await res.text().catch(() => '')).slice(0, 200);
			let code = 0;
			try {
				code = Number((JSON.parse(text) as { code?: number }).code) || 0;
			} catch {
				// not JSON; the text is the whole message
			}
			return {
				ok: false,
				status: res.status,
				error: `Discord answered ${res.status}. ${text}`.trim(),
				unknownMessage: code === UNKNOWN_MESSAGE
			};
		}
		let messageId: string | undefined;
		if (res.status !== 204) {
			const data = (await res.json().catch(() => ({}))) as { id?: unknown };
			if (typeof data.id === 'string') messageId = data.id;
		}
		return { ok: true, status: res.status, error: '', messageId };
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

/**
 * Posts a new message; the result carries its id. It names no one, so Discord shows the name and
 * picture its owner gave the webhook there: a name sent here would take their place. Never throws.
 */
export function postDiscord(
	env: Env,
	hook: Pick<WebhookRow, 'urlEnc'>,
	payload: DiscordPayload
): Promise<PostResult> {
	return discordCall(env, hook, 'POST', '?wait=true', {
		allowed_mentions: { parse: [] },
		...payload
	});
}

/** Replaces the content of a message this webhook posted earlier. Never throws. */
export function editDiscord(
	env: Env,
	hook: Pick<WebhookRow, 'urlEnc'>,
	messageId: string,
	payload: DiscordPayload
): Promise<PostResult> {
	return discordCall(env, hook, 'PATCH', `/messages/${encodeURIComponent(messageId)}`, {
		allowed_mentions: { parse: [] },
		...payload
	});
}

/** Removes a message this webhook posted earlier. Never throws. */
export function deleteDiscord(
	env: Env,
	hook: Pick<WebhookRow, 'urlEnc'>,
	messageId: string
): Promise<PostResult> {
	return discordCall(env, hook, 'DELETE', `/messages/${encodeURIComponent(messageId)}`);
}

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
		console.error('[warcon] webhook status', forLog(err));
	}
}

/**
 * Rules whose actions come by the hundred as a matter of course: a Team balance sort at every match
 * start, an AFK protection round every few minutes while a server seeds. The audit trail keeps each
 * one; Discord hears only of those that fail, so they neither flood a staff channel nor push another
 * rule's card out of the webhook's queue.
 */
const QUIET_WHEN_OK = new Set(FAILURES_ONLY.map((kind) => `trigger.${kind}`));
/** A delivery that only notes what a rule saw and let be: the audit trail keeps it, Discord does not. */
const NOTES = new Set([KILL_DISTANCE_SKIP]);
const isNote = (row: AuditRow): boolean => {
	const action = (row.detail as { rconAction?: unknown } | null)?.rconAction;
	return typeof action === 'string' && NOTES.has(action);
};

/** A webhook ticked for Automation carries every kind of rule, or only the kinds it names. */
export function takesRule(hook: Pick<WebhookRow, 'triggerKinds'>, action: string): boolean {
	const kinds = hook.triggerKinds as string[] | null;
	return !kinds || kinds.includes(action.slice('trigger.'.length));
}

/** Fans one audit row out to the org's webhooks that want its event class. Never throws. */
export async function notifyWebhooks(env: Env, row: AuditRow): Promise<void> {
	try {
		const event = classify(row);
		if (!event) return;
		if (row.outcome === 'ok' && (QUIET_WHEN_OK.has(row.action) || isNote(row))) return;
		const orgId = row.orgId ?? (row.serverId ? await orgOfServer(env, row.serverId) : null);
		if (!orgId) return;
		const hooks = await enabledWebhooks(env, orgId);
		if (!hooks.length) return;
		let embed: Embed | null = null;
		for (const hook of hooks) {
			const events = (hook.events as string[]) || [];
			if (!events.includes(event)) continue;
			if (event === 'triggers' && !takesRule(hook, row.action)) continue;
			const only = hook.serverIds as string[] | null;
			if (only && only.length && (!row.serverId || !only.includes(row.serverId))) continue;
			embed ??= withDossierLink(env, row, buildEmbed(env.APP_NAME || 'Warcon', row));
			enqueue(env, hook, embed);
		}
	} catch (err) {
		console.error('[warcon] webhook notify', forLog(err));
	}
}

/** The hooks that carry an event class for a server: ticked, and the server in their filter. */
export function hooksFor(hooks: WebhookRow[], event: WebhookEvent, serverId: string): WebhookRow[] {
	return hooks.filter((hook) => {
		if (!((hook.events as string[]) || []).includes(event)) return false;
		const only = hook.serverIds as string[] | null;
		return !only || !only.length || only.includes(serverId);
	});
}

/** The joiners on the organisation's watchlist, with why they are watched. */
export async function watchedAmong(
	env: Env,
	orgId: string,
	players: { steamId: string; name: string }[]
): Promise<{ steamId: string; name: string; reason: string }[]> {
	if (!players.length) return [];
	const rows = await env.db
		.select({ steamId: playerMarks.steamId, reason: playerMarks.reason })
		.from(playerMarks)
		.where(
			and(
				eq(playerMarks.orgId, orgId),
				eq(playerMarks.watched, true),
				inArray(
					playerMarks.steamId,
					players.map((p) => p.steamId)
				)
			)
		);
	const reason = new Map(rows.map((r) => [r.steamId, r.reason]));
	return players
		.filter((p) => reason.has(p.steamId))
		.map((p) => ({ steamId: p.steamId, name: p.name, reason: reason.get(p.steamId) ?? '' }));
}

/**
 * Tells the org's webhooks that want it when a player on its watchlist joins one of its servers.
 * The watchlist is read only when a webhook wants the event, so an org without one pays a cache
 * lookup per join. Never throws.
 */
export async function notifyWatchedJoins(
	env: Env,
	serverId: string,
	serverName: string,
	joined: { steamId: string; name: string }[]
): Promise<void> {
	try {
		if (!joined.length) return;
		const orgId = await orgOfServer(env, serverId);
		if (!orgId) return;
		const hooks = hooksFor(await enabledWebhooks(env, orgId), 'watched', serverId);
		if (!hooks.length) return;
		const now = new Date().toISOString();
		for (const p of await watchedAmong(env, orgId, joined)) {
			const embed = buildWatchedJoinEmbed(
				env.APP_NAME || 'Warcon',
				serverName,
				p,
				now,
				dossierUrl(env.ORIGIN, serverId, p.steamId)
			);
			for (const hook of hooks) enqueue(env, hook, embed);
		}
	} catch (err) {
		console.error('[warcon] webhook watched joins', forLog(err));
	}
}

/** Fans team kills from one feed batch out to the org's webhooks that mirror them. Never throws. */
export async function notifyTeamKills(
	env: Env,
	serverId: string,
	serverName: string,
	kills: KillView[]
): Promise<void> {
	try {
		const teamKills = kills.filter((k) => k.teamKill);
		if (!teamKills.length) return;
		const orgId = await orgOfServer(env, serverId);
		if (!orgId) return;
		const hooks = hooksFor(await enabledWebhooks(env, orgId), 'teamkills', serverId);
		if (!hooks.length) return;
		for (const k of teamKills) {
			const embed = buildTeamKillEmbed(env.APP_NAME || 'Warcon', serverName, k);
			for (const hook of hooks) enqueue(env, hook, embed);
		}
	} catch (err) {
		console.error('[warcon] webhook team kills', forLog(err));
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
