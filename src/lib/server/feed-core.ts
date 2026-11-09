// The pure part of the kill feed: what the game POSTs to its feed Url ([WDServerFeed], or
// EventFeedEndpoints since Season 2; docs/wardogs-api.md) and how one batch becomes rows. No
// database, so it is unit-tested with plain objects; feed.ts adds what only the database knows
// (the open match, both factions) and writes.
import { mapId } from '$lib/format';

export const FEED_TOKEN_PREFIX = 'wkf_';
const FEED_TOKEN_RE = /^wkf_[A-Za-z0-9_-]{43}$/;
export const looksLikeFeedToken = (header: string | null | undefined): boolean =>
	!!header && /^Bearer\s+wkf_/i.test(header);
/** The feed token in an Authorization header when it is shaped like one of ours; else null. */
export function parseFeedBearer(header: string | null | undefined): string | null {
	const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
	return m && FEED_TOKEN_RE.test(m[1]) ? m[1] : null;
}

/**
 * The game never sent more than ten kills at once; a batch with this many is not the game. Only
 * kills count: the other events write no rows, so the body's size alone limits them and a burst
 * of joins cannot cost a batch its kills.
 */
export const MAX_BATCH = 200;
export const MAX_BODY_BYTES = 65536;

/**
 * A player joining or leaving, which Season 2 (CL-516586) sends beside kills (docs/wardogs-api.md).
 * Warcon reads who is on from the server's player list, so these are counted and not used.
 */
export const PRESENCE_EVENTS: ReadonlySet<string> = new Set(['player_joined', 'player_left']);

/** A `match_state` event: the state the match has moved to ($lib/match-state names them). */
export interface ParsedState {
	eventId: string;
	/** its place among the batch's events */
	seq: number;
	/** the match clock; null when the event does not say */
	eventTime: number | null;
	/** '' before the world has loaded: the game names no match until then */
	matchId: string;
	map: string;
	state: string;
}

/** A faction's final score as `match_ended` reports it. */
export interface FinalScore {
	name: string;
	score: number;
}

/** A `match_ended` event: the game's own result of the match. */
export interface ParsedEnd {
	eventId: string;
	/** its place among the batch's events */
	seq: number;
	/** the match clock; null when the event does not say */
	eventTime: number | null;
	matchId: string;
	map: string;
	/** who was on when it ended; null when the event does not say */
	players: number | null;
	/** `winningFaction` as the game sent it, '' when absent (what a tie sends is not known) */
	winningFaction: string;
	/** the winning faction when it is one of the scored ones; null otherwise */
	winner: string | null;
	/** every faction's final score, highest first */
	scores: FinalScore[];
}

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
	kills: ParsedKill[];
	/** in feed order */
	states: ParsedState[];
	ends: ParsedEnd[];
	/** events of a known type other than a kill: joins, leaves, match states and ends */
	other: number;
	/** events missing what Warcon reads from them, and events of a type Warcon does not know */
	skipped: number;
}

const STEAM_RE = /^\d{17}$/;
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const typeOf = (e: unknown): string =>
	e && typeof e === 'object' ? str((e as { type?: unknown }).type, 32) : '';

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

/** `MatchState` and its dotted sub-states, as Season 2 names them. */
const STATE_RE = /^MatchState(\.[A-Za-z0-9_]{1,40}){0,6}$/;

/** One `match_state` event, or null when it is not one or names no state. */
export function parseState(e: unknown, seq = 0): ParsedState | null {
	if (!e || typeof e !== 'object') return null;
	const o = e as Record<string, unknown>;
	if (o.type !== 'match_state') return null;
	const eventId = str(o.eventId, 64);
	const state = typeof o.state === 'string' ? o.state : '';
	if (!eventId || !STATE_RE.test(state)) return null;
	return {
		eventId,
		seq,
		eventTime: num(o.eventTime),
		matchId: str(o.matchId, 64),
		map: mapId(str(o.mapName, 64)),
		state
	};
}

/** Factions a scoreboard can hold; the game has three. */
const MAX_FACTIONS = 8;

/** One `match_ended` event, or null when it is not one or carries no scores. */
export function parseEnd(e: unknown, seq = 0): ParsedEnd | null {
	if (!e || typeof e !== 'object') return null;
	const o = e as Record<string, unknown>;
	if (o.type !== 'match_ended') return null;
	const eventId = str(o.eventId, 64);
	if (!eventId || !Array.isArray(o.factionScores)) return null;
	const scores: FinalScore[] = [];
	for (const f of o.factionScores as unknown[]) {
		if (!f || typeof f !== 'object') return null;
		const name = str((f as { faction?: unknown }).faction, 64);
		const score = num((f as { score?: unknown }).score);
		if (!name || score === null || scores.some((s) => s.name === name)) return null;
		scores.push({ name, score });
	}
	if (!scores.length || scores.length > MAX_FACTIONS) return null;
	scores.sort((a, b) => b.score - a.score);
	const winningFaction = str(o.winningFaction, 64);
	const players = num(o.players);
	return {
		eventId,
		seq,
		eventTime: num(o.eventTime),
		matchId: str(o.matchId, 64),
		map: mapId(str(o.mapName, 64)),
		players: players === null ? null : Math.max(0, Math.round(players)),
		winningFaction,
		winner: scores.some((s) => s.name === winningFaction) ? winningFaction : null,
		scores
	};
}

/** The whole body. Throws on a shape that is not a feed batch at all. */
export function parseBatch(body: unknown): ParsedBatch {
	if (!body || typeof body !== 'object' || !Array.isArray((body as { events?: unknown }).events))
		throw new Error('Expected { serverId, serverName, events: [] }.');
	const o = body as Record<string, unknown>;
	const kills: ParsedKill[] = [];
	const states: ParsedState[] = [];
	const ends: ParsedEnd[] = [];
	let other = 0;
	let skipped = 0;
	for (const [seq, e] of (o.events as unknown[]).entries()) {
		const type = typeOf(e);
		if (type === 'killed') {
			const k = parseKill(e);
			if (k) kills.push(k);
			else skipped++;
			continue;
		}
		const state = type === 'match_state' ? parseState(e, seq) : null;
		const end = type === 'match_ended' ? parseEnd(e, seq) : null;
		if (state) states.push(state);
		if (end) ends.push(end);
		if (state || end || PRESENCE_EVENTS.has(type)) other++;
		else skipped++;
	}
	if (kills.length > MAX_BATCH) throw new Error(`Too many kills in one batch (${kills.length}).`);
	return {
		instanceId: str(o.serverId, 64),
		serverName: str(o.serverName),
		kills,
		states,
		ends,
		other,
		skipped
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
