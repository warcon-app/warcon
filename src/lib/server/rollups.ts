// Hourly rollups of the samples table and the raw retention policy. The worker runs rollupSamples
// once an hour: it re-derives every complete hour since the last rollup (recomputing the newest
// one, whose trailing sample's cover was cut short last time) with the same duration weighting
// analytics.ts uses on raw rows, so the 30-day charts read the same numbers from far fewer rows.
import { sql } from 'drizzle-orm';
import type { Env } from './env';
import { settings } from './settings';

/** A sample never covers more than this (matches analytics.ts). */
export const MAX_COVER_S = 600;

export async function rollupSamples(env: Env): Promise<void> {
	const days = settings().rawRetentionDays;
	// One window for both statements: from the newest rollup (recomputed) to the last complete hour.
	const [b] = await env.db.execute<{ since: Date; until: Date }>(sql`
		SELECT COALESCE((SELECT MAX(bucket) FROM sample_rollups), now() - (${days} || ' days')::interval) - interval '1 hour' AS since,
		       date_trunc('hour', now()) AS until`);
	if (!b || new Date(b.since) >= new Date(b.until)) return;
	const covered = sql`
		SELECT server_id, ts, ok, player_count, max_players, map,
		       LEAST(${MAX_COVER_S}, EXTRACT(EPOCH FROM (COALESCE(LEAD(ts) OVER (PARTITION BY server_id ORDER BY ts), now()) - ts))) AS dur
		  FROM samples WHERE ts >= ${b.since} AND ts < ${b.until}`;
	await env.db.execute(sql`
		WITH s AS (${covered})
		INSERT INTO sample_rollups (server_id, bucket, samples, ok_samples, up_s, down_s, player_s, max_players, max_cap)
		SELECT server_id, date_trunc('hour', ts), COUNT(*), COUNT(*) FILTER (WHERE ok),
		       COALESCE(SUM(dur) FILTER (WHERE ok), 0), COALESCE(SUM(dur) FILTER (WHERE NOT ok), 0),
		       COALESCE(SUM(player_count * dur) FILTER (WHERE ok), 0),
		       MAX(player_count) FILTER (WHERE ok), MAX(max_players)
		  FROM s GROUP BY server_id, date_trunc('hour', ts)
		ON CONFLICT (server_id, bucket) DO UPDATE SET samples = EXCLUDED.samples, ok_samples = EXCLUDED.ok_samples,
		       up_s = EXCLUDED.up_s, down_s = EXCLUDED.down_s, player_s = EXCLUDED.player_s,
		       max_players = EXCLUDED.max_players, max_cap = EXCLUDED.max_cap`);
	await env.db.execute(sql`
		WITH s AS (${covered})
		INSERT INTO sample_map_rollups (server_id, bucket, map, secs)
		SELECT server_id, date_trunc('hour', ts), map, SUM(dur)
		  FROM s WHERE ok AND map IS NOT NULL AND map <> ''
		 GROUP BY server_id, date_trunc('hour', ts), map
		ON CONFLICT (server_id, bucket, map) DO UPDATE SET secs = EXCLUDED.secs`);
	const keep = settings().sessionRetentionDays;
	await env.db.execute(
		sql`DELETE FROM sample_rollups WHERE bucket < now() - (${keep} || ' days')::interval`
	);
	await env.db.execute(
		sql`DELETE FROM sample_map_rollups WHERE bucket < now() - (${keep} || ' days')::interval`
	);
}

/**
 * Makes TimescaleDB's retention policy on samples follow the rawRetentionDays setting (plain
 * Postgres installs prune in poller.ts instead). Returns whether the policy was (re)created.
 */
export async function applyRetentionPolicy(env: Env): Promise<boolean> {
	if (!env.timescale) return false;
	const days = settings().rawRetentionDays;
	const [job] = await env.db.execute<{ drop_after: string | null }>(sql`
		SELECT config->>'drop_after' AS drop_after FROM timescaledb_information.jobs
		 WHERE proc_name = 'policy_retention' AND hypertable_name = 'samples' LIMIT 1`);
	const want = `${days} days`;
	if (job && job.drop_after && sameInterval(job.drop_after, want)) return false;
	await env.db.execute(sql`SELECT remove_retention_policy('samples', true)`);
	await env.db.execute(
		sql`SELECT add_retention_policy('samples', (${want})::interval, if_not_exists => true)`
	);
	console.log(`[warcon] samples retention policy set to ${want}`);
	return true;
}

/** "14 days" and "14 days" match; so do "2 weeks"-style spellings Postgres may echo back. */
function sameInterval(a: string, b: string): boolean {
	const norm = (s: string) =>
		s
			.replace(/\s+/g, ' ')
			.trim()
			.toLowerCase()
			.replace(/^1 day$/, '1 days');
	if (norm(a) === norm(b)) return true;
	const m = /^(\d+) days?$/.exec(norm(a));
	const n = /^(\d+) days?$/.exec(norm(b));
	return !!m && !!n && m[1] === n[1];
}
