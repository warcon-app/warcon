-- Kills and deaths from the feed for the matches 0032 filled from the sessions (issues #31, #18).
-- 0032 gave a session's counters to the last match it overlapped and zero to the earlier ones.
-- Until 66fa7a6 a session's counters were its last match's alone; after it they were the sum of
-- its matches, so a sum sat on one match. The feed's count is a match's own where the feed saw the
-- whole match, as the worker counts it (feedRecord in match-players.ts): a kill is a row the
-- player is the killer of that is neither a suicide nor a team kill, and every row the player is
-- the victim of is a death. Nothing is taken from a player's totals and nothing counted twice.
--
-- 0032's matches ended before the first match with a row whose cash moved ended: 0032 never wrote
-- a change in cash and the worker writes one in nearly every match it closes, so that end is when
-- this install's worker began writing rows (installs took 0031 on different days), and 0032's
-- sessions closed before it. Only rows of those sessions are written: a row of such a match that
-- the worker wrote for a session it closed later is its own. An install taking 0031 and this in
-- one upgrade has no such end yet and keeps 0032's rows as they are. The feed saw the whole match
-- when the match has final scores, its server's first kill came before it started, its own first
-- and last kills (by match_row) came within 5 minutes of its start and end, and its clock
-- (event_time) never runs back more than 5 s in the order the kills arrived (a game restart). In
-- those matches, covered, a row's count starts from the feed's, as below, and a row whose side is
-- not on the match's scoreboard (the holding side, White, or none) takes the scoreboard side the
-- feed stamped on the player's kills and deaths there, when it shows exactly one. A player the
-- feed saw with no row gets none: a row needs a name, time on and a side, for few kills (on
-- warcon.app 652 of them, with 4,470 kills).
--
-- Each of 0032's sessions over a covered match, by when its counters dropped (the starts of its
-- matches after the first) against when the install switched to 66fa7a6:
--   - summing, every drop after the switch (a session open across it too: the restarted worker
--     took its counters as they stood): its counters less the feed over its covered matches,
--     floored at 0, are its last uncovered match of 0032's (which held 0, or the sum when it is
--     the last), or are added to its own last when all are covered;
--   - single, every drop before the switch, or none: a covered last match takes the larger of the
--     feed and the counters; an uncovered one keeps them, and its covered matches get the feed;
--   - held, a drop inside the switch window or drops on both sides, or a sum ending in a match
--     that is not 0032's: every row of it stays as 0032 wrote it, and so does every row of the
--     sessions of the same player it shares a match with (a rejoin), as do two or more sessions
--     sharing matches when one of them sums (their parts of a shared match cannot be told apart).
-- The switch is inferred: never before 66fa7a6 was written (2026-09-20 22:41:46 UTC). The
-- sessions closed after that, over two or more covered matches, whose counters are within 2 plus
-- 10% of the feed's sum and further than twice that from their last match's are summing, and the
-- reverse single (on warcon.app the counters of sessions known by their time are that close on
-- 95%; the feed misses some kills). A switch at time t is contradicted by a single one whose last
-- drop is after t and by a summing one whose first drop is before t; the window is every such
-- time contradicted by at most 1% of them more than the best time is, so a stray session (a
-- worker restart, a dropped feed batch) does not move it. With no summing session the switch is
-- unknown and every session with a drop after 66fa7a6 was written is held.
--
-- Order: the bound, the matches, the feed's numbers, the sessions and the rows to write, each into
-- a temporary table, holding nothing a writer needs (what they read has stopped changing), the
-- tables analyzed so that each join is planned on real numbers; the rows already as they would be
-- written are dropped from the last, so a second run, or rows put right by hand, writes and
-- rebuilds nothing (a purge before the lock only leaves fewer to write). Then the rows and the
-- totals kept from them (player_totals, player_days) as 0038 says a bulk load does: the sources
-- locked against writes in the writers' order (sessions, lines, matches), the lines' update
-- trigger off, the update, the rebuild (only when there is a row to write), the trigger on again,
-- in the migration's one transaction. A match's kills arrive while it is open, so reading the
-- kills up to 2 minutes past the bound reads them all, from the oldest chunks only. On warcon.app
-- (2026-10-09): switch window 2026-09-20 23:19 to 00:13 UTC, 79,925 rows to write, under a minute
-- before the lock; the update and the rebuild hold the sources for 1 to 2 minutes: deploy it in a
-- quiet hour.
CREATE TEMP TABLE "fed_bound" ON COMMIT DROP AS
SELECT MIN(m.ended_at) AS e FROM matches m
 WHERE EXISTS (SELECT 1 FROM match_players p WHERE p.match_id = m.id AND p.cash_delta <> 0);--> statement-breakpoint
