// The live status message a webhook keeps per server: one embed built from the worker's latest
// look and edited in place by webhook-status.ts. The card is the wide map art under three
// faction columns of players, a ten-square score bar per faction and a player bar in the text.
// This module is pure so the layout is testable; it also derives the key that says whether the
// substance changed since the last edit (Discord renders the relative clock itself, so the
// clocks are not part of it) and keeps every part inside Discord's length limits.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FactionScore, LiveView, Player } from '$lib/types';
import { factionColor, fmtDuration, isMod, mapName, prettify, zoneLabel } from '$lib/format';
import { mapArtCandidates } from '$lib/map-art';
import { RESTART_AFTER_HOURS, restartWindow } from '$lib/uptime';
import { scoreCapOf } from '$lib/match';
import type { StatusStyle } from '$lib/status-styles';
import type { FeatureSet } from '$lib/features';
import type { DiscordPayload, Embed, EmbedField } from './webhook-delivery';

export interface StatusServer {
	id: string;
	name: string;
}
export interface StatusOptions {
	appName: string;
	/** shown as the author line above the title */
	orgName: string;
	/** the panel's public URL: server links and, when it is https, map art and the icon */
	origin: string;
	now: number;
	/** banner unless told otherwise; see $lib/status-styles */
	style?: StatusStyle;
	/** the title points at the first; the rest follow as a line under the body; none = no link */
	links?: CardLink[];
}

export interface CardLink {
	label: string;
	url: string;
}
/** The webhook's three switches for what the card links to. */
export interface LinkFlags {
	linkStatus: boolean;
	linkLeaderboard: boolean;
	linkMatches: boolean;
	linkPanel: boolean;
}

/** Seconds between edits of one card: the floor, the ceiling and what a new webhook gets. */
export const STATUS_INTERVAL = { min: 30, max: 300, default: 60 } as const;

/** A requested interval as seconds inside the bounds; anything unreadable is the default. */
export function clampInterval(v: unknown): number {
	if (v === undefined || v === null || v === '') return STATUS_INTERVAL.default;
	const n = Number(v);
	if (!Number.isFinite(n)) return STATUS_INTERVAL.default;
	return Math.min(STATUS_INTERVAL.max, Math.max(STATUS_INTERVAL.min, Math.round(n)));
}

/**
 * The links a card carries, in order: a public page only while it is on for the server (a
 * link into the sign-in wall helps nobody), the panel whenever asked for.
 */
export function cardLinks(
	origin: string,
	serverId: string,
	flags: LinkFlags,
	features: FeatureSet
): CardLink[] {
	const id = encodeURIComponent(serverId);
	const out: CardLink[] = [];
	if (flags.linkStatus && features.status)
		out.push({ label: 'Live status', url: `${origin}/s/${id}` });
	if (flags.linkLeaderboard && features.leaderboards)
		out.push({ label: 'Leaderboard', url: `${origin}/s/${id}/leaderboard` });
	if (flags.linkMatches && features.matches)
		out.push({ label: 'Matches', url: `${origin}/s/${id}/matches` });
	if (flags.linkPanel) out.push({ label: 'Panel', url: `${origin}/server/${id}` });
	return out;
}

/** The title points at the first link; the others join the body as a last line. */
function applyLinks(e: Embed, links: CardLink[]): Embed {
	const { url: _url, ...rest } = e;
	void _url;
	const more = links.slice(1);
	if (!more.length) return links.length ? { ...rest, url: links[0].url } : rest;
	const line = more.map((l) => `[${l.label}](${l.url})`).join(' · ');
	const body = clip(e.description ?? '', LIMITS.description - line.length - 1);
	return { ...rest, url: links[0].url, description: body ? `${body}\n${line}` : line };
}

