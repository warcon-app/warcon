// Mirrors audit rows to Discord webhooks. Called by writeAudit after every insert; delivery is
// asynchronous and batched per webhook (Discord accepts up to 10 embeds per message and rate
// limits each webhook), so a burst of kicks becomes one message rather than a flood of 429s.
// Only this module talks to Discord; webhooks.ts owns the records and their validation.
import { and, eq, inArray } from 'drizzle-orm';
import type { Env } from './env';
import { decryptSecret } from './crypto';
import { forLog, str } from './http';
import { playerMarks, servers, webhooks, type AuditRow, type WebhookRow } from './db/schema';
import { OWNERS_ROWS } from './audit-rows';
import { escapeMarkdown } from './webhook-status-core';
import { KILL_DISTANCE_SKIP } from './kill-distance';
import { causeLabel } from '$lib/causes';
import { MAX_CHAT } from '$lib/chat';
import { mapName } from '$lib/format';
import { oneLine } from '$lib/saved-messages';
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
	'bounties',
	'staffcalls'
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
	bans: 'Bans and unbans',
	commands: 'Game commands and chat (kick, map, config…; whisper and broadcast text)',
	triggers: 'Automation (trigger actions)',
	players: 'Player notes and watchlist changes',
	management: 'Servers, members, invite links, accounts',
	auth: 'Sign-ins and sign-in failures',
	teamkills: 'Team kills (from the kill feed)',
	watched: 'Watched players joining',
	bounties: "Bounties (set, claimed and lapsed, for a players' channel)",
	staffcalls:
		'Staff calls (what a player sends staff with !admin or !report, from a Staff call rule)'
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
	'rcon.chatTermsAccept': 'Accept chat terms',
	'rcon.chatTerms': 'Read chat terms',
	'rcon.chat': 'Read chat',
	'trigger.welcome': 'Trigger · welcome whisper',
	'trigger.faction_change': 'Trigger · faction change whisper',
	'trigger.broadcast': 'Trigger · scheduled broadcast',
	'trigger.empty_reset': 'Trigger · empty-server map reset',
	'trigger.restart_skip': 'Trigger · skip map after restart',
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
	'trigger.afk_watch': 'Trigger · AFK watch',
	'trigger.name_change': 'Trigger · name change watch',
	'trigger.bounty': 'Trigger · bounty',
	'trigger.rotation_shuffle': 'Trigger · rotation shuffle',
	'trigger.live_name': 'Trigger · live server name',
	'trigger.weather_cycle': 'Trigger · weather cycle',
	'trigger.death_whisper': 'Trigger · death whisper',
	// the chat rules queue no actions (their answers go out in the look), so no card carries these
	// two; they are named as every kind is
	'trigger.chat_command': 'Trigger · chat command',
	'trigger.staff_call': 'Trigger · staff call',
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

/** Cut to `n` characters, never through the middle of one: half an emoji is no text to Discord. */
const clip = (s: string, n: number) =>
	s.length > n ? s.slice(0, n - 1).replace(/[\uD800-\uDBFF]$/, '') + '…' : s;
/** Text from outside (a player's name, a rule's result) as it reads: no link, markdown or mention,
 *  on one line so nothing it holds starts a heading or a quote, and no address Discord would make
 *  a link of (a zero-width space after the scheme's colon). */
