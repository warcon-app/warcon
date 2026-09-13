// What a Discord status board says: one embed per server from the worker's live view, the same
// numbers the server page shows, shaped for Discord's limits (ten embeds, 6000 characters in all,
// 1024 per field). Pure, so it is tested without a database; board-delivery.ts posts the result.
import { COLORS, type Embed } from './webhook-delivery';
import { expSetLabel, fmtInterval, lightingLabel, mapName, zoneLabel } from '$lib/format';
import { cashByFaction, fmtCash } from '$lib/cash';
import type { Catalog, LiveView, Player, Status } from '$lib/types';

export interface BoardServer {
	id: string;
	name: string;
	/** null until the worker has looked at the server once */
	live: LiveView | null;
}

export interface BoardPayload {
	content: string;
	embeds: Embed[];
}

/** Discord: ten embeds per message, 6000 characters across all of them, 1024 per field value. */
export const BOARD_MAX_EMBEDS = 10;
const EMBED_BUDGET = 5900;
const FIELD_MAX = 1024;
const CONTENT_MAX = 2000;

/** The worker has no catalog at hand; the labels fall back to the ids, prettified. */
const NO_CATALOG: Catalog = { maps: [], lightings: [], experiences: [] };

const num = (n: number): string => Math.round(n).toLocaleString('en-US');
/** Discord renders `<t:…:R>` as "3 minutes ago" and keeps it ticking between edits. */
const rel = (ms: number): string => `<t:${Math.floor(ms / 1000)}:R>`;
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const known = (label: string): string => (label === '—' ? '' : label);

interface Draft {
	embed: Embed;
	/** player lists, sized to fit at the end */
	fields: { name: string; players: string[] }[];
}

/** One field per faction, in the order the scoreboard lists them; players without one at the end. */
function playerFields(status: Status, players: Player[]): Draft['fields'] {
	const cash = new Map(cashByFaction(status, players).map((c) => [c.name, c.cash]));
	const groups = new Map<string, Player[]>(status.scores.map((f) => [f.name, []]));
	for (const p of players) {
		const key = p.faction || '';
		let list = groups.get(key);
		if (!list) groups.set(key, (list = []));
		list.push(p);
	}
	const out: Draft['fields'] = [];
	for (const [faction, list] of groups) {
		if (!list.length) continue;
		list.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
		out.push({
			name: clip(
				`${faction || 'Unassigned'} · ${list.length} · ${fmtCash(cash.get(faction) ?? 0)}`,
				256
			),
			players: list.map((p) => `${clip(p.name, 32)} ${p.kills}/${p.deaths}`)
		});
	}
	return out;
}

/** "a, b, c, +4 more" within `cap` characters. */
function fieldValue(players: string[], cap: number): string {
	const shown: string[] = [];
	let length = 0;
	for (const p of players) {
		const add = p.length + (shown.length ? 2 : 0);
		if (length + add > cap - 10) break; // room for ", +NN more"
		shown.push(p);
		length += add;
	}
	if (!shown.length) return `${players.length} players`;
	const rest = players.length - shown.length;
	return rest ? `${shown.join(', ')}, +${rest} more` : shown.join(', ');
}

function serverDraft(s: BoardServer, showPlayers: boolean, footer: string, now: number): Draft {
	const base = { timestamp: new Date(now).toISOString(), footer: { text: footer } };
	const live = s.live;
	const status = live?.status ?? null;
	if (!live || !live.observedAt)
		return {
			embed: {
				title: `⚪ ${s.name}`,
				description: 'Not observed yet.',
				color: COLORS.denied,
				...base
			},
			fields: []
		};
	if (!live.ok) {
		const lines = [`**Unreachable.** ${live.error || 'No answer from the server.'}`];
		if (status && live.statusAt)
			lines.push(
				`Last seen ${rel(Date.parse(live.statusAt))} with ${num(status.playerCount)} on ${mapName(status.map)}.`
			);
		return {
			embed: {
				title: `🔴 ${s.name}`,
				description: clip(lines.join('\n'), 2000),
				color: COLORS.error,
				...base
			},
			fields: []
		};
	}
	if (!status)
		return {
			embed: {
				title: `⚪ ${s.name}`,
				description: 'Waiting for the first status read.',
				color: COLORS.denied,
				...base
			},
			fields: []
		};
	const lines: string[] = [];
	if (status.serverName && status.serverName.trim().toLowerCase() !== s.name.trim().toLowerCase())
		lines.push(`**Server** ${clip(status.serverName, 80)}`);
	lines.push(`**Players** ${num(status.playerCount)} / ${num(status.maxPlayers)}`);
	lines.push(
		`**Map** ${[
			mapName(status.map),
			known(expSetLabel(NO_CATALOG, status.experiences)),
			known(lightingLabel(NO_CATALOG, status.lighting))
		]
			.filter(Boolean)
			.join(' · ')}`
	);
	const zone = zoneLabel(status.alternator);
	if (zone !== 'Default') lines.push(`**Control zone** ${zone}`);
	if (status.matchSeconds !== null && live.statusAt)
		lines.push(`**Match** started ${rel(Date.parse(live.statusAt) - status.matchSeconds * 1000)}`);
	if (status.scores.length)
		lines.push(
			`**Score** ${status.scores.map((f) => `${f.name} **${num(f.score)}**`).join(' · ')}${status.scoreCap ? ` · cap ${num(status.scoreCap)}` : ''}`
		);
	return {
		embed: {
			title: `🟢 ${s.name}`,
			description: clip(lines.join('\n'), 2000),
			color: COLORS.ok,
			...base
		},
		fields: showPlayers ? playerFields(status, live.players) : []
	};
}

const size = (e: Embed): number =>
	e.title.length +
	e.description.length +
	(e.footer?.text.length ?? 0) +
	(e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);

/** Shortens every player list by the same factor until the embeds fit Discord's total. */
function fit(drafts: Draft[]): Embed[] {
	let cap = FIELD_MAX;
	for (;;) {
		const embeds = drafts.map(({ embed, fields }) =>
			fields.length
				? {
						...embed,
						fields: fields.map((f) => ({
							name: f.name,
							value: fieldValue(f.players, cap),
							inline: true
						}))
					}
				: embed
		);
		if (embeds.reduce((n, e) => n + size(e), 0) <= EMBED_BUDGET || cap <= 24) return embeds;
		cap = Math.floor(cap * 0.7);
	}
}

/** The message for a board: the heading, then one embed per server (the first ten). */
export function renderBoard(opts: {
	appName: string;
	heading: string;
	intervalMs: number;
	showPlayers: boolean;
	servers: BoardServer[];
	now?: number;
}): BoardPayload {
	const now = opts.now ?? Date.now();
	const footer = `${opts.appName} · updated every ${fmtInterval(opts.intervalMs)}`;
	const shown = opts.servers.slice(0, BOARD_MAX_EMBEDS);
	const drafts: Draft[] = shown.length
		? shown.map((s) => serverDraft(s, opts.showPlayers, footer, now))
		: [
				{
					embed: {
						title: 'No servers',
						description: 'This board has no servers to show.',
						color: COLORS.denied,
						timestamp: new Date(now).toISOString(),
						footer: { text: footer }
					},
					fields: []
				}
			];
	const lines = [opts.heading.trim()];
	const more = opts.servers.length - shown.length;
	if (more > 0)
		lines.push(
			`${more} more server${more === 1 ? '' : 's'} not shown: a message holds ${BOARD_MAX_EMBEDS}.`
		);
	return { content: clip(lines.filter(Boolean).join('\n'), CONTENT_MAX), embeds: fit(drafts) };
}
