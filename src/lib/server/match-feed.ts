// What the worker does with the match events of Season 2's feed (docs/wardogs-api.md), once the
// web has taken a batch: a `match_state` becomes the server's state on the live view (the web
// wrote it to server_live already), and a `match_ended` is the game's own result of the match.
// The looks still decide where a match ends (matchBoundary); the result goes to the match they
// close. It usually arrives first, during the post-match screen, and waits for that look; one
// that arrives just after it corrects the match that look closed.
import { and, eq, isNotNull } from 'drizzle-orm';
import type { Env } from './env';
import type { ServerMemory } from './observe';
import { matches } from './db/schema';
import { emit } from './events';
import { liveView } from './live';
import { LostOwnership, ownershipPeriod, withOwnedTransaction } from './leadership';
import { forLog } from './http';
import { resultOf, sameFactions, type MatchEnd } from './trigger-rules';
import type { ParsedEnd } from './feed-core';
import { matchStateOf } from '$lib/match-state';
import type { MatchStateView } from '$lib/types';

/** What one batch said about the match: its last state and its result, either or both. */
export interface MatchFeed {
	state: MatchStateView | null;
	end: ParsedEnd | null;
}

/** A MatchFeed as the relay carried it, kept only in the shapes the worker reads. */
export function matchFeedOf(raw: unknown): MatchFeed {
	const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	return { state: matchStateOf(o.state), end: endOf(o.end) };
}

function endOf(raw: unknown): ParsedEnd | null {
	if (!raw || typeof raw !== 'object') return null;
	const e = raw as Record<string, unknown>;
	if (!Array.isArray(e.scores) || !e.scores.length) return null;
	const scores = [];
	for (const f of e.scores as unknown[]) {
		const { name, score } = (f ?? {}) as Record<string, unknown>;
		if (typeof name !== 'string' || typeof score !== 'number' || !Number.isFinite(score))
			return null;
		scores.push({ name, score });
	}
	const text = (v: unknown) => (typeof v === 'string' ? v : '');
	const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
	return {
		eventId: text(e.eventId),
		seq: count(e.seq) ?? 0,
		eventTime: count(e.eventTime),
		matchId: text(e.matchId),
		map: text(e.map),
		players: count(e.players),
		winningFaction: text(e.winningFaction),
		winner:
			typeof e.winner === 'string' && scores.some((s) => s.name === e.winner) ? e.winner : null,
		scores
	};
}

/** A result held for the look that sees its match end, and when it arrived. */
export interface FeedEnd {
	end: ParsedEnd;
	at: number;
}

/** The match a look closed: its row, when, its factions, and whether it has the game's result. */
export interface ClosedMatch {
	id: number;
	at: number;
	factions: { name: string }[];
	byFeed: boolean;
}

/**
 * How long a result waits for its look. The post-match screen and the map load come in between,
 * a minute or two, longer when the server does not answer for a while; past this it is dropped
 * rather than risk giving it to a later match.
 */
export const FEED_END_FRESH_MS = 5 * 60_000;

/**
 * A result arriving this soon after a look closed a match is that match's: no match is played in
 * less, and the game sends a batch again when it did not hear back.
 */
export const LATE_END_MS = 2 * 60_000;

/**
 * The held result, when it came recently enough and names the factions the match had; it is
 * dropped either way, since a look closing a match is the end of the match it could belong to.
 */
export function takeFeedEnd(
	m: Pick<ServerMemory, 'feedEnd'>,
	factions: readonly { name: string }[],
	now: number
): ParsedEnd | null {
	const held = m.feedEnd;
	m.feedEnd = null;
	if (!held || now - held.at > FEED_END_FRESH_MS) return null;
	// Names that do not match the scoreboard's would leave every player of the match without a
	// result (match_result in the database), so such a result is not used.
	if (factions.length && !sameFactions(held.end.scores, factions)) return null;
	return held.end;
}

/** The boundary's match with the game's result in place of the last look's, when the feed has it. */
export function withFeedEnd(end: MatchEnd, fed: ParsedEnd | null): MatchEnd {
	return fed ? { ...resultOf(end.map, fed.scores, fed.winner), byFeed: true } : end;
}

/** A batch's match events reached the worker (the gateway's matchFeed). */
export async function onMatchFeed(
	env: Env,
	m: ServerMemory | undefined,
	feed: MatchFeed,
	now = Date.now()
): Promise<void> {
	// A server this worker does not watch: its state is in server_live for the first look.
	if (!m) return;
	if (feed.state) {
		m.matchState = feed.state;
		// Before its first look the view would say only that the server is down; that look sends it.
		if (m.observedAt) emit({ type: 'live', live: liveView(m) });
	}
	if (!feed.end) return;
	const closed = m.closed;
	if (!closed || now - closed.at > LATE_END_MS) {
		m.feedEnd = { end: feed.end, at: now };
		return;
	}
	// The look got there first: the result corrects the match it closed, once.
	if (closed.byFeed || !sameFactions(feed.end.scores, closed.factions)) return;
	closed.byFeed = true;
	const r = resultOf('', feed.end.scores, feed.end.winner);
	try {
		// An ended match changing its result recounts its players' totals (migration 0038), which
		// takes the server's totals lock: first, as every writer of the totals does.
		await withOwnedTransaction(
			env,
			(tx) =>
				tx
					.update(matches)
					.set({ finalScores: r.scores, winner: r.winner })
					.where(
						and(
							eq(matches.id, closed.id),
							eq(matches.serverId, m.server.id),
							isNotNull(matches.endedAt)
						)
					),
			{ totalsOf: m.server.id, period: ownershipPeriod() }
		);
	} catch (err) {
		closed.byFeed = false;
		if (!(err instanceof LostOwnership))
			console.warn(`[warcon] match result of ${m.server.name}:`, forLog(err));
	}
}