CREATE TEMP TABLE "fed_matches" ON COMMIT DROP AS
WITH feed AS (
	SELECT k.server_id, k.match_row, k.ts,
	       LAG(k.event_time) OVER (PARTITION BY k.match_row ORDER BY k.ts, k.event_time) - k.event_time AS back
	  FROM kills k
	 WHERE k.ts <= (SELECT e FROM fed_bound) + interval '2 minutes'
)
SELECT m.id, m.server_id, m.ended_at, m.final_scores
  FROM matches m
  JOIN (SELECT server_id, MIN(ts) AS since FROM feed GROUP BY server_id) s ON s.server_id = m.server_id
  JOIN (SELECT match_row, MIN(ts) AS first_at, MAX(ts) AS last_at, COUNT(*) FILTER (WHERE back > 5) AS resets
          FROM feed GROUP BY match_row) f ON f.match_row = m.id
 WHERE m.ended_at < (SELECT e FROM fed_bound)
   AND CASE WHEN jsonb_typeof(m.final_scores) = 'array' THEN jsonb_array_length(m.final_scores) END > 0
   AND s.since < m.started_at AND f.resets = 0
   AND f.first_at <= m.started_at + interval '5 minutes' AND f.last_at >= m.ended_at - interval '5 minutes';--> statement-breakpoint
ANALYZE "fed_matches";--> statement-breakpoint
CREATE TEMP TABLE "fed_lines" ON COMMIT DROP AS
WITH sides AS (
	SELECT c.id AS match_id, x.steam_id, x.faction,
	       COUNT(*) FILTER (WHERE x.killer AND NOT k.suicide AND NOT k.team_kill) AS kills,
	       COUNT(*) FILTER (WHERE NOT x.killer) AS deaths
	  FROM fed_matches c
	  JOIN kills k ON k.match_row = c.id AND k.server_id = c.server_id
	  CROSS JOIN LATERAL (VALUES (k.killer_steam_id, k.killer_faction, true),
	                             (k.victim_steam_id, k.victim_faction, false)) x(steam_id, faction, killer)
	 WHERE k.ts <= (SELECT MAX(ended_at) FROM fed_matches) + interval '2 minutes' AND x.steam_id IS NOT NULL
	 GROUP BY 1, 2, 3
),
players AS (
	SELECT n.match_id, n.steam_id, SUM(n.kills) AS kills, SUM(n.deaths) AS deaths,
	       COUNT(*) FILTER (WHERE e.on_board) AS sides, MIN(n.faction) FILTER (WHERE e.on_board) AS side
	  FROM sides n
	  JOIN fed_matches c ON c.id = n.match_id
	  CROSS JOIN LATERAL (
		SELECT EXISTS (SELECT 1 FROM jsonb_array_elements(c.final_scores) s WHERE s->>'name' = n.faction) AS on_board) e
	 GROUP BY 1, 2
)
SELECT p.match_id, p.server_id, p.steam_id, COALESCE(n.kills, 0)::int AS kills, COALESCE(n.deaths, 0)::int AS deaths,
       CASE WHEN n.sides = 1
                 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(c.final_scores) s WHERE s->>'name' = p.faction)
            THEN n.side ELSE p.faction END AS faction
  FROM fed_matches c
  JOIN match_players p ON p.match_id = c.id AND p.server_id = c.server_id
  LEFT JOIN players n ON n.match_id = p.match_id AND n.steam_id = p.steam_id;--> statement-breakpoint
