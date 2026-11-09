// The Rotation shuffle rule. An Ordered rotation of every map, time of day and control zone starts
// from the top at each game start, so a server plays the same few entries every day; a Random one
// can put a map on several times in a row. Live builds change the rotation only through the config
// document, so the rule writes it in a new order once a run: in the last round before the server's
// next restart ($lib/uptime: daily at a time UTC, or 24 hours up) where it can see that coming, so
// the server comes back up on it, otherwise right after the restart; and once when the rule is saved. The maps take turns in the rule's order and each map's
// control zones take turns ($lib/rotation-doc). Where a server goes next once its order changes has
// not been seen, so the new order starts with the map after the one on and puts the entry on last
// (a server that stays on its entry, or goes back to the top, then goes on from the top), is read
// back, and is turned once more if the server does not have the map after the one on next.
import { ApiError, str } from './http';
import { ACTIONS, configResult, readConfig } from './actions';
import { classifyGameError, GameError, type WardogsClient } from './rcon';
import {
	alignRotation,
	entryKey,
	rotationFromText,
	rotationIntoText,
	shuffleFor,
	turnOf,
	type RotationDoc
} from '../rotation-doc';
import { mapName } from '../format';
import type { MapSelection } from '../types';

/** The outbox action that shuffles a server's rotation (not in ACTIONS). */
export const ROTATION_SHUFFLE = 'rotation_shuffle';

export interface RotationShuffleConfig {
	/** map ids in the order they take turns; a map the rotation has and this leaves out follows */
	maps: string[];
}

const MAP_ID = /^[A-Za-z0-9_.-]{1,100}$/;

export function validateRotationShuffle(raw: unknown): RotationShuffleConfig {
	const c = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const maps: string[] = [];
	for (const m of Array.isArray(c.maps) ? c.maps : []) {
		const id = str(m, 100);
		if (MAP_ID.test(id) && !maps.some((x) => x.toLowerCase() === id.toLowerCase())) maps.push(id);
	}
	return { maps: maps.slice(0, 20) };
}

export interface RotationShuffleState {
	/** when the game started (ms) in the run the last shuffle was made in */
	boot: number;
	/** made in that run's last round, for the next run to start on */
	forNext: boolean;
	/** when the run that came up on that order started; 0 until one has */
	spentBy: number;
}

/** A state the rule wrote, or null for anything else (a rule switched on again has none). */
export function rotationShuffleState(v: unknown): RotationShuffleState | null {
	if (!v || typeof v !== 'object') return null;
	const s = v as Record<string, unknown>;
	const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
	if (!n(s.boot)) return null;
	return { boot: n(s.boot), forNext: s.forNext === true, spentBy: n(s.spentBy) };
}

export type ShuffleWhen = 'now' | 'before-restart' | 'after-restart';

/** The start is worked out from the uptime at each look, so it moves by the look's latency. */
const SAME_RUN_MS = 60_000;

/**
 * One look at the server: whether to shuffle, and the state to keep (null: nothing changes). A rule
 * with no state (new, or switched on again) shuffles at once. After that, once a run: when the
 * next restart is due (the round on is the last), for the next run to start on; or after a
 * restart that no shuffle was made for (one the rule could not see coming, or a second one in a
 * row), for the rest of that run. Nothing while the start is unknown.
 */
export function shuffleStep(
	prev: RotationShuffleState | null,
	look: { startedAt: number; restartDue: boolean }
): { state: RotationShuffleState; when: ShuffleWhen | null } | null {
	const start = look.startedAt;
	if (!start) return null;
	const same = (t: number) => Math.abs(t - start) <= SAME_RUN_MS;
	const made = (when: ShuffleWhen) => ({
		state: { boot: start, forNext: look.restartDue, spentBy: 0 },
		when: look.restartDue ? ('before-restart' as const) : when
	});
	if (!prev) return made('now');
	if (same(prev.boot)) return look.restartDue && !prev.forNext ? made('before-restart') : null;
	// A later run. One that came up on the order made for it keeps it until its own restart.
	if (prev.forNext && (!prev.spentBy || same(prev.spentBy))) {
		if (look.restartDue) return made('before-restart');
		return prev.spentBy ? null : { state: { ...prev, spentBy: start }, when: null };
	}
	return made('after-restart');
}

interface LiveRotation {
	enabled: boolean;
	nowIndex: number;
	nextIndex: number;
	entries: MapSelection[];
}

const readLive = (client: WardogsClient) =>
	ACTIONS.rotation.run(client, {}) as Promise<LiveRotation>;

/**
 * The rotation in the config document rewritten by `order` (given the rotation the document holds;
 * null leaves it as it is), against the revision read, once more on a revision conflict. Only the
 * rotation's keys change, and the mode becomes Ordered. The document's text never leaves here.
 */
