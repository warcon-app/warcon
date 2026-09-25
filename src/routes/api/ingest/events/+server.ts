// Where the game posts its kill feed: [WDServerFeed] Url is the panel's origin and the game adds
// /api/ingest/events itself. The bearer is the server's feed token and nothing else identifies
// the sender: the body's serverId is a per-boot instance id. Not a panel route: no session, no
// API key, no CSRF header (hooks.server.ts exempts the path).
import { getEnv } from '$lib/server/env';
import { ApiError, apiJson, clientIp, route } from '$lib/server/http';
import { assertRate } from '$lib/server/ratelimit';
import { gateway } from '$lib/server/gateway';
import { ingestBatch, resolveFeedToken } from '$lib/server/feed';
import { MAX_BODY_BYTES, parseFeedBearer } from '$lib/server/feed-core';
import { feedKills, feedPosts } from '$lib/server/metrics';

/** The game sends about thirty posts a minute at most; a host stuck in a loop is cut off here. */
const POSTS_PER_MINUTE = 1200;

export const POST = route(async (event) => {
	const env = getEnv();
	const token = parseFeedBearer(event.request.headers.get('authorization'));
	const serverId = token ? await resolveFeedToken(env, token) : null;
	if (!serverId) {
		// Counted per address so a host with a stale token cannot hammer the token lookup.
		feedPosts.inc({ outcome: 'unauthorized' });
		assertRate(`feed-bad:${clientIp(event.request)}`, 20, 60_000);
		throw new ApiError(401, 'Unknown kill feed token.', 'unauthorized');
	}
	assertRate(`feed:${serverId}`, POSTS_PER_MINUTE, 60_000);
	const length = Number(event.request.headers.get('content-length') || 0);
	if (length > MAX_BODY_BYTES) return rejected(413, 'Batch too large.');
	const text = await event.request.text();
	if (text.length > MAX_BODY_BYTES) return rejected(413, 'Batch too large.');
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return rejected(400, 'Malformed JSON body.');
	}
	const r = await ingestBatch(env, serverId, body);
	feedPosts.inc({ outcome: 'accepted' });
	feedKills.inc({ result: 'accepted' }, r.acceptedKills);
	feedKills.inc({ result: 'skipped' }, r.skipped);
	feedKills.inc({ result: 'duplicate' }, r.duplicateKills);
	// Browsers watching the server see them at once; the worker's kill rules get their turn.
	if (r.kills.length) gateway().killsIngested(env, serverId, r.kills);
	return apiJson({ ok: true, accepted: r.accepted, skipped: r.skipped, duplicates: r.duplicates });
});

function rejected(status: number, message: string): never {
	feedPosts.inc({ outcome: 'rejected' });
	throw new ApiError(status, message);
}
