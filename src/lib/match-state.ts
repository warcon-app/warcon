// The match's state as Season 2's feed reports it (`match_state` events, docs/wardogs-api.md):
// what the panel calls each, and when the last one is still the server's. The status route has
// no phase of its own, so only a server whose feed reaches Warcon shows one.
import type { LiveView, MatchStateView } from '$lib/types';

/** Most specific first: a sub-state the panel does not know takes its parent's name. */
const LABELS: [state: string, label: string][] = [
	['MatchState.PreMatch.WaitingForWorldLoad', 'Loading the map'],
	['MatchState.PreMatch.WaitingForPlayers.PlayerCount', 'Waiting for enough players'],
	['MatchState.PreMatch.WaitingForPlayers', 'Waiting for players'],
	['MatchState.PreMatch', 'Pre-match'],
	['MatchState.Playing', 'Playing'],
	['MatchState.PostMatch', 'Match over']
];

/** A stored or relayed state, kept only in the shape the panel reads; null for anything else. */
export function matchStateOf(raw: unknown): MatchStateView | null {
	if (!raw || typeof raw !== 'object') return null;
	const { state, map, at } = raw as Record<string, unknown>;
	return typeof state === 'string' &&
		typeof map === 'string' &&
		typeof at === 'string' &&
		!Number.isNaN(Date.parse(at))
		? { state, map, at }
		: null;
}

/** What the panel calls a state: the name of it or its nearest known parent, else the game's words. */
export function stateLabel(state: string): string {
	for (const [name, label] of LABELS)
		if (state === name || state.startsWith(name + '.')) return label;
	return state.replace(/^MatchState\./, '');
}

/**
 * A state posted before the game process last started belongs to the previous run. The start is
 * read from the uptime, a few seconds either way, and a new run posts its own state within moments.
 */
const START_SLACK_MS = 60_000;

/**
 * The server's match state now: the last one the feed reported, while the server answers and
 * unless it came before the game last started. A host changes the feed only with a restart (the
 * game reads it at start), so a feed taken away cannot leave an old state standing.
 */
export function currentState(
	live: Pick<LiveView, 'ok' | 'startedAt' | 'matchState'> | null
): MatchStateView | null {
	const s = live?.matchState;
	if (!live?.ok || !s) return null;
	if (live.startedAt && Date.parse(s.at) < Date.parse(live.startedAt) - START_SLACK_MS) return null;
	return s;
}