const plain = (s: string, n: number) =>
	escapeMarkdown(clip(s.replace(/\s*[\r\n]+\s*/g, ' '), n))
		.replace(/:\/\//g, ':\u200B//')
		.replace(/^([#-])/, '\\$1');
/** The same inside a code span, which no escape reaches: its own backtick would close the span. */
const code = (s: string, n: number) => `\`${clip(s.replace(/`/g, 'ˋ'), n)}\``;

/** Whispers by hand, whose detail keeps what they said and whose message is the game's answer. A
 *  rule's whisper keeps no words of its own (see OWN_WORDS in outbox.ts). */
const WHISPERS = new Set(['rcon.whisper', 'rcon.whisperMany']);

/** What a whisper by hand said, as the action cut it for the game, on one line; none on a refused
 *  request, whose words stay in the audit trail. */
function whisperOf(row: AuditRow): string {
	const message = (row.detail as { message?: unknown } | null)?.message;
	return WHISPERS.has(row.action) && row.outcome !== 'denied' && typeof message === 'string'
		? oneLine(str(message, MAX_CHAT), MAX_CHAT)
		: '';
}

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
	const said = whisperOf(row);
	if (said) lines.push(`Message: ${plain(said, MAX_CHAT)}`);
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

const STAFF_CALL_COLOR = 0xe07a3a;

/**
 * What a player sent staff through a Staff call rule ($lib/server/chat-rules): the one thing typed
 * in the game's chat that the panel passes on, to the organisation's own staff channel, at the
 * player's own asking. It is built here and posted, and kept nowhere in the panel.
 */
export interface StaffCallCard {
	/** when the panel read it (ISO) */
	at: string;
	/** the word typed, without the "!": one of the rule's own, letters and digits */
	word: string;
	/** the word reports a player: `about` is who the text names, when someone on the server fits */
	report: boolean;
	/** what followed the word, as the other players saw it (as typed, where the game's filter
	 *  left no command of the line) */
	text: string;
	/** the chat channel it was typed in */
	channel: string;
	caller: { steamId: string; name: string; hiddenName: string; anonymous: boolean };
	/** `guess`: '' when the text names the player outright, else what they were guessed from */
	about: { steamId: string; name: string; guess: string } | null;
	/** the map's id, as the game names it */
	map: string;
	/** how many were on */
	players: number;
}

/** One staff call as an embed: who sent it, what they wrote, whom a report names, and where. */
export function buildStaffCallEmbed(
	appName: string,
	origin: string | undefined,
	server: { id: string; name: string },
	c: StaffCallCard
): Embed {
	// What a player typed or named themselves, straight from the game, beside a link of the card's
	// own: text as `plain` has it, and no parenthesis of theirs either, so nothing they write ends
	// the link or starts another; a stray half of a character pair (which Discord refuses the whole
	// message for) becomes a mark.
	const text = (s: string, n: number) =>
		plain(s.replace(/\p{Cs}/gu, '\uFFFD'), n).replace(/[()]/g, '\\$&');
	// a name is a link to the player's page where the panel knows its own address
	const who = (p: { steamId: string; name: string }) => {
		const url = dossierUrl(origin, server.id, p.steamId);
		const name = `**${text(p.name || p.steamId, 60)}**`;
		return `${url ? `[${name}](${url})` : name} ${code(p.steamId, 20)}`;
	};
	const anon = c.caller.anonymous
		? ` · anonymous${c.caller.hiddenName ? `, shown as ${text(c.caller.hiddenName, 60)}` : ''}`
		: '';
	// a report's player: named outright, or a guess that says what it was guessed from
	const about = !c.report
		? ''
		: !c.about
			? 'About: no player on the server fits the name given'
			: c.about.guess
				? `Perhaps about: ${who(c.about)} · guessed from "${text(c.about.guess, 40)}"`
				: `About: ${who(c.about)}`;
	const lines = [
		`${who(c.caller)}${anon}`,
		c.text ? `> ${text(c.text, 500)}` : '',
		about,
		`Server: ${text(server.name, 80)}${c.map ? ` · ${text(mapName(c.map), 40)}` : ''} · ${c.players} on${c.channel ? ` · ${text(c.channel, 24)} chat` : ''}`
	].filter(Boolean);
	return {
		// the word is the rule's own (letters and digits): safe in a title, which is not escaped
		title: `${c.report ? 'Player report' : 'Staff call'} · !${c.word.replace(/[^a-z0-9]/gi, '')}`,
		description: clip(lines.join('\n'), 2000),
		color: STAFF_CALL_COLOR,
		timestamp: c.at,
		footer: { text: appName }
	};
}

/**
 * Discord's answers that say a webhook is gone (404) or its address no longer holds (401). Nothing
 * sent to one arrives until an owner gives it a new address or a test card gets through. A 403 is
 * not among them: it can be an answer to something else (an edit, a block in front of Discord),
 * and a webhook wrongly counted out stays out until someone looks.
 */
const REFUSED_FOR_GOOD = new Set([401, 404]);

/**
 * The org's webhooks that take Staff calls for this server, less any Discord last refused for good:
 * a call sent there reaches nobody, and the rule must not tell the player otherwise.
 */
async function staffCallHooksOf(
	env: Env,
	server: { id: string; orgId: string }
): Promise<WebhookRow[]> {
	return hooksFor(await enabledWebhooks(env, server.orgId), 'staffcalls', server.id).filter(
		(hook) => !REFUSED_FOR_GOOD.has(hook.lastStatus ?? 0)
	);
}

/** How many Discord webhooks would carry a staff call from this server: a Staff call rule says so. */
export async function staffCallHooks(
	env: Env,
	server: { id: string; orgId: string }
): Promise<number> {
	return (await staffCallHooksOf(env, server)).length;
}

/**
 * Queues a staff call for the org's webhooks with Staff calls ticked for the server, and says for
 * how many (0: nobody will be told, and the rule does not tell the player otherwise). The card
 * goes out a moment later, with the queue's next message; one Discord then refuses is not sent
 * again, and a webhook it refuses for good counts as none from the next call on. Never throws.
 */
export async function notifyStaffCall(
	env: Env,
	server: { id: string; orgId: string; name: string },
	card: StaffCallCard
): Promise<number> {
	try {
		const hooks = await staffCallHooksOf(env, server);
		if (!hooks.length) return 0;
		const embed = buildStaffCallEmbed(env.APP_NAME || 'Warcon', env.ORIGIN, server, card);
		for (const hook of hooks) enqueue(env, hook, embed);
		return hooks.length;
	} catch (err) {
		console.error('[warcon] webhook staff calls', forLog(err));
		return 0;
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
/** Discord refuses a message whose embeds hold more characters than this between them, titles,
 *  descriptions, fields, footers and authors counted together. */
const MAX_CHARS = 6000;
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

const charsOf = (e: Embed) =>
	e.title.length +
	e.description.length +
	(e.footer?.text.length ?? 0) +
	(e.author?.name.length ?? 0) +
	(e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

/** Takes the next message's embeds off the front of a queue: as many as Discord takes in one, and
 *  at least one, so a burst of long cards goes as several messages, not one that Discord refuses. */
export function nextBatch(embeds: Embed[]): Embed[] {
	let n = 0;
	let chars = 0;
	while (n < embeds.length && n < MAX_EMBEDS) {
		chars += charsOf(embeds[n]);
		if (n > 0 && chars > MAX_CHARS) break;
		n++;
	}
	return embeds.splice(0, n);
}

async function flush(env: Env, hook: WebhookRow, q: Queue): Promise<void> {
	while (q.embeds.length) {
		const batch = nextBatch(q.embeds);
		const result = await postDiscord(env, hook, { embeds: batch });
		await recordResult(env, hook.id, result);
		// gone for good: whoever counts on this webhook (a Staff call) reads its row again
		if (REFUSED_FOR_GOOD.has(result.status)) invalidateWebhookCache(hook.orgId);
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
 * start, an AFK protection round every few minutes while a server seeds, a Weather cycle change every
 * few minutes all day, a Death whisper at nearly every death. The audit trail keeps each
 * one (a Death whisper only when it fails); Discord hears only of those that fail, so they neither
 * flood a staff channel nor push another rule's card out of the webhook's queue.
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
