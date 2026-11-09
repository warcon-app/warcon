// Prometheus metrics for both processes. Every figure here is a counter or gauge in memory: an
// increment on the path that already runs (an observation, a delivery, a request), never a
// query per server. The gauges that need a look at the scheduler or the database are filled by
// collectors, run once per scrape, so a process that is never scraped does no work at all.
//
// The web process exports the request, kill feed and rate-limit figures plus the fleet counts;
// the worker exports observation, delivery and scheduler figures. WARCON_ROLE=all exports both.
// Scraped at /metrics on either process, behind the METRICS_TOKEN bearer; off when it is unset.
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { buildInfo, type BuildInfo } from './build-info';
import { timingSafeEqualStr } from './crypto';
import { forLog } from './http';

export const registry = new Registry();
collectDefaultMetrics({ register: registry });

// The usual build_info shape: always 1, the build in the labels.
new Gauge({
	name: 'warcon_build_info',
	help: 'The build this process runs: package version and commit.',
	labelNames: ['version', 'commit'] as const,
	registers: [registry]
}).set(buildInfo(), 1);

// ---- worker: observation and delivery ----------------------------------------------------------

export const observations = new Counter({
	name: 'warcon_observations_total',
	help: 'Looks at a game server (status, players, or both), by outcome.',
	labelNames: ['outcome'] as const,
	registers: [registry]
});
export const observationSeconds = new Histogram({
	name: 'warcon_observation_seconds',
	help: 'Wall time of one observation, request to written.',
	buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
	registers: [registry]
});
export const deliveries = new Counter({
	name: 'warcon_deliveries_total',
	help: 'Outbox rows finished, by outcome.',
	labelNames: ['outcome'] as const,
	registers: [registry]
});
export const serversByTier = new Gauge({
	name: 'warcon_servers',
	help: 'Servers on the worker roster, by observation tier.',
	labelNames: ['tier'] as const,
	registers: [registry]
});
export const playersOnline = new Gauge({
	name: 'warcon_players_online',
	help: 'Players on every reachable server, from the last observation of each.',
	registers: [registry]
});
export const observationsInFlight = new Gauge({
	name: 'warcon_observations_in_flight',
	help: 'Observations running now.',
	registers: [registry]
});
export const observationConcurrency = new Gauge({
	name: 'warcon_observation_concurrency',
	help: 'The concurrency budget (a runtime setting).',
	registers: [registry]
});
export const serversBehind = new Gauge({
	name: 'warcon_servers_behind',
	help: 'Servers overdue by more than their own cadence: the worker is not keeping up.',
	registers: [registry]
});
export const observationsStuck = new Gauge({
	name: 'warcon_observations_stuck',
	help: 'Observations running for longer than two minutes.',
	registers: [registry]
});
export const lanesBusy = new Gauge({
	name: 'warcon_lanes_busy',
	help: 'Per-server lanes with a request in progress.',
	registers: [registry]
});
export const lanesQueued = new Gauge({
	name: 'warcon_lanes_queued',
	help: 'Requests waiting behind another on the same server.',
	registers: [registry]
});
export const leaseHeld = new Gauge({
	name: 'warcon_worker_lease_held',
	help: '1 when this process owns observation and delivery.',
	registers: [registry]
});
export const outboxPending = new Gauge({
	name: 'warcon_outbox_pending',
	help: 'Trigger actions decided on and not yet delivered.',
	registers: [registry]
});
export const outboxOldestSeconds = new Gauge({
	name: 'warcon_outbox_oldest_seconds',
	help: 'Age of the oldest pending outbox row.',
	registers: [registry]
});
export const jsonWebhookPostsDone = new Counter({
	name: 'warcon_json_webhook_posts_total',
	help: 'POSTs to JSON webhooks finished, by outcome.',
	labelNames: ['outcome'] as const,
	registers: [registry]
});
export const jsonWebhookPostsPending = new Gauge({
	name: 'warcon_json_webhook_posts_pending',
	help: 'POSTs to JSON webhooks queued and not yet finished.',
	registers: [registry]
});

// ---- web: requests, kill feed, rate limits, fleet counts ---------------------------------------

export const httpRequests = new Counter({
	name: 'warcon_http_requests_total',
	help: 'Requests answered, by SvelteKit route id, method and status.',
	labelNames: ['route', 'method', 'status'] as const,
	registers: [registry]
});
export const httpRequestSeconds = new Histogram({
	name: 'warcon_http_request_seconds',
	help: 'Time to answer a request, by route id.',
	labelNames: ['route'] as const,
	buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
	registers: [registry]
});
export const feedPosts = new Counter({
	name: 'warcon_feed_posts_total',
	help: 'Kill feed batches posted by game servers, by outcome.',
	labelNames: ['outcome'] as const,
	registers: [registry]
});
export const feedKills = new Counter({
	name: 'warcon_feed_kills_total',
	help: 'Kill feed events received, by what became of them.',
	labelNames: ['result'] as const,
	registers: [registry]
});
export const boardReads = new Counter({
	name: 'warcon_board_reads_total',
	help: 'Board pages asked for, by what the minute cache did: had it (hit), was reading it (shared) or read it (miss).',
	labelNames: ['outcome'] as const,
	registers: [registry]
});
export const rateLimited = new Counter({
	name: 'warcon_rate_limited_total',
	help: 'Requests refused by the in-memory limiter, by the limit that fired.',
	labelNames: ['scope'] as const,
	registers: [registry]
});
export const fleet = new Gauge({
	name: 'warcon_fleet',
	help: 'Rows in the small tables: organizations, users, servers, org_members, webhooks, triggers.',
	labelNames: ['table'] as const,
	registers: [registry]
});

