// What the game says about its kill feed: Season 2's GET /v1/feed (CL-516586 on), switched on or not
// and, per endpoint it posts to, the scheme and host (never the URL or the token), whether it is
// healthy, how many batches went or were dropped, and the last HTTP answer it got. Read on the
// Config card by those who may apply the config, since it names every service the server posts to.
//
// The answer from TLR #1 (2026-10-18), its Warcon line naming the site alone:
//   { enabled: true, endpointCount: 2, anyUnhealthy: true, endpoints: [
//     { index: 0, scheme: "https", host: "console.warcon.app", healthy: false, queued: 0,
//       inFlight: 0, consecutiveFailures: 2, sentTotal: 0, droppedTotal: 4, lastHttpStatus: 405,
//       lastSuccessUnixSeconds: null }, { index: 1, … another service, healthy, 200 … } ] }
//
// The answer names the host only, so which line is wrong is told from what this panel answered:
// it knows its own routes (src/hooks.server.ts), so 405 is a page of the panel (the site alone),
// 404 a wrong path under /api/ingest/, 401 a token it does not know.
import type { FeedState } from './feed-health';

export interface FeedEndpoint {
	index: number;
	/** 'http' or 'https'; '' for anything else */
	scheme: string;
	/** the host the game posts to, as it names it; characters a host cannot hold are dropped */
	host: string;
	healthy: boolean;
	queued: number;
	inFlight: number;
	consecutiveFailures: number;
	sentTotal: number;
	droppedTotal: number;
	/** null until the game has had an answer */
	lastHttpStatus: number | null;
	lastSuccessAt: string | null;
}

export interface FeedReport {
	enabled: boolean;
	endpointCount: number;
	endpoints: FeedEndpoint[];
}

/** The game takes up to four endpoints; anything past this many is not a feed list. */
const MAX_ENDPOINTS = 8;

const count = (v: unknown): number =>
	typeof v === 'number' && Number.isInteger(v) && v >= 0 ? Math.min(v, Number.MAX_SAFE_INTEGER) : 0;

const status = (v: unknown): number | null =>
	typeof v === 'number' && Number.isInteger(v) && v >= 100 && v <= 599 ? v : null;

/** Letters, digits, dots, dashes, a port's colon and an IPv6 address's brackets; nothing else. */
const hostOf = (v: unknown): string =>
	typeof v === 'string' ? v.replace(/[^A-Za-z0-9.\-:[\]]/g, '').slice(0, 255) : '';

const secondsAt = (v: unknown): string | null =>
	typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 1e11
		? new Date(v * 1000).toISOString()
		: null;

/** The game's answer, kept to the fields above; null when it is not a feed report at all. */
export function feedReportOf(raw: unknown): FeedReport | null {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	if (typeof o.enabled !== 'boolean') return null;
	const list = Array.isArray(o.endpoints) ? o.endpoints.slice(0, MAX_ENDPOINTS) : [];
	const endpoints = list
		.filter((e): e is Record<string, unknown> => !!e && typeof e === 'object' && !Array.isArray(e))
		.map((e, i) => ({
			index: typeof e.index === 'number' && Number.isInteger(e.index) ? e.index : i,
			scheme: e.scheme === 'http' || e.scheme === 'https' ? e.scheme : '',
			host: hostOf(e.host),
			healthy: e.healthy === true,
			queued: count(e.queued),
			inFlight: count(e.inFlight),
			consecutiveFailures: count(e.consecutiveFailures),
			sentTotal: count(e.sentTotal),
			droppedTotal: count(e.droppedTotal),
			lastHttpStatus: status(e.lastHttpStatus),
			lastSuccessAt: secondsAt(e.lastSuccessUnixSeconds)
		}));
	// `endpoints` may be left out of the answer; the count still says how many there are
	return {
		enabled: o.enabled,
		endpointCount: Math.max(count(o.endpointCount), endpoints.length),
		endpoints
	};
}

/** Whether an endpoint is this panel: the host of its origin, with or without the port. */
export function isPanel(e: Pick<FeedEndpoint, 'host'>, origin: string): boolean {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	const host = e.host.toLowerCase();
	return !!host && (host === url.host.toLowerCase() || host === url.hostname.toLowerCase());
}

export type FeedFault =
	/** bEventFeedEnabled was not on when the game started */
	| 'off'
	/** on, with no endpoint */
	| 'empty'
	/** endpoints, none of them this panel */
	| 'elsewhere'
	/** 404 or 405: the Url names a page of the panel or a wrong path, not /api/ingest/events */
	| 'path'
	/** 403: refused before the ingest, most often a wrong path under /api */
	| 'forbidden'
	/** 401: a token the panel does not know */
	| 'token'
	/** 5xx: the panel's own trouble */
	| 'panel'
	/** any other answer that is not a success */
	| 'refused'
	/** failures with no answer at all: the game cannot reach the panel */
	| 'unreachable'
	/** the panel takes the posts, but none has come in for this server: another server's token */
	| 'otherToken';

export interface FeedDiagnosis {
	fault: FeedFault | null;
	/** the endpoint the fault is about, when it is this panel's */
	endpoint: FeedEndpoint | null;
	/** how many endpoints the file lists (for 'elsewhere') */
	others: number;
}

/**
 * What the game's report says is wrong with the feed to this panel; fault null when nothing is.
 * `state` is the panel's own verdict ($lib/feed-health), and must be read after the report: the
 * game counts a batch as sent only once the panel has answered it, and the panel stamps the
 * server's last batch before it answers, so a verdict read after the report has seen every batch
 * the report counts (one read before it has not: after a restart the report would show batches
 * the verdict never heard of). The game's counters start again at its start, so batches sent
 * here while nothing came in for this server since its start went in under another server's
 * token. No clock of the game's is compared with the panel's.
 */
export function feedDiagnosis(report: FeedReport, origin: string, state: FeedState): FeedDiagnosis {
	const none = { endpoint: null, others: report.endpointCount };
	if (!report.enabled) return { fault: 'off', ...none };
	if (!report.endpointCount) return { fault: 'empty', ...none };
	const ours = report.endpoints.filter((e) => isPanel(e, origin));
	if (!ours.length) return { fault: 'elsewhere', ...none };
	const e = ours.find((x) => !x.healthy) ?? ours[0];
	const at = { endpoint: e, others: report.endpointCount - ours.length };
	const code = e.lastHttpStatus;
	if (code !== null && code >= 200 && code < 300) {
		return state === 'silent' && e.sentTotal > 0
			? { fault: 'otherToken', ...at }
			: { fault: null, ...at };
	}
	if (code === 401) return { fault: 'token', ...at };
	if (code === 404 || code === 405) return { fault: 'path', ...at };
	if (code === 403) return { fault: 'forbidden', ...at };
	if (code !== null && code >= 500) return { fault: 'panel', ...at };
	if (code !== null) return { fault: 'refused', ...at };
	return { fault: e.consecutiveFailures > 0 ? 'unreachable' : null, ...at };
}
