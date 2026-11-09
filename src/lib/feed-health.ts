// Whether the kill feed reaches the panel, judged from what the panel already knows: that a token
// exists, when the game process last started, and when its last batch arrived. Season 2 builds post
// their match state as soon as they start, with nobody on (TLR #1, 2026-10-18: four batches within
// 96 s of its start, on an empty server), and the game reads its feed endpoints only at its start.
// So a configured server that has sent nothing a few minutes after it started is not reaching the
// panel, and will not until it restarts with lines that work. The Config card, the Automation tab
// and the Overview's kill feed panel say so.
import type { LiveView } from './types';

/** How long the game may take after its start to send its first batch before the feed is silent. */
export const FEED_START_GRACE_MS = 5 * 60_000;

/**
 * A live row older than this says nothing about the server now: the worker writes it at least every
 * ten seconds while it watches a server that answers.
 */
export const LIVE_FRESH_MS = 2 * 60_000;

export type FeedState =
	/** no token */
	| 'off'
	/** the token was made or replaced after the game started, so the game cannot have it yet */
	| 'waiting'
	/** the game started under FEED_START_GRACE_MS ago and has sent nothing yet */
	| 'starting'
	/** the token is older than the game's start and nothing has come since the start */
	| 'silent'
	/** a batch has come since the game started */
	| 'live'
	/** the server is down, or when it started is not known: nothing to judge by */
	| 'unknown';

export interface FeedHealthInput {
	configured: boolean;
	/** when the last batch arrived */
	feedAt: string | null;
	/** when the token was made; only for those who may see the token, so 'waiting' is theirs alone */
	tokenAt?: string | null;
	live: Pick<LiveView, 'ok' | 'startedAt' | 'observedAt'> | null;
}

const at = (iso: string | null | undefined): number => (iso ? Date.parse(iso) : NaN);

export function feedHealth(input: FeedHealthInput, now = Date.now()): FeedState {
	if (!input.configured) return 'off';
	const started = at(input.live?.startedAt);
	const seen = at(input.live?.observedAt);
	if (!input.live?.ok || !Number.isFinite(started) || !(now - seen <= LIVE_FRESH_MS)) {
		return 'unknown';
	}
	// A token replaced while the game runs: the game posts with the old one, which is refused, until
	// it restarts with the new lines; the batches it sent before the change do not make it live.
	if (at(input.tokenAt) > started) return 'waiting';
	// The game's old process is gone before the new one starts, so a batch at or after the start is
	// the new process's. `startedAt` is good to a second or two (uptimeSeconds is whole seconds).
	if (at(input.feedAt) >= started) return 'live';
	return now - started < FEED_START_GRACE_MS ? 'starting' : 'silent';
}