ANALYZE "fed_lines";--> statement-breakpoint
CREATE TEMP TABLE "fed_spans" ON COMMIT DROP AS
WITH s AS (
	SELECT ps.id, ps.server_id, ps.steam_id, ps.joined_at, ps.left_at, ps.kills, ps.deaths
	  FROM player_sessions ps
	  JOIN (SELECT DISTINCT server_id, steam_id FROM fed_lines) k ON k.server_id = ps.server_id AND k.steam_id = ps.steam_id
	 WHERE ps.left_at < (SELECT e FROM fed_bound)
),
b AS (
	SELECT s.*, a.id AS last_id,
	       CASE WHEN p.id IS NOT NULL AND COALESCE(p.ended_at, now()) > s.joined_at THEN p.id ELSE n.id END AS first_id
	  FROM s
	  LEFT JOIN LATERAL (SELECT id FROM matches m WHERE m.server_id = s.server_id AND m.started_at < s.left_at
	                      ORDER BY m.started_at DESC LIMIT 1) a ON true
	  LEFT JOIN LATERAL (SELECT id, ended_at FROM matches m WHERE m.server_id = s.server_id AND m.started_at <= s.joined_at
	                      ORDER BY m.started_at DESC LIMIT 1) p ON true
	  LEFT JOIN LATERAL (SELECT id FROM matches m WHERE m.server_id = s.server_id AND m.started_at > s.joined_at
	                      ORDER BY m.started_at LIMIT 1) n ON true
)
SELECT b.id AS sid, b.server_id, b.steam_id, b.left_at, b.kills, b.deaths, b.first_id, b.last_id,
       m.id AS match_id, m.started_at, COALESCE(m.ended_at < (SELECT e FROM fed_bound), false) AS old,
       c.id IS NOT NULL AS covered, COALESCE(f.kills, 0) AS fk, COALESCE(f.deaths, 0) AS fd
  FROM b
  JOIN matches m ON m.server_id = b.server_id AND m.id BETWEEN b.first_id AND b.last_id
  LEFT JOIN fed_matches c ON c.id = m.id
  LEFT JOIN fed_lines f ON f.match_id = m.id AND f.steam_id = b.steam_id
 WHERE b.first_id <= b.last_id;--> statement-breakpoint
ANALYZE "fed_spans";--> statement-breakpoint
CREATE TEMP TABLE "fed_sessions" ON COMMIT DROP AS
SELECT x.*, SUM(x.brk) OVER (PARTITION BY x.server_id, x.steam_id ORDER BY x.first_id, x.last_id, x.sid) AS chain
  FROM (
	SELECT a.*,
	       CASE WHEN a.first_id <= MAX(a.last_id) OVER (PARTITION BY a.server_id, a.steam_id ORDER BY a.first_id, a.last_id, a.sid
	                                                    ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)
	            THEN 0 ELSE 1 END AS brk
	  FROM (
		SELECT sid, server_id, steam_id, left_at, kills, deaths, first_id, last_id, COUNT(*) AS n,
		       (array_agg(started_at ORDER BY match_id))[2] AS second_start,
		       MAX(started_at) FILTER (WHERE match_id = last_id) AS last_start,
		       bool_and(covered) AS all_cov, bool_or(covered AND match_id = last_id) AS last_cov,
		       bool_or(old AND match_id = last_id) AS last_old,
		       COALESCE(SUM(fk) FILTER (WHERE covered), 0) AS fk, COALESCE(SUM(fd) FILTER (WHERE covered), 0) AS fd,
		       MAX(fk) FILTER (WHERE match_id = last_id) AS lk, MAX(fd) FILTER (WHERE match_id = last_id) AS ld,
		       COALESCE(MAX(match_id) FILTER (WHERE old AND NOT covered), last_id) AS target
		  FROM fed_spans GROUP BY 1, 2, 3, 4, 5, 6, 7, 8) a
  ) x;--> statement-breakpoint
