// Everyone an organisation has seen: one row per SteamID built from player_sessions on the org's
// servers the viewer can open, with every name they played under, the names the other players saw
// for them in the game's anonymous mode (the sessions' hidden names, $lib/anonymous) and the names
// the kill feed showed for them there that were neither (player_aliases). A player who never joined
// one of those servers cannot appear here, whatever is searched for.
import { sql, type SQL } from 'drizzle-orm';
import type { Env } from './env';
import { getProfiles } from './steam';
import { int, str } from './http';

export const SEEN_SORTS = [
	'lastSeen',
	'firstSeen',
	'minutes',
	'sessions',
	'kills',
	'deaths',
	'name'
] as const;
export type SeenSort = (typeof SEEN_SORTS)[number];

export interface SeenFilters {
	/** matches any name used, any hidden name the other players saw for them or any name shown in
	 *  the kill feed (contains), or the SteamID (prefix) */
	q: string;
	/** seen in the last N days; null for ever */
	since: number | null;
	/** only players who have been on this server (history still spans the org) */
	serverId: string;
	flag: 'banned' | 'watched' | 'online' | '';
	sort: SeenSort;
	dir: 'asc' | 'desc';
}

export function seenFilters(p: URLSearchParams): SeenFilters {
	const sortRaw = p.get('sort') || '';
	const sort = (SEEN_SORTS as readonly string[]).includes(sortRaw)
		? (sortRaw as SeenSort)
		: 'lastSeen';
	const sinceDays = int(p.get('since'), 0, 0, 3650);
	const since = sinceDays > 0 ? sinceDays : null;
	const flagRaw = p.get('flag');
	return {
		q: str(p.get('q'), 100).trim(),
		since,
		serverId: str(p.get('server'), 100),
		flag: flagRaw === 'banned' || flagRaw === 'watched' || flagRaw === 'online' ? flagRaw : '',
		sort,
		dir: p.get('dir') === 'asc' ? 'asc' : sort === 'name' ? 'asc' : 'desc'
	};
}

export interface SeenPlayer {
	steamId: string;
	/** the name used most recently */
	name: string;
	/** every other name seen, most recent first */
	aliases: string[];
	/** the names the other players saw for them while they played in anonymous mode */
	hiddenNames: string[];
	/** the names the kill feed showed for them that were not the ones the server listed them under,
	 *  most recent first */
	feedNames: string[];
	firstSeen: string;
	lastSeen: string;
	sessions: number;
	minutes: number;
	kills: number;
	deaths: number;
	/** servers in the org they have been on */
	servers: number;
	online: boolean;
	lastServerId: string;
	lastServerName: string;
	/** on the org's ban list, or banned on one of its servers */
	banned: 'org' | 'server' | null;
	watched: boolean;
	steam: { persona: string; avatar: string } | null;
}

interface Row extends Record<string, unknown> {
	steamId: string;
	name: string;
	names: string[];
	hiddenNames: string[] | null;
	feedNames: string[] | null;
	lastServerId: string;
	lastServerName: string | null;
	firstSeen: Date;
	lastSeen: Date;
	sessions: number;
	minutes: number;
	kills: number;
	deaths: number;
	servers: number;
	online: boolean;
	orgBanned: boolean;
	serverBanned: boolean;
	watched: boolean;
	total: number;
}