async function rewrite(
	client: WardogsClient,
	order: (rotation: RotationDoc) => MapSelection[] | null
): Promise<MapSelection[] | null> {
	for (let attempt = 0; ; attempt++) {
		const doc = await readConfig(client);
		if (!doc.writable)
			throw new ApiError(
				409,
				'The config document is read-only on this server, so its rotation cannot be changed from the panel.'
			);
		const rotation = rotationFromText(doc.text);
		const entries = order(rotation);
		if (!entries) return null;
		const text = rotationIntoText(doc.text, { ...rotation, mode: 'ordered', entries });
		const { status, body, etag } = await client.configCall('PUT', '/v1/config', text, doc.revision);
		const r = configResult(status, body, etag);
		if (r.ok) return entries;
		if (r.conflict && !attempt) continue;
		// Kept to its status and code: a refused document's own words can quote the file.
		const e = r.conflict
			? new GameError(412, '', 'revision_conflict')
			: classifyGameError('PUT', '/v1/config', status, '', body);
		const refused = new GameError(e.status, 'The server did not take the new rotation.', e.code);
		refused.retryAfterMs = e.retryAfterMs;
		throw refused;
	}
}

/** What the server says comes next, when it plays `written` (null when it shows another order). */
async function nextOf(client: WardogsClient, written: MapSelection[]) {
	const back = await readLive(client).catch(() => null);
	if (
		!back ||
		back.entries.length !== written.length ||
		back.entries.some((e, i) => entryKey(e) !== entryKey(written[i]))
	)
		return null;
	return { index: back.nextIndex, entry: back.entries[back.nextIndex] ?? null };
}

/**
 * The shuffle, at delivery: the rotation in the document put in a new order (maps in the rule's
 * turn, each map's zones in turn) for the entry on. Before the restart, the server comes back up on
 * the top of it; otherwise what the server has next is read back, and set right once if it is not
 * the map after the one on. The result names counts and maps only.
 */
export async function shuffleOnServer(
	client: WardogsClient,
	params: Record<string, unknown>
): Promise<{ message: string; retryAfterMs?: number }> {
	const before = params.when === 'before-restart';
	const { maps } = validateRotationShuffle(params);
	const live = await readLive(client);
	const now = live.nowIndex >= 0 ? live.nowIndex : -1;
	const playing = live.entries[now]?.map || str(params.playing, 100);
	const on: MapSelection | null =
		live.entries[now] ??
		(playing ? { map: playing, experiences: [], lighting: '', zoneAlternator: '' } : null);
	let skipped = '';
	let turn: string[] = [];
	const written = await rewrite(client, ({ enabled, entries }) => {
		skipped = !enabled
			? 'Nothing shuffled: the rotation is switched off on this server.'
			: entries.length < 2
				? 'Nothing to shuffle: the rotation has fewer than two entries.'
				: '';
		turn = turnOf(entries, maps);
		return skipped ? null : shuffleFor(entries, maps, on);
	});
	if (!written) return { message: skipped };
	const head = `Shuffled ${written.length} entries: ${turn.map(mapName).join(', ')} in turn`;
	if (before)
		return { message: `${head}, starting on ${mapName(written[0].map)} after the restart.` };
	const same = (a: string, b: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
	const at = turn.findIndex((m) => same(m, playing));
	const follows = at < 0 ? '' : turn[(at + 1) % turn.length];
	const right = (map: string) => (follows ? same(map, follows) : !same(map, playing));
	let next = await nextOf(client, written);
	let unturned = '';
	if (next?.entry && !right(next.entry.map)) {
		// The server took its next entry from somewhere else (it keeps its place in the list, say):
		// turn the order for that place, unless no turn puts a better map there. The shuffle has
		// landed either way, so a refusal here is told, not thrown.
		const place = next.index;
		const first = next.entry.map;
		try {
			const fixed = await rewrite(client, ({ entries }) => {
				const turned = entries.length < 2 ? entries : alignRotation(entries, playing, [place]);
				return turned[place] && entries[place] && same(turned[place].map, entries[place].map)
					? null
					: turned;
			});
			if (fixed) next = await nextOf(client, fixed);
		} catch (err) {
			if (err instanceof GameError && err.code === 'rate_limited')
				return {
					message: `${head}; ${mapName(first)} next: turning it once more was refused for sending too fast.`,
					retryAfterMs: err.retryAfterMs || 5_000
				};
			unturned = ' It could not be turned once more.';
		}
	}
	if (!next) return { message: `${head}. The server did not show the new order back.` };
	if (!next.entry) return { message: `${head}.` };
	return {
		message: same(next.entry.map, playing)
			? `${head}. The server still puts ${mapName(playing)} on next.${unturned}`
			: `${head}; ${mapName(next.entry.map)} next.${unturned}`
	};
}