ANALYZE "fed_sessions";--> statement-breakpoint
CREATE TEMP TABLE "fed_rows" ON COMMIT DROP AS
WITH labelled AS (
	SELECT CASE WHEN dsum <= tol AND dlast > 2 * tol THEN 'sum' ELSE 'single' END AS looks,
	       CASE WHEN dsum <= tol AND dlast > 2 * tol THEN second_start ELSE last_start END AS t
	  FROM (SELECT second_start, last_start, abs(kills - fk) + abs(deaths - fd) AS dsum,
	               abs(kills - lk) + abs(deaths - ld) AS dlast, 2 + (kills + deaths) / 10.0 AS tol
	          FROM fed_sessions
	         WHERE left_at >= timestamptz '2026-09-20 22:41:46+00' AND n >= 2 AND all_cov) d
	 WHERE (dsum <= tol AND dlast > 2 * tol) OR (dlast <= tol AND dsum > 2 * tol)
),
against AS (
	SELECT t,
	       COUNT(*) FILTER (WHERE looks = 'sum') OVER (ORDER BY t RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE GROUP)
	       + COUNT(*) FILTER (WHERE looks = 'single') OVER (ORDER BY t RANGE BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING EXCLUDE GROUP) AS n
	  FROM (SELECT looks, t FROM labelled UNION ALL SELECT NULL, timestamptz '2026-09-20 22:41:46+00') e
),
switch AS (
	SELECT MIN(t) AS lo, CASE WHEN EXISTS (SELECT 1 FROM labelled WHERE looks = 'sum') THEN MAX(t) END AS hi
	  FROM against
	 WHERE t >= timestamptz '2026-09-20 22:41:46+00'
	   AND n <= (SELECT MIN(n) FROM against WHERE t >= timestamptz '2026-09-20 22:41:46+00') + (SELECT COUNT(*) FROM labelled) / 100
),
kinds AS (
	SELECT x.*, CASE WHEN x.n = 1 OR x.last_start <= w.lo THEN 'single' WHEN x.second_start >= w.hi THEN 'sum' END AS kind
	  FROM fed_sessions x CROSS JOIN switch w
),
chains AS (
	SELECT server_id, steam_id, chain,
	       bool_or(kind IS NULL OR (kind = 'sum' AND NOT last_old)) OR (COUNT(*) > 1 AND bool_or(kind = 'sum')) AS held
	  FROM kinds GROUP BY 1, 2, 3
),
live AS (
	SELECT k.* FROM kinds k JOIN chains c ON c.server_id = k.server_id AND c.steam_id = k.steam_id AND c.chain = k.chain
	 WHERE NOT c.held
),
held AS (
	SELECT DISTINCT sp.match_id, sp.steam_id
	  FROM fed_spans sp JOIN kinds k ON k.sid = sp.sid
	  JOIN chains c ON c.server_id = k.server_id AND c.steam_id = k.steam_id AND c.chain = k.chain
	 WHERE c.held
),
ends AS (
	SELECT last_id AS match_id, steam_id, MAX(kills) AS kills, MAX(deaths) AS deaths
	  FROM live WHERE kind = 'single' AND last_cov GROUP BY 1, 2
),
rest AS (
	SELECT target AS match_id, steam_id, GREATEST(kills - fk, 0) AS kills, GREATEST(deaths - fd, 0) AS deaths
	  FROM live WHERE kind = 'sum'
)
SELECT f.match_id, f.steam_id,
       GREATEST(f.kills, COALESCE(e.kills, 0)) + COALESCE(r.kills, 0) AS kills,
       GREATEST(f.deaths, COALESCE(e.deaths, 0)) + COALESCE(r.deaths, 0) AS deaths, f.faction
  FROM fed_lines f
  LEFT JOIN ends e ON e.match_id = f.match_id AND e.steam_id = f.steam_id
  LEFT JOIN rest r ON r.match_id = f.match_id AND r.steam_id = f.steam_id
 WHERE EXISTS (SELECT 1 FROM fed_spans sp WHERE sp.match_id = f.match_id AND sp.steam_id = f.steam_id)
   AND NOT EXISTS (SELECT 1 FROM held h WHERE h.match_id = f.match_id AND h.steam_id = f.steam_id)
UNION ALL
SELECT r.match_id, r.steam_id, r.kills, r.deaths, p.faction
  FROM rest r JOIN match_players p ON p.match_id = r.match_id AND p.steam_id = r.steam_id
 WHERE NOT EXISTS (SELECT 1 FROM fed_matches c WHERE c.id = r.match_id);--> statement-breakpoint
DELETE FROM fed_rows f USING match_players p
 WHERE p.match_id = f.match_id AND p.steam_id = f.steam_id
   AND (p.kills, p.deaths, p.faction) IS NOT DISTINCT FROM (f.kills, f.deaths, f.faction);--> statement-breakpoint
LOCK TABLE "player_sessions", "match_players", "matches" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "match_players" DISABLE TRIGGER "player_totals_lines_updated";--> statement-breakpoint
UPDATE match_players p
   SET kills = f.kills, deaths = f.deaths, faction = f.faction
  FROM fed_rows f
 WHERE p.match_id = f.match_id AND p.steam_id = f.steam_id
   AND (p.kills, p.deaths, p.faction) IS DISTINCT FROM (f.kills, f.deaths, f.faction);--> statement-breakpoint
SELECT player_totals_rebuild() WHERE EXISTS (SELECT 1 FROM fed_rows);--> statement-breakpoint
ALTER TABLE "match_players" ENABLE TRIGGER "player_totals_lines_updated";