const ORDER: Record<SeenSort, string> = {
	lastSeen: 'last_seen',
	firstSeen: 'first_seen',
	minutes: 'minutes',
	sessions: 'sessions',
	kills: 'kills',
	deaths: 'deaths',
	name: 'lower(name)'
};

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function seenPlayers(
	env: Env,
	opts: {
		orgId: string;
		/** the org's servers the viewer may open; the only source of rows */
		serverIds: string[];
		filters: SeenFilters;
		limit: number;
		offset: number;
		/** attach Steam personas (from the panel's cache, filled where a key is set) */
		steam?: boolean;
	}
): Promise<{ players: SeenPlayer[]; total: number }> {
	const { orgId, filters: f } = opts;
	const ids = opts.serverIds;
	if (!ids.length) return { players: [], total: 0 };
	const limit = Math.max(1, Math.min(1000, opts.limit));
	const offset = Math.max(0, opts.offset);

	const conds: SQL[] = [];
	if (f.q) {
		const q = f.q;
		const like = '%' + likeEscape(q) + '%';
		const named = sql`(EXISTS (SELECT 1 FROM unnest(names) n WHERE n ILIKE ${like})
		                   OR EXISTS (SELECT 1 FROM unnest(hidden_names) n WHERE n ILIKE ${like})
		                   OR EXISTS (SELECT 1 FROM unnest(feed_names) n WHERE n ILIKE ${like}))`;
		conds.push(/^\d+$/.test(q) ? sql`(steam_id LIKE ${q + '%'} OR ${named})` : named);
	}
	if (f.since) conds.push(sql`last_seen >= now() - (${f.since} * interval '1 day')`);
	if (f.serverId && ids.includes(f.serverId)) conds.push(sql`on_server`);
	if (f.flag === 'banned') conds.push(sql`(org_banned OR server_banned)`);
	if (f.flag === 'watched') conds.push(sql`watched`);
	if (f.flag === 'online') conds.push(sql`online`);
	const where = conds.length ? sql`WHERE ${sql.join(conds, sql` AND `)}` : sql``;
	const order = sql.raw(`${ORDER[f.sort]} ${f.dir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`);
	const serverFilter = f.serverId || '';
	// "Seen in the last N days" is decided before the grouping, not after it: the players with a
	// session that recent come off the (server, last_seen) index, and only their histories are
	// read, rather than every session the servers ever had. The totals still span all their time.
	// A whole SteamID64 names one player: only that player's sessions are read.
	const one = /^\d{17}$/.test(f.q) ? sql`AND steam_id = ${f.q}` : sql``;
	const recent = f.since
		? sql`AND steam_id IN (SELECT steam_id FROM player_sessions
		                        WHERE server_id IN ${ids}
		                          AND last_seen >= now() - (${f.since} * interval '1 day')
		                          AND (left_at IS NULL OR left_at >= now() - (${f.since} * interval '1 day')))`
		: sql``;

	const rows = await env.db.execute<Row>(sql`
		WITH agg AS (
			SELECT steam_id,
			       (array_agg(name ORDER BY last_seen DESC))[1] AS name,
			       (array_agg(DISTINCT name)) AS names,
			       (array_agg(DISTINCT hidden_name) FILTER (WHERE hidden_name IS NOT NULL)) AS hidden_names,
			       (array_agg(server_id ORDER BY last_seen DESC))[1] AS last_server_id,
			       MIN(joined_at) AS first_seen,
			       MAX(last_seen) AS last_seen,
			       COUNT(*)::int AS sessions,
			       (SUM(EXTRACT(EPOCH FROM (COALESCE(left_at, now()) - joined_at))) / 60)::int AS minutes,
			       SUM(kills)::int AS kills,
			       SUM(deaths)::int AS deaths,
			       COUNT(DISTINCT server_id)::int AS servers,
			       BOOL_OR(left_at IS NULL) AS online,
			       BOOL_OR(server_id = ${serverFilter}) AS on_server
			  FROM player_sessions
			 WHERE server_id IN ${ids} ${one} ${recent}
			 GROUP BY steam_id
		), fed AS (
			SELECT steam_id, array_agg(name ORDER BY seen DESC) AS feed_names
			  FROM (SELECT steam_id, name, MAX(last_seen) AS seen
			          FROM player_aliases WHERE server_id IN ${ids}
			         GROUP BY steam_id, name) n
			 GROUP BY steam_id
		), flagged AS (
			SELECT a.*, s.name AS last_server_name, f.feed_names,
			       EXISTS (SELECT 1 FROM list_entries e JOIN lists l ON l.id = e.list_id
			                WHERE l.org_id = ${orgId} AND l.server_id IS NULL AND l.kind = 'ban'
			                  AND e.removed_at IS NULL
			                  AND (e.expires_at IS NULL OR e.expires_at > now())
			                  AND e.steam_id = a.steam_id) AS org_banned,
			       -- held by one of these servers, or waiting on its own list for the player to join;
			       -- another server's own list is that server's business
			       (EXISTS (SELECT 1 FROM server_bans b
			                 WHERE b.server_id IN ${ids} AND b.steam_id = a.steam_id)
			        OR EXISTS (SELECT 1 FROM list_entries e JOIN lists l ON l.id = e.list_id
			                    WHERE l.server_id IN ${ids} AND l.kind = 'ban' AND e.removed_at IS NULL
			                      AND (e.expires_at IS NULL OR e.expires_at > now())
			                      AND e.steam_id = a.steam_id)) AS server_banned,
			       EXISTS (SELECT 1 FROM player_marks m
			                WHERE m.org_id = ${orgId} AND m.watched AND m.steam_id = a.steam_id) AS watched
			  FROM agg a LEFT JOIN servers s ON s.id = a.last_server_id
			  LEFT JOIN fed f ON f.steam_id = a.steam_id
		)
		SELECT steam_id AS "steamId", name, names, hidden_names AS "hiddenNames",
		       feed_names AS "feedNames",
		       last_server_id AS "lastServerId",
		       last_server_name AS "lastServerName", first_seen AS "firstSeen", last_seen AS "lastSeen",
		       sessions, minutes, kills, deaths, servers, online,
		       org_banned AS "orgBanned", server_banned AS "serverBanned", watched,
		       COUNT(*) OVER ()::int AS total
		  FROM flagged ${where}
		 ORDER BY ${order}, steam_id
		 LIMIT ${limit} OFFSET ${offset}`);

	const steam = opts.steam
		? await getProfiles(
				env,
				rows.map((r) => r.steamId)
			)
		: new Map();
	const players: SeenPlayer[] = rows.map((r) => {
		const s = steam.get(r.steamId);
		return {
			steamId: r.steamId,
			name: r.name,
			aliases: (r.names || []).filter((n: string) => n !== r.name),
			hiddenNames: r.hiddenNames || [],
			// a name the feed showed that they also played under, as their own or as their hidden one,
			// is no other name
			feedNames: (r.feedNames || []).filter(
				(n: string) => !(r.names || []).includes(n) && !(r.hiddenNames || []).includes(n)
			),
			firstSeen: r.firstSeen.toISOString(),
			lastSeen: r.lastSeen.toISOString(),
			sessions: r.sessions,
			minutes: r.minutes,
			kills: r.kills,
			deaths: r.deaths,
			servers: r.servers,
			online: r.online,
			lastServerId: r.lastServerId,
			lastServerName: r.lastServerName ?? '',
			banned: r.orgBanned ? 'org' : r.serverBanned ? 'server' : null,
			watched: r.watched,
			steam: s ? { persona: s.persona, avatar: s.avatar } : null
		};
	});
	return { players, total: rows[0]?.total ?? 0 };
}