/** Discord's limits: per field value, per description, and across one message. */
export const LIMITS = { field: 1024, description: 4096, message: 6000, fields: 25 } as const;
const COLORS = { busy: 0x7bc462, empty: 0x8a8a90, down: 0xd86060 } as const;
const PLAYER_BAR = 16;
const SCORE_BAR = 10;
const BOLD_TOP = 2;
/** rows in the scoreboard style's table */
const TABLE_ROWS = 20;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const relative = (iso: string) => `<t:${Math.floor(Date.parse(iso) / 1000)}:R>`;

/** Player and faction names carry no markdown, mentions or timestamps into the channel. */
export const escapeMarkdown = (s: string): string => s.replace(/([\\`*_~|<>[\]])/g, '\\$1');

/** "King of the Hill + Infantry" from the experience ids, as the dashboard shows them. */
export function modeLabel(experiences: string[] | null | undefined): string {
	const list = experiences || [];
	const mode = list.find((id) => !isMod(id));
	return [
		mode ? (/koth/i.test(mode) ? 'King of the Hill' : prettify(mode)) : null,
		...list.filter(isMod).map((id) => prettify(id.replace(/^KOTH_/i, '')))
	]
		.filter(Boolean)
		.join(' + ');
}

const SQUARES = {
	red: '🟥',
	orange: '🟧',
	yellow: '🟨',
	green: '🟩',
	blue: '🟦',
	purple: '🟪',
	brown: '🟫',
	white: '⬜'
} as const;
const BY_NAME: Record<string, string> = { RED: SQUARES.red, BLU: SQUARES.blue, GRN: SQUARES.green };
const BY_INDEX = [SQUARES.red, SQUARES.blue, SQUARES.green, SQUARES.yellow, SQUARES.purple];

/** The coloured square nearest a faction's colour: text in an embed cannot be coloured itself. */
export function squareFor(colorHex: string | null | undefined, name: string, index = 0): string {
	const m = /^#?([0-9a-f]{6})$/i.exec((colorHex || '').trim());
	if (!m) return BY_NAME[name] || BY_INDEX[index % BY_INDEX.length];
	const n = parseInt(m[1], 16);
	const r = ((n >> 16) & 255) / 255;
	const g = ((n >> 8) & 255) / 255;
	const b = (n & 255) / 255;
	const max = Math.max(r, g, b);
	const min = Math.min(r, g, b);
	const l = (max + min) / 2;
	const d = max - min;
	if (d < 0.12) return SQUARES.white;
	let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
	h = (((h * 60) % 360) + 360) % 360;
	if (h < 15 || h >= 340) return SQUARES.red;
	if (h < 45) return l < 0.35 ? SQUARES.brown : SQUARES.orange;
	if (h < 70) return SQUARES.yellow;
	if (h < 170) return SQUARES.green;
	if (h < 260) return SQUARES.blue;
	return SQUARES.purple;
}

/** Where the static files are: next to the built app in a container, the source tree in dev. */
const STATIC_ROOTS = ['build/client', 'static'].map((d) => resolve(process.cwd(), d));
const artSeen = new Map<string, boolean>();

/**
 * The first candidate art URL whose file is actually there. Discord fetches one URL and shows
 * nothing on a miss, so unlike the page this cannot fall through on error. Without a static
 * folder to check (an unusual working directory) the best guess goes out.
 */
export function firstArt(candidates: string[]): string | null {
	if (!candidates.length) return null;
	const roots = STATIC_ROOTS.filter((r) => existsSync(r));
	if (!roots.length) return candidates[0];
	for (const c of candidates) {
		let hit = artSeen.get(c);
		if (hit === undefined) {
			hit = roots.some((r) => existsSync(resolve(r, '.' + decodeURIComponent(c))));
			artSeen.set(c, hit);
		}
		if (hit) return c;
	}
	return null;
}

const bar = (filled: number, total: number, on: string, off: string) =>
	on.repeat(filled) + off.repeat(total - filled);

/** Lines into a field value under Discord's cap, closing with how many were left out. */
export function fitLines(lines: string[], max: number = LIMITS.field): string {
	if (!lines.length) return '—';
	let kept = lines.length;
	const text = (n: number) => {
		const rest = lines.length - n;
		return [...lines.slice(0, n), ...(rest ? [`and ${rest} more`] : [])].join('\n');
	};
	while (kept > 0 && text(kept).length > max) kept--;
	return kept ? text(kept) : clip(`and ${lines.length} more`, max);
}

const playerLine = (p: Player, bold: boolean) => {
	const name = escapeMarkdown(p.name);
	return `${bold ? `**${name}**` : name} ${p.kills}/${p.deaths}`;
};
const byKills = (a: Player, b: Player) => b.kills - a.kills || a.deaths - b.deaths;

/** The faction fields, leader first, plus one for anyone the server did not place. */
export function factionFields(scores: FactionScore[], players: Player[]): EmbedField[] {
	const ranked = scores.map((f, i) => ({ f, i })).sort((a, b) => b.f.score - a.f.score);
	const named = new Set(scores.map((f) => f.name));
	const fields: EmbedField[] = ranked.map(({ f, i }) => {
		const mine = players.filter((p) => p.faction === f.name).sort(byKills);
		return {
			name: clip(`${squareFor(f.colorHex, f.name, i)} ${f.name} · ${mine.length}`, 256),
			value: fitLines(mine.map((p, n) => playerLine(p, n < BOLD_TOP))),
			inline: true
		};
	});
	const loose = players.filter((p) => !p.faction || !named.has(p.faction)).sort(byKills);
	if (loose.length)
		fields.push({
			name: scores.length ? `Unassigned · ${loose.length}` : `Online · ${loose.length}`,
			value: fitLines(loose.map((p, n) => playerLine(p, n < BOLD_TOP))),
			inline: false
		});
	return fields.slice(0, LIMITS.fields - 1);
}

/** Characters Discord counts against the 6000 per message. */
export function embedLength(e: Embed): number {
	return (
		(e.title?.length ?? 0) +
		(e.description?.length ?? 0) +
		(e.author?.name.length ?? 0) +
		(e.footer?.text.length ?? 0) +
		(e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0)
	);
}

/** Trims the longest field, a line at a time, until the whole embed fits one message. */
export function fitEmbed(e: Embed): Embed {
	if (!e.fields) return e;
	let fields = e.fields;
	while (embedLength({ ...e, fields }) > LIMITS.message) {
		const longest = fields.reduce((a, f) => (f.value.length > a.value.length ? f : a), fields[0]);
		if (!longest || longest.value.length < 40) break;
		const lines = longest.value.split('\n').filter((l) => !/^and \d+ more$/.test(l));
		const shorter = fitLines(lines, Math.floor(longest.value.length * 0.7));
		fields = fields.map((f) => (f === longest ? { ...f, value: shorter } : f));
	}
	return { ...e, fields };
}

export function buildStatusEmbed(
	opts: StatusOptions,
	server: StatusServer,
	live: LiveView | null
): Embed {
	return fitEmbed(applyLinks(buildBody(opts, server, live), opts.links ?? []));
}

function buildBody(opts: StatusOptions, server: StatusServer, live: LiveView | null): Embed {
	const https = opts.origin.startsWith('https://');
	const base: Embed = {
		title: clip(server.name, 200),
		description: '',
		color: COLORS.empty,
		timestamp: new Date(opts.now).toISOString(),
		author: {
			name: clip(opts.orgName, 200),
			...(https ? { icon_url: `${opts.origin}/icon-192.png` } : {})
		},
		footer: { text: opts.appName }
	};
	// The join code (GET /v1/server-id, CL-501228+) as a code block: Discord gives those a copy
	// button on hover (desktop) and copy on long-press (mobile), the nearest thing to click-to-copy.
	const joinCode: EmbedField[] = live?.gameServerId
		? [{ name: 'Join code', value: '```\n' + live.gameServerId + '\n```' }]
		: [];
	if (!live || !live.observedAt) return { ...base, description: '⚪ Waiting for the first look.' };
	const s = live.status;
	const art = (variant: 'wide' | 'square') => {
		if (!https || !s) return null;
		const path = firstArt(mapArtCandidates(s.map, s.lighting, variant));
		return path ? opts.origin + path : null;
	};
	if (!live.ok || !s) {
		const lines = ['🔴 **Unreachable**'];
		if (live.error) lines.push(clip(live.error, 200));
		if (live.statusAt) lines.push(`Last seen ${relative(live.statusAt)}`);
		lines.push(`Checked ${relative(live.observedAt)}`);
		const thumb = art('square');
		return {
			...base,
			description: lines.join('\n'),
			color: COLORS.down,
			timestamp: live.observedAt,
			...(joinCode.length ? { fields: joinCode } : {}),
			...(thumb ? { thumbnail: { url: thumb } } : {})
		};
	}
	const busy = s.playerCount > 0;
	const style = opts.style ?? 'banner';
	// The bar down the side follows the leading faction while people are playing; the emoji on the
	// first line still says online, empty or down.
	const ranked = s.scores.map((f, i) => ({ f, i })).sort((a, b) => b.f.score - a.f.score);
	const leader = busy && ranked.length ? ranked[0].f : null;
	const color = leader
		? parseInt(factionColor(leader.name, s.scores).slice(1), 16)
		: busy
			? COLORS.busy
			: COLORS.empty;
	const filled = s.maxPlayers > 0 ? Math.round((s.playerCount / s.maxPlayers) * PLAYER_BAR) : 0;
	// The server's cap is its public slots; MaxReservedSlots holds more back for reserved players.
	const held = live.reservedSlots ? ` +${live.reservedSlots} reserved` : '';
	const online = `${busy ? '🟢' : '⚪'} **${s.playerCount} / ${s.maxPlayers}**${held} online  ${bar(Math.min(PLAYER_BAR, Math.max(0, filled)), PLAYER_BAR, '▰', '▱')}`;
	const zone = zoneLabel(s.alternator);
	const where = [
		`**${mapName(s.map)}**`,
		prettify(s.lighting) || null,
		modeLabel(s.experiences) || null,
		zone === 'Default' ? null : zone
	]
		.filter(Boolean)
		.join(' · ');
	// Live builds send no cap; the game's default keeps the bars on the same scale as the overview.
	const cap = scoreCapOf(s);
	const scoreRows = ranked.map(({ f, i }) => {
		const n = Math.min(SCORE_BAR, Math.max(0, Math.round((f.score / cap) * SCORE_BAR)));
		return `${bar(n, SCORE_BAR, squareFor(f.colorHex, f.name, i), '⬛')} **${f.score}** ${escapeMarkdown(f.name)}`;
	});
	const scoreLine = ranked
		.map(
			({ f, i }) => `${squareFor(f.colorHex, f.name, i)} ${escapeMarkdown(f.name)} **${f.score}**`
		)
		.join(' · ');
	// Cap and clock belong to a match, which the scores say exists.
	const match = s.scores.length
		? [`First to ${cap}`, s.matchSeconds === null ? null : `${fmtDuration(s.matchSeconds)} played`]
				.filter(Boolean)
				.join(' · ')
		: '';
	const observedAt = live.observedAt;
	// Discord renders "9 hours ago" itself, so the uptime line needs no edit to stay right; the
	// restart note flips once, when the threshold passes.
	const restart = restartWindow(live.startedAt, RESTART_AFTER_HOURS, opts.now);
	const upLine = restart
		? `Up since ${relative(live.startedAt!)}${restart.due ? ' · 🔁 Restarts after this round' : ''}\n`
		: '';
	const stamp = (prefix = '') => ({
		name: '\u200b',
		value: `${upLine}${prefix}Updated ${relative(observedAt)}`
	});
	const players = live.players;
	const thumb = art('square');
	const withThumb = thumb ? { thumbnail: { url: thumb } } : {};
	const common = { ...base, color, timestamp: live.observedAt };

	if (style === 'compact') {
		const top = [...players].sort(byKills).slice(0, 3);
		const counts: EmbedField[] = ranked.map(({ f, i }) => ({
			name: clip(`${squareFor(f.colorHex, f.name, i)} ${f.name}`, 256),
			value: `${players.filter((p) => p.faction === f.name).length} players`,
			inline: true
		}));
		const topLine = top.length
			? `Top: ${top.map((p) => `**${escapeMarkdown(p.name)}** ${p.kills}/${p.deaths}`).join(' · ')}\n`
			: '';
		return fitEmbed({
			...common,
			description: clip(
				[online, where, s.scores.length ? scoreLine : null, match || null]
					.filter(Boolean)
					.join('\n'),
				LIMITS.description
			),
			fields: [...counts, ...joinCode, stamp(topLine)],
			...withThumb
		});
	}

	if (style === 'scoreboard') {
		const rows = [...players].sort(byKills);
		const shown = rows.slice(0, TABLE_ROWS);
		const cell = (v: string, w: number) => clip(v.replace(/`/g, "'"), w).padEnd(w);
		const table = [
			' K   D   Player            Faction',
			...shown.map(
				(p) =>
					`${String(p.kills).padStart(2)}  ${String(p.deaths).padStart(2)}   ${cell(p.name, 17)} ${clip(p.faction ?? '—', 10)}`
			)
		].join('\n');
		const fields: EmbedField[] = rows.length
			? [{ name: 'Scoreboard', value: fitLines(['```', ...table.split('\n'), '```']) }]
			: [];
		const shownNote = rows.length > shown.length ? `Top ${shown.length} of ${rows.length} · ` : '';
		return fitEmbed({
			...common,
			description: clip(
				[...scoreRows, match || null, online, where].filter(Boolean).join('\n'),
				LIMITS.description
			),
			fields: [...fields, ...joinCode, stamp(shownNote)],
			...withThumb
		});
	}

	const image = art('wide');
	// The clock goes under the columns, the last slot before the art: a footer cannot render one.
	return fitEmbed({
		...common,
		description: clip(
			[online, where, ...scoreRows, match || null].filter(Boolean).join('\n'),
			LIMITS.description
		),
		fields: [...(players.length ? factionFields(s.scores, players) : []), ...joinCode, stamp()],
		...(image ? { image: { url: image } } : {})
	});
}