// ---- the panel's view of the same counters ------------------------------------------------------

/** Cumulative counts of this process, for the Admin overview: it takes two readings and derives rates. */
export interface ProcessSnapshot {
	/** epoch ms of the reading */
	at: number;
	/** the build this process runs; the web and the worker can differ mid-deploy */
	build: BuildInfo;
	observations: { ok: number; failed: number; seconds: number };
	requests: { total: number; public: number; errors: number; seconds: number };
	feed: {
		posts: number;
		unauthorized: number;
		rejected: number;
		kills: number;
		/** joins, leaves, match states and results: known events other than kills (feed-core.ts) */
		other: number;
		skipped: number;
		duplicates: number;
		/** match states the same as the last one stored for the server (feed.ts) */
		repeats: number;
	};
	rateLimited: { total: number; feed: number };
	rssBytes: number;
	eventLoopLagP99: number | null;
}

type Labels = Partial<Record<string, string | number>>;
async function total(
	metric: Counter<string> | Histogram<string>,
	pick: (labels: Labels, metricName: string | undefined) => boolean = () => true
): Promise<number> {
	const { values } = await metric.get();
	let sum = 0;
	// A histogram's values carry the bucket, sum and count names; the typing does not say so.
	for (const v of values as ((typeof values)[number] & { metricName?: string })[])
		if (pick(v.labels, v.metricName)) sum += v.value;
	return sum;
}
const sumOf = (name: string) => (_: Labels, metricName: string | undefined) =>
	metricName === `${name}_sum`;

export async function snapshot(): Promise<ProcessSnapshot> {
	const lag = registry.getSingleMetric('nodejs_eventloop_lag_p99_seconds');
	const lagValue = lag ? (await lag.get()).values[0]?.value : undefined;
	return {
		at: Date.now(),
		build: buildInfo(),
		observations: {
			ok: await total(observations, (l) => l.outcome === 'ok'),
			failed: await total(observations, (l) => l.outcome === 'failed'),
			seconds: await total(observationSeconds, sumOf('warcon_observation_seconds'))
		},
		requests: {
			total: await total(httpRequests),
			public: await total(httpRequests, (l) => String(l.route).startsWith('/(public)')),
			errors: await total(httpRequests, (l) => String(l.status).startsWith('5')),
			seconds: await total(httpRequestSeconds, sumOf('warcon_http_request_seconds'))
		},
		feed: {
			posts: await total(feedPosts, (l) => l.outcome === 'accepted'),
			unauthorized: await total(feedPosts, (l) => l.outcome === 'unauthorized'),
			rejected: await total(feedPosts, (l) => l.outcome === 'rejected'),
			kills: await total(feedKills, (l) => l.result === 'accepted'),
			other: await total(feedKills, (l) => l.result === 'other'),
			skipped: await total(feedKills, (l) => l.result === 'skipped'),
			duplicates: await total(feedKills, (l) => l.result === 'duplicate'),
			repeats: await total(feedKills, (l) => l.result === 'repeat')
		},
		rateLimited: {
			total: await total(rateLimited),
			feed: await total(rateLimited, (l) => l.scope === 'feed')
		},
		rssBytes: process.memoryUsage().rss,
		eventLoopLagP99: typeof lagValue === 'number' && Number.isFinite(lagValue) ? lagValue : null
	};
}

// ---- collectors and the scrape -----------------------------------------------------------------

type Collector = () => void | Promise<void>;
const collectors = new Set<Collector>();

/** Runs before every scrape; for gauges that are read off the scheduler or the database. */
export function registerCollector(fn: Collector): () => void {
	collectors.add(fn);
	return () => collectors.delete(fn);
}

/** The exposition text. A collector that fails leaves its gauges as they were. */
export async function renderMetrics(): Promise<string> {
	await Promise.all(
		[...collectors].map(async (fn) => {
			try {
				await fn();
			} catch (err) {
				console.warn('[warcon] metrics collector:', forLog(err));
			}
		})
	);
	return registry.metrics();
}

/** The label a SvelteKit route contributes; unmatched requests share one so a scan cannot grow the set. */
export const routeLabel = (id: string | null | undefined): string => id || '(unmatched)';

/**
 * Answers GET /metrics on either process. Off (404) until METRICS_TOKEN is set; then a bearer
 * that does not match is refused. The exposition carries fleet-wide figures, so it is never open.
 */
export async function metricsResponse(
	request: Request,
	token: string | undefined
): Promise<Response> {
	if (!token) return new Response('Not found.', { status: 404 });
	if (!timingSafeEqualStr(request.headers.get('authorization') || '', `Bearer ${token}`))
		return new Response('Unauthorized.', {
			status: 401,
			headers: { 'www-authenticate': 'Bearer realm="metrics"' }
		});
	return new Response(await renderMetrics(), {
		headers: { 'content-type': registry.contentType, 'cache-control': 'no-store' }
	});
}

/** Test-only: forget every counter and collector. */
export function resetMetrics(): void {
	registry.resetMetrics();
	collectors.clear();
}
