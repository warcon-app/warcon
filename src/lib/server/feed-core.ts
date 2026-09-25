// The pure part of the event feed: what the game POSTs to [WDServerFeed] Url (docs/wardogs-api.md)
// and how one batch becomes rows. No database, so it is unit-tested with plain objects; feed.ts
// adds what only the database knows (the open match, both factions) and writes.
import { mapId } from '$lib/format';
import { createHash } from 'node:crypto';

export const FEED_TOKEN_PREFIX = 'wkf_';
const FEED_TOKEN_RE = /^wkf_[A-Za-z0-9_-]{43}$/;
export const looksLikeFeedToken = (header: string | null | undefined): boolean =>
	!!header && /^Bearer\s+wkf_/i.test(header);
/** The feed token in an Authorization header when it is shaped like one of ours; else null. */
export function parseFeedBearer(header: string | null | undefined): string | null {
	const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
	return m && FEED_TOKEN_RE.test(m[1]) ? m[1] : null;
}

/** The game never sent more than ten; a batch this size is not the game. */
export const MAX_BATCH = 200;
export const MAX_BODY_BYTES = 65536;

export interface ParsedKill {
	eventId: string;
	matchId: string;
	eventTime: number;
	map: string;
	killerSteamId: string | null;
	killerName: string | null;
	victimSteamId: string;
	victimName: string;
	cause: string | null;
	distanceM: number | null;
	headshot: boolean;
	suicide: boolean;
	/** the other context tags, short form */
	tags: string[];
}

export interface ParsedBatch {
	instanceId: string;
	serverName: string;
	events: ParsedEvent[];
	kills: ParsedKill[];
	/** only malformed batch envelopes are refused; individual events are retained */
	skipped: number;
}

export interface ParsedEvent {
	eventId: string;
	eventType: string;
	eventTime: number | null;
	matchId: string;
	map: string;
	raw: unknown;
	kill: ParsedKill | null;
}

const STEAM_RE = /^\d{17}$/;
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const TAG_PREFIXES = [
	'Meta.Progression.Context.Player.KillContext.',
	'Meta.PlayerKillFlag.Player.'
];
/** Local.Kill and Local.Death are on every event and say nothing. */
const TAG_NOISE = new Set(['Local.Kill', 'Local.Death']);

/** Tags in short form: the known prefixes stripped, the two constant flags dropped. */
export function shortTags(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const t of raw) {
		if (typeof t !== 'string') continue;
		let s = t;
		for (const p of TAG_PREFIXES) if (s.startsWith(p)) s = s.slice(p.length);
		if (!TAG_NOISE.has(s) && !out.includes(s)) out.push(s.slice(0, 60));
	}
	return out;
}

/** One `killed` event as a row's worth of fields, or null when it lacks what a row needs. */
export function parseKill(e: unknown): ParsedKill | null {
	if (!e || typeof e !== 'object') return null;
	const o = e as Record<string, unknown>;
	if (o.type !== 'killed') return null;
	const eventId = str(o.eventId, 64);
	const victimSteamId = str(o.victimSteamId, 17);
	const eventTime = num(o.eventTime);
	if (!eventId || !STEAM_RE.test(victimSteamId) || eventTime === null) return null;
	const killerSteamId = str(o.killerSteamId, 17);
	const tags = shortTags(o.contextTags);
	const headshot = tags.includes('Headshot');
	const suicide = tags.includes('Suicide') || (!!killerSteamId && killerSteamId === victimSteamId);
	const distance = num(o.distance);
	return {
		eventId,
		matchId: str(o.matchId, 64),
		eventTime,
		map: mapId(str(o.mapName, 64)),
		killerSteamId: STEAM_RE.test(killerSteamId) ? killerSteamId : null,
		killerName: STEAM_RE.test(killerSteamId) ? str(o.killerName) : null,
		victimSteamId,
		victimName: str(o.victimName),
		cause: str(o.cause, 200) || null,
		// Unreal units are centimetres.
		distanceM: distance === null ? null : Math.round(distance) / 100,
		headshot,
		suicide,
		tags: tags.filter((t) => t !== 'Headshot' && t !== 'Suicide')
	};
}

/** The whole body. Throws on a shape that is not a feed batch at all. */
export function parseBatch(body: unknown): ParsedBatch {
	if (!body || typeof body !== 'object' || !Array.isArray((body as { events?: unknown }).events))
		throw new Error('Expected { serverId, serverName, events: [] }.');
	const o = body as Record<string, unknown>;
	const events = o.events as unknown[];
	if (events.length > MAX_BATCH)
		throw new Error(`Too many events in one batch (${events.length}).`);
	const instanceId = str(o.serverId, 64);
	const parsed = events.map((raw, index): ParsedEvent => {
		const e = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
		const kill = parseKill(raw);
		// A malformed or future event may lack an eventId. Give it a stable id so a retried batch
		// does not write it twice; the full original event is still retained.
		const eventId =
			str(e.eventId, 64) ||
			createHash('sha256')
				.update(JSON.stringify([instanceId, index, raw ?? null]))
				.digest('hex');
		return {
			eventId,
			eventType: str(e.type, 64) || 'unknown',
			eventTime: num(e.eventTime),
			matchId: str(e.matchId, 64),
			map: str(e.mapName, 64),
			raw: raw ?? null,
			kill
		};
	});
	return {
		instanceId,
		serverName: str(o.serverName),
		events: parsed,
		kills: parsed.flatMap((e) => (e.kill ? [e.kill] : [])),
		skipped: 0
	};
}

/** Same faction on both sides, both known, and not a suicide. */
export const isTeamKill = (
	k: Pick<ParsedKill, 'killerSteamId' | 'victimSteamId'>,
	killerFaction: string | null,
	victimFaction: string | null
): boolean =>
	!!killerFaction &&
	killerFaction === victimFaction &&
	k.killerSteamId !== null &&
	k.killerSteamId !== k.victimSteamId;
