// The Admin overview: what the site owner sees of the whole install in one place. Read once per
// page view and every five seconds while the page is open, by one owner at a time, so the cost
// is per viewer, not per server: the worker's health call, one count statement over the small
// tables and the live table, one catalog query for sizes, and the players-seen tally, which is
// the only heavy read (a scan of player_sessions) and is cached for five minutes.
import { sql } from 'drizzle-orm';
import type { Env } from './env';
import { gateway } from './gateway';
import type { PollerStats } from './poller';
import { snapshot, type ProcessSnapshot } from './metrics';

export interface Fleet {
	orgs: number;
	orgsWeek: number;
	users: number;
	usersWeek: number;
	servers: number;
	serversOk: number;
	serversObserved: number;
	serversFeeding: number;
	serversPublic: number;
	/** from the live table; the worker's own roster sum is preferred when it answers */
	players: number;
}
export interface TableSize {
	name: string;
	rows: number;
	bytes: number;
}
export interface PlayersSeen {
	today: number;
	month: number;
	all: number;
	/** when the tally was made (ISO) */
	at: string;
}
export interface Overview {
	at: string;
	worker: PollerStats | null;
	web: ProcessSnapshot;
	metricsOn: boolean;
	fleet: Fleet;
	builds: { build: string; count: number }[];
	database: { bytes: number; tables: TableSize[] };
	seen: PlayersSeen | null;
}

const SEEN_TTL_MS = 5 * 60_000;
const FEED_ALIVE = '2 minutes';

export async function overview(env: Env, opts: { recount?: boolean } = {}): Promise<Overview> {
	const [worker, web, fleet, builds, database, seen] = await Promise.all([
		gateway()
			.health(env)
			.catch(() => null),
		snapshot(),
		fleetCounts(env),
		buildCounts(env),
		databaseSizes(env),
		playersSeen(env, opts.recount === true)
	]);
	return {
		at: new Date().toISOString(),
		worker,
		web,
		metricsOn: !!env.METRICS_TOKEN,
		fleet,
		builds,
		database,
		seen
	};
}

async function fleetCounts(env: Env): Promise<Fleet> {
	const [row] = (await env.db.execute(sql`
		SELECT (SELECT count(*) FROM organizations)::int AS orgs,
		       (SELECT count(*) FROM organizations WHERE created_at > now() - interval '7 days')::int AS orgs_week,
		       (SELECT count(*) FROM "user")::int AS users,
		       (SELECT count(DISTINCT user_id) FROM session WHERE updated_at > now() - interval '7 days')::int AS users_week,
		       (SELECT count(*) FROM servers)::int AS servers,
		       (SELECT count(*) FROM servers WHERE public_status OR public_leaderboards OR public_matches)::int AS servers_public,
		       (SELECT count(*) FROM server_live WHERE ok)::int AS servers_ok,
		       (SELECT count(*) FROM server_live WHERE observed_at IS NOT NULL)::int AS servers_observed,
		       (SELECT count(*) FROM server_live WHERE feed_at > now() - ${FEED_ALIVE}::interval)::int AS servers_feeding,
		       (SELECT coalesce(sum(player_count), 0) FROM server_live WHERE ok)::int AS players`)) as unknown as Record<
		string,
		number
	>[];
	return {
		orgs: row.orgs,
		orgsWeek: row.orgs_week,
		users: row.users,
		usersWeek: row.users_week,
		servers: row.servers,
		serversOk: row.servers_ok,
		serversObserved: row.servers_observed,
		serversFeeding: row.servers_feeding,
		serversPublic: row.servers_public,
		players: row.players
	};
}

async function buildCounts(env: Env): Promise<Overview['builds']> {
	const rows = (await env.db.execute(sql`
		SELECT build, count(*)::int AS count FROM server_live GROUP BY build ORDER BY count DESC, build`)) as unknown as {
		build: string;
		count: number;
	}[];
	return rows.map((r) => ({ build: r.build, count: r.count }));
}

/**
 * Every table in the public schema with its estimated rows and total size (heap, indexes and
 * toast). On TimescaleDB a hypertable's chunks live in another schema, so its figures come from
 * the extension's own functions instead.
 */
async function databaseSizes(env: Env): Promise<Overview['database']> {
	const [[db], tables] = await Promise.all([
		env.db.execute(
			sql`SELECT pg_database_size(current_database())::float8 AS bytes`
		) as unknown as Promise<{ bytes: number }[]>,
		env.db.execute(sql`
			SELECT c.relname AS name, greatest(c.reltuples, 0)::float8 AS rows,
			       pg_total_relation_size(c.oid)::float8 AS bytes
			FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')`) as unknown as Promise<TableSize[]>
	]);
	const byName = new Map(
		tables.map((t) => [t.name, { ...t, rows: Number(t.rows), bytes: Number(t.bytes) }])
	);
	if (env.timescale) {
		const hyper = (await env.db.execute(sql`
			SELECT hypertable_name AS name,
			       hypertable_size(format('%I.%I', hypertable_schema, hypertable_name))::float8 AS bytes,
			       approximate_row_count(format('%I.%I', hypertable_schema, hypertable_name))::float8 AS rows
			FROM timescaledb_information.hypertables WHERE hypertable_schema = 'public'`)) as unknown as TableSize[];
		for (const h of hyper)
			byName.set(h.name, { name: h.name, rows: Number(h.rows), bytes: Number(h.bytes) });
	}
	return {
		bytes: Number(db.bytes),
		tables: [...byName.values()].sort((a, b) => b.bytes - a.bytes)
	};
}

// ---- players seen: the one heavy read, cached -------------------------------------------------

let seenCache: PlayersSeen | null = null;
let seenInFlight: Promise<PlayersSeen> | null = null;

async function playersSeen(env: Env, force: boolean): Promise<PlayersSeen | null> {
	const fresh = seenCache && Date.now() - Date.parse(seenCache.at) < SEEN_TTL_MS;
	if (fresh && !force) return seenCache;
	if (!seenInFlight)
		seenInFlight = countSeen(env).finally(() => {
			seenInFlight = null;
		});
	// A poll that finds the tally stale shows the old one while the new one is counted; a recount waits.
	if (seenCache && !force) return seenCache;
	seenCache = await seenInFlight;
	return seenCache;
}

async function countSeen(env: Env): Promise<PlayersSeen> {
	const [row] = (await env.db.execute(sql`
		SELECT count(DISTINCT steam_id) FILTER (WHERE last_seen > now() - interval '1 day')::int AS today,
		       count(DISTINCT steam_id) FILTER (WHERE last_seen > now() - interval '30 days')::int AS month,
		       count(DISTINCT steam_id)::int AS all
		FROM player_sessions`)) as unknown as { today: number; month: number; all: number }[];
	return { today: row.today, month: row.month, all: row.all, at: new Date().toISOString() };
}

/** Test-only. */
export function resetSeenCache(): void {
	seenCache = null;
	seenInFlight = null;
}