/** What an edit is for: everything shown except the clocks. */
function substance(server: StatusServer, live: LiveView | null, now: number): unknown {
	if (!live || !live.observedAt) return [server.id, server.name, 'waiting'];
	if (!live.ok || !live.status)
		return [server.id, server.name, 'down', live.error, live.gameServerId];
	const s = live.status;
	const restart = restartWindow(live.startedAt, RESTART_AFTER_HOURS, now);
	return [
		server.id,
		server.name,
		live.gameServerId,
		// the start time itself (a restart is a new card), and whether the restart note shows
		restart ? [live.startedAt, restart.due] : null,
		s.playerCount,
		s.maxPlayers,
		s.map,
		s.lighting,
		s.experiences,
		s.alternator,
		s.scoreCap,
		s.scores.map((f) => [f.name, f.score]),
		live.players.map((p) => [p.name, p.faction, p.kills, p.deaths])
	];
}

export interface StatusMessage {
	payload: DiscordPayload;
	key: string;
}

/** The message for one server, and its change key. */
export function statusMessage(
	opts: StatusOptions,
	server: StatusServer,
	live: LiveView | null
): StatusMessage {
	return {
		payload: { content: '', embeds: [buildStatusEmbed(opts, server, live)] },
		key: JSON.stringify([
			opts.style ?? 'banner',
			(opts.links ?? []).map((l) => l.url),
			substance(server, live, opts.now)
		])
	};
}
