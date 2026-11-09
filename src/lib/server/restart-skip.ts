// The Skip map after restart rule. A WARDOGS server that restarts comes up on a map of the game's
// own (standard Bakurani on Season 2 builds, as hosts report), not on its rotation, and follows the
// rotation only once that first match ends: an infantry-only rotation still opens every day on a
// standard match, and hosts end it by hand. The rule ends it at the worker's first look after the
// restart, when the map and modes the server came up on are not an entry of its rotation. It ends
// the match rather than asking for a map, so the game moves on along its rotation as at any match
// end, its own place in the list with it. Once a run, for runs that start while the rule is on.
import { ACTIONS } from './actions';
import type { WardogsClient } from './rcon';
import { isMod, mapName, prettify } from '../format';
import type { MapSelection, Status } from '../types';

/** The outbox action that ends the match a server came up on (not in ACTIONS). */
export const RESTART_SKIP = 'restart_skip';

/** No settings: the rotation is read off the server when the rule acts. */
export type RestartSkipConfig = Record<string, never>;

export const validateRestartSkip = (): RestartSkipConfig => ({});

/** What every queued skip carries as `params.rule`, so one is not sent once the rule is off. */
export const RESTART_SKIP_KEY = 'on';

export interface RestartSkipState {
	/** when the rule was switched on (ms): a run that started before it is left alone */
	armedAt: number;
	/** when the game started (ms) in the last run the rule looked at */
	boot: number;
}

/** A state the rule wrote, or null for anything else (a rule switched on again has none). */
export function restartSkipState(v: unknown): RestartSkipState | null {
	if (!v || typeof v !== 'object') return null;
	const s = v as Record<string, unknown>;
	const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
	return n(s.armedAt) && n(s.boot) ? { armedAt: n(s.armedAt), boot: n(s.boot) } : null;
}

/** The start is worked out from the uptime at each look, so it moves by the look's latency. */
const SAME_RUN_MS = 60_000;

/**
 * One look: the state to keep and whether the rule acts on this run, or null when nothing changes
 * (a run it has looked at, or the start is unknown). A run that started before the rule was
 * switched on (`armedAt`: the rule's last save, taken while it has no state) is only noted, so the
 * rule acts from the next restart on and never ends a match that was going when it was saved.
 */
export function restartSkipStep(
	prev: RestartSkipState | null,
	look: { startedAt: number; armedAt: number }
): { state: RestartSkipState; act: boolean } | null {
	const start = look.startedAt;
	if (!start) return null;
	if (prev && Math.abs(start - prev.boot) <= SAME_RUN_MS) return null;
	const armedAt = prev?.armedAt ?? look.armedAt;
	return { state: { armedAt, boot: start }, act: start > armedAt - SAME_RUN_MS };
}

/** A first match the rule gets to later than this after the restart plays on once a side has scored. */
export const RESTART_SKIP_LATE_MS = 10 * 60_000;

/**
 * Whether ending the match would cut a game people are playing: a side has scored and the run is
 * past its first minutes. The worker sees a restart within a couple of minutes, while people are
 * still rejoining; one it sees late (the worker was down at the time) is left to play.
 */
export const underWay = (scores: { score: number }[], startedAt: number, now: number): boolean =>
	now - startedAt > RESTART_SKIP_LATE_MS && scores.some((f) => f.score > 0);

/** "Bakurani (Day Clear)", "Ozeti (Infantry Only, Day Early Fog)": the map, its modifiers, the time of day. */
export function selectionName(sel: Pick<MapSelection, 'map' | 'experiences' | 'lighting'>): string {
	const more = [
		...sel.experiences.filter(isMod).map((m) => prettify(m.replace(/^KOTH_/i, ''))),
		prettify(sel.lighting)
	].filter(Boolean);
	return `${mapName(sel.map)}${more.length ? ` (${more.join(', ')})` : ''}`;
}

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const modes = (ids: string[]) => ids.map(lower).filter(Boolean).sort().join('+');

/**
 * Whether the server is on this rotation entry: the same map and modes, and the same time of day
 * where the entry names one. The control zone is left out (an entry without one plays a zone the
 * status names), so a zone alone never makes the map count as off the rotation.
 */
export const isEntry = (entry: MapSelection, on: MapSelection): boolean =>
	lower(entry.map) === lower(on.map) &&
	modes(entry.experiences) === modes(on.experiences) &&
	(!lower(entry.lighting) || lower(entry.lighting) === lower(on.lighting));

/** The same match as the look saw: everything the status says about the map. */
const sameMatch = (a: MapSelection, b: MapSelection): boolean =>
	isEntry(a, b) &&
	lower(a.lighting) === lower(b.lighting) &&
	lower(a.zoneAlternator) === lower(b.zoneAlternator);

/** What a look saw the server on, as the status says it. */
export const onNow = (s: Pick<Status, 'map' | 'experiences' | 'lighting' | 'alternator'>) => ({
	map: s.map,
	experiences: [...s.experiences],
	lighting: s.lighting,
	zoneAlternator: s.alternator
});

const selectionOf = (p: Record<string, unknown>): MapSelection => ({
	map: typeof p.map === 'string' ? p.map : '',
	experiences: Array.isArray(p.experiences)
		? p.experiences.filter((e): e is string => typeof e === 'string')
		: [],
	lighting: typeof p.lighting === 'string' ? p.lighting : '',
	zoneAlternator: typeof p.zoneAlternator === 'string' ? p.zoneAlternator : ''
});

interface LiveRotation {
	enabled: boolean;
	nextIndex: number;
	entries: MapSelection[];
}

/**
 * The skip, at delivery: the status and the rotation read again, and the match ended while the
 * server is on the map the look saw, that map is not an entry of the rotation, and the match is not
 * under way. Anything else is left with the reason (`skipped`: the outbox keeps the row, with no
 * audit row). The result names maps only.
 */
export async function skipStartupMap(
	client: WardogsClient,
	params: Record<string, unknown>
): Promise<{ message: string; skipped?: true }> {
	const status = (await ACTIONS.status.run(client, {})) as Status;
	const on = onNow(status);
	const name = selectionName(on);
	if (!sameMatch(on, selectionOf(params)))
		return { skipped: true, message: `The server had moved on to ${name}.` };
	if (underWay(status.scores, Number(params.startedAt) || 0, Date.now()))
		return { skipped: true, message: `The match on ${name} was under way, so it plays on.` };
	const rotation = (await ACTIONS.rotation.run(client, {})) as LiveRotation;
	if (!rotation.enabled || !rotation.entries.length)
		return {
			skipped: true,
			message: `The rotation is off on this server, so ending the match would only load ${name} again.`
		};
	if (rotation.entries.some((e) => isEntry(e, on)))
		return { skipped: true, message: `${name} is in the rotation: nothing to skip.` };
	const next = rotation.entries[rotation.nextIndex];
	await ACTIONS.endMatch.run(client, {});
	return {
		message: `Skipped ${name}, which the rotation does not have${next ? `; ${selectionName(next)} is next` : ''}.`
	};
}
