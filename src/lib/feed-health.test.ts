import { describe, expect, test } from 'bun:test';
import {
	FEED_START_GRACE_MS,
	LIVE_FRESH_MS,
	feedHealth,
	type FeedHealthInput
} from './feed-health';

const now = Date.parse('2026-10-18T15:20:00Z');
const ago = (ms: number) => new Date(now - ms).toISOString();
const MIN = 60_000;

/** A server up for six hours, watched a few seconds ago, whose feed has a token. */
const base = (over: Partial<FeedHealthInput> = {}): FeedHealthInput => ({
	configured: true,
	feedAt: null,
	tokenAt: null,
	live: { ok: true, startedAt: ago(6 * 60 * MIN), observedAt: ago(3000) },
	...over
});

describe('feedHealth', () => {
	test('no token is off, whatever else is known', () => {
		expect(feedHealth(base({ configured: false }), now)).toBe('off');
		expect(feedHealth(base({ configured: false, live: null }), now)).toBe('off');
	});

	test('a batch since the start is live, however long ago it came', () => {
		expect(feedHealth(base({ feedAt: ago(4000) }), now)).toBe('live');
		expect(feedHealth(base({ feedAt: ago(5 * 60 * MIN) }), now)).toBe('live');
		// at the start itself: the old process is gone before the new one starts
		expect(feedHealth(base({ feedAt: ago(6 * 60 * MIN) }), now)).toBe('live');
	});

	test('nothing since the start, past the grace, is silent', () => {
		expect(feedHealth(base(), now)).toBe('silent');
		// the last batch came from the process before this one (the Season 2 update, a bad paste)
		expect(feedHealth(base({ feedAt: ago(3 * 24 * 60 * MIN) }), now)).toBe('silent');
		expect(feedHealth(base({ feedAt: ago(6 * 60 * MIN + 1000) }), now)).toBe('silent');
	});

	test('nothing yet within the grace after a start is starting', () => {
		const live = { ok: true, startedAt: ago(2 * MIN), observedAt: ago(1000) };
		expect(feedHealth(base({ live }), now)).toBe('starting');
		expect(feedHealth(base({ live, feedAt: ago(10 * MIN) }), now)).toBe('starting');
		const edge = { ...live, startedAt: ago(FEED_START_GRACE_MS) };
		expect(feedHealth(base({ live: edge }), now)).toBe('silent');
	});

	test('a token newer than the start is waiting, even with batches since the start', () => {
		expect(feedHealth(base({ tokenAt: ago(20 * MIN) }), now)).toBe('waiting');
		// replaced mid-run: the old token's posts are refused from then on
		expect(feedHealth(base({ tokenAt: ago(20 * MIN), feedAt: ago(30 * MIN) }), now)).toBe(
			'waiting'
		);
		// made before the start: the start read it
		expect(feedHealth(base({ tokenAt: ago(7 * 60 * MIN) }), now)).toBe('silent');
		expect(feedHealth(base({ tokenAt: ago(7 * 60 * MIN), feedAt: ago(MIN) }), now)).toBe('live');
	});

	test('without the token time a replaced token reads as what the batches say', () => {
		expect(feedHealth(base({ tokenAt: null }), now)).toBe('silent');
		expect(feedHealth(base({ tokenAt: undefined, feedAt: ago(30 * MIN) }), now)).toBe('live');
	});

	test('a server down, not watched lately or of unknown start is unknown', () => {
		const live = base().live!;
		expect(feedHealth(base({ live: null }), now)).toBe('unknown');
		expect(feedHealth(base({ live: { ...live, ok: false } }), now)).toBe('unknown');
		expect(feedHealth(base({ live: { ...live, startedAt: null } }), now)).toBe('unknown');
		expect(feedHealth(base({ live: { ...live, observedAt: null } }), now)).toBe('unknown');
		expect(
			feedHealth(base({ live: { ...live, observedAt: ago(LIVE_FRESH_MS + 1000) } }), now)
		).toBe('unknown');
		expect(feedHealth(base({ live: { ...live, observedAt: ago(LIVE_FRESH_MS) } }), now)).toBe(
			'silent'
		);
	});
});
