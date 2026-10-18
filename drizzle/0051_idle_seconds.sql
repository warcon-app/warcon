-- Idle time: of a player's time on in a match, the part before any side had scored, while the match
-- waited for its players (the game's MatchState.PreMatch.WaitingForPlayers). Kills per hour leaves
-- it out, as it leaves out seed time, so a player who seeds for hours before a match goes live is
-- not ranked as if those hours were played. The worker tallies it beside `seconds` (tallyLook);
-- lines written before this have 0, which is what they counted before.
--
-- The totals and day rows carry the lines' sum like the other line columns. The functions below are
-- 0038's player_totals_recount and 0039's player_days_recount, player_lines_cleared,
-- player_totals_match_ended, player_days_rebuild and player_totals_rebuild, each with idle_seconds
-- added and nothing else changed. Every existing line has 0, so the rows need no rebuild: their 0 is already the sum.
ALTER TABLE "match_players" ADD COLUMN "idle_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_days" ADD COLUMN "idle_seconds" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "player_totals" ADD COLUMN "idle_seconds" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "player_totals_recount"(sid text, pids text[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	PERFORM player_totals_lock(sid);
	INSERT INTO player_totals AS t (server_id, steam_id, sessions, seconds, seed_seconds, cash, last_seen,
	                                matches, kills, deaths, headshots, team_kills, suicides, vehicle_kills,
	                                kill_streak, death_streak, wins, losses, draws, idle_seconds)
	SELECT sid, p.steam_id, s.sessions, s.seconds, s.seed_seconds, s.cash, s.last_seen,
	       l.matches, l.kills, l.deaths, l.headshots, l.team_kills, l.suicides, l.vehicle_kills,
	       l.kill_streak, l.death_streak, l.wins, l.losses, l.draws, l.idle_seconds
	  FROM (SELECT DISTINCT unnest(pids) AS steam_id) p
	  CROSS JOIN LATERAL (
		SELECT COUNT(*)::int AS sessions,
		       COALESCE(SUM(EXTRACT(EPOCH FROM (ps.left_at - ps.joined_at))), 0) AS seconds,
		       COALESCE(SUM(ps.seed_seconds), 0) AS seed_seconds, COALESCE(SUM(ps.cash), 0) AS cash,
		       MAX(ps.last_seen) AS last_seen
		  FROM player_sessions ps
		 WHERE ps.steam_id = p.steam_id AND ps.server_id = sid AND ps.left_at IS NOT NULL) s
	  CROSS JOIN LATERAL (
		SELECT COUNT(*)::int AS matches, COALESCE(SUM(mp.kills), 0) AS kills, COALESCE(SUM(mp.deaths), 0) AS deaths,
		       COALESCE(SUM(mp.headshots), 0) AS headshots, COALESCE(SUM(mp.team_kills), 0) AS team_kills,
		       COALESCE(SUM(mp.suicides), 0) AS suicides, COALESCE(SUM(mp.vehicle_kills), 0) AS vehicle_kills,
		       COALESCE(MAX(mp.kill_streak), 0) AS kill_streak, COALESCE(MAX(mp.death_streak), 0) AS death_streak,
		       (COUNT(*) FILTER (WHERE x.r = 'win'))::int AS wins,
		       (COUNT(*) FILTER (WHERE x.r = 'loss'))::int AS losses,
		       (COUNT(*) FILTER (WHERE x.r = 'draw'))::int AS draws,
		       COALESCE(SUM(mp.idle_seconds), 0) AS idle_seconds
		  FROM match_players mp
		  JOIN matches m ON m.id = mp.match_id AND m.server_id = mp.server_id
		  CROSS JOIN LATERAL (SELECT match_result(m.final_scores, m.winner, mp.faction) AS r) x
		 WHERE mp.steam_id = p.steam_id AND mp.server_id = sid AND m.ended_at IS NOT NULL) l
	ON CONFLICT (server_id, steam_id) DO UPDATE SET
		sessions = EXCLUDED.sessions, seconds = EXCLUDED.seconds, seed_seconds = EXCLUDED.seed_seconds,
		cash = EXCLUDED.cash, last_seen = EXCLUDED.last_seen, matches = EXCLUDED.matches, kills = EXCLUDED.kills,
		deaths = EXCLUDED.deaths, headshots = EXCLUDED.headshots, team_kills = EXCLUDED.team_kills,
		suicides = EXCLUDED.suicides, vehicle_kills = EXCLUDED.vehicle_kills, kill_streak = EXCLUDED.kill_streak,
		death_streak = EXCLUDED.death_streak, wins = EXCLUDED.wins, losses = EXCLUDED.losses, draws = EXCLUDED.draws,
		idle_seconds = EXCLUDED.idle_seconds;
	DELETE FROM player_totals WHERE server_id = sid AND steam_id = ANY (pids) AND sessions = 0 AND matches = 0;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "player_days_recount"(sid text, pids text[], days date[]) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	PERFORM player_totals_lock(sid);
	INSERT INTO player_days AS t (server_id, day, steam_id, seconds, crossings, sessions, seed_seconds, cash, last_seen,
	                              matches, kills, deaths, headshots, team_kills, suicides, vehicle_kills,
	                              kill_streak, death_streak, wins, losses, draws, idle_seconds)
	WITH k AS (SELECT DISTINCT u.p, u.d FROM unnest(pids, days) AS u(p, d) WHERE u.d IS NOT NULL),
	c AS (
		SELECT DISTINCT ps.id, ps.steam_id, ps.joined_at, ps.left_at, ps.seed_seconds, ps.cash, ps.last_seen
		  FROM k JOIN player_sessions ps ON ps.steam_id = k.p AND ps.server_id = sid AND ps.left_at IS NOT NULL
		   AND ps.left_at >= k.d::timestamp AT TIME ZONE 'UTC'
		   AND LEAST(ps.joined_at, ps.left_at) < (k.d + 1)::timestamp AT TIME ZONE 'UTC'),
	s AS (
		SELECT c.steam_id AS p, x.day AS d, SUM(x.seconds) AS seconds,
		       array_agg(c.joined_at ORDER BY c.joined_at) FILTER (WHERE x.crossing) AS crossings,
		       (COUNT(*) FILTER (WHERE x.closes))::int AS sessions,
		       COALESCE(SUM(c.seed_seconds) FILTER (WHERE x.closes), 0) AS seed_seconds,
		       COALESCE(SUM(c.cash) FILTER (WHERE x.closes), 0) AS cash,
		       MAX(c.last_seen) FILTER (WHERE x.closes) AS last_seen
		  FROM c CROSS JOIN LATERAL (
		         SELECT p.day, p.seconds, p.crossing, p.day = (c.left_at AT TIME ZONE 'UTC')::date AS closes
		           FROM session_day_parts(c.joined_at, c.left_at) p) x
		  JOIN k ON k.p = c.steam_id AND k.d = x.day
		 GROUP BY 1, 2),
	l AS (
		SELECT k.p, k.d, COUNT(*)::int AS matches, SUM(mp.kills) AS kills, SUM(mp.deaths) AS deaths,
		       SUM(mp.headshots) AS headshots, SUM(mp.team_kills) AS team_kills, SUM(mp.suicides) AS suicides,
		       SUM(mp.vehicle_kills) AS vehicle_kills, MAX(mp.kill_streak) AS kill_streak,
		       MAX(mp.death_streak) AS death_streak,
		       (COUNT(*) FILTER (WHERE x.r = 'win'))::int AS wins,
		       (COUNT(*) FILTER (WHERE x.r = 'loss'))::int AS losses,
		       (COUNT(*) FILTER (WHERE x.r = 'draw'))::int AS draws,
		       SUM(mp.idle_seconds) AS idle_seconds
		  FROM k JOIN match_players mp ON mp.steam_id = k.p AND mp.server_id = sid
		  JOIN matches m ON m.id = mp.match_id AND m.server_id = mp.server_id
		   AND m.ended_at >= k.d::timestamp AT TIME ZONE 'UTC' AND m.ended_at < (k.d + 1)::timestamp AT TIME ZONE 'UTC'
		  CROSS JOIN LATERAL (SELECT match_result(m.final_scores, m.winner, mp.faction) AS r) x
		 GROUP BY k.p, k.d)
	SELECT sid, k.d, k.p, COALESCE(s.seconds, 0), s.crossings, COALESCE(s.sessions, 0), COALESCE(s.seed_seconds, 0),
	       COALESCE(s.cash, 0), s.last_seen, COALESCE(l.matches, 0), COALESCE(l.kills, 0), COALESCE(l.deaths, 0),
	       COALESCE(l.headshots, 0), COALESCE(l.team_kills, 0), COALESCE(l.suicides, 0), COALESCE(l.vehicle_kills, 0),
	       COALESCE(l.kill_streak, 0), COALESCE(l.death_streak, 0), COALESCE(l.wins, 0), COALESCE(l.losses, 0),
	       COALESCE(l.draws, 0), COALESCE(l.idle_seconds, 0)
	  FROM k LEFT JOIN s ON s.p = k.p AND s.d = k.d LEFT JOIN l ON l.p = k.p AND l.d = k.d
	ON CONFLICT (server_id, day, steam_id) DO UPDATE SET
		seconds = EXCLUDED.seconds, crossings = EXCLUDED.crossings, sessions = EXCLUDED.sessions,
		seed_seconds = EXCLUDED.seed_seconds, cash = EXCLUDED.cash, last_seen = EXCLUDED.last_seen,
		matches = EXCLUDED.matches, kills = EXCLUDED.kills, deaths = EXCLUDED.deaths, headshots = EXCLUDED.headshots,
		team_kills = EXCLUDED.team_kills, suicides = EXCLUDED.suicides, vehicle_kills = EXCLUDED.vehicle_kills,
		kill_streak = EXCLUDED.kill_streak, death_streak = EXCLUDED.death_streak, wins = EXCLUDED.wins,
		losses = EXCLUDED.losses, draws = EXCLUDED.draws, idle_seconds = EXCLUDED.idle_seconds;
	DELETE FROM player_days t USING (SELECT DISTINCT u.p, u.d FROM unnest(pids, days) AS u(p, d)) k
	 WHERE t.server_id = sid AND t.steam_id = k.p AND t.day = k.d
	   AND t.sessions = 0 AND t.matches = 0 AND t.seconds = 0 AND t.crossings IS NULL;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "player_lines_cleared"(sid text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	PERFORM player_totals_lock(sid);
	UPDATE player_totals SET matches = 0, kills = 0, deaths = 0, headshots = 0, team_kills = 0, suicides = 0,
	       vehicle_kills = 0, kill_streak = 0, death_streak = 0, wins = 0, losses = 0, draws = 0, idle_seconds = 0
	 WHERE server_id = sid AND matches > 0;
	DELETE FROM player_totals WHERE server_id = sid AND sessions = 0 AND matches = 0;
	UPDATE player_days SET matches = 0, kills = 0, deaths = 0, headshots = 0, team_kills = 0, suicides = 0,
	       vehicle_kills = 0, kill_streak = 0, death_streak = 0, wins = 0, losses = 0, draws = 0, idle_seconds = 0
	 WHERE server_id = sid AND matches > 0;
	DELETE FROM player_days
	 WHERE server_id = sid AND sessions = 0 AND matches = 0 AND seconds = 0 AND crossings IS NULL;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "player_totals_match_ended"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	PERFORM player_totals_lock(NEW.server_id);
	INSERT INTO player_totals AS t (server_id, steam_id, matches, kills, deaths, headshots, team_kills, suicides,
	                                vehicle_kills, kill_streak, death_streak, wins, losses, draws, idle_seconds)
	SELECT mp.server_id, mp.steam_id, 1, mp.kills, mp.deaths, mp.headshots, mp.team_kills, mp.suicides,
	       mp.vehicle_kills, mp.kill_streak, mp.death_streak,
	       CASE WHEN x.r = 'win' THEN 1 ELSE 0 END, CASE WHEN x.r = 'loss' THEN 1 ELSE 0 END,
	       CASE WHEN x.r = 'draw' THEN 1 ELSE 0 END, mp.idle_seconds
	  FROM match_players mp
	  CROSS JOIN LATERAL (SELECT match_result(NEW.final_scores, NEW.winner, mp.faction) AS r) x
	 WHERE mp.match_id = NEW.id AND mp.server_id = NEW.server_id
	ON CONFLICT (server_id, steam_id) DO UPDATE SET
		matches = t.matches + EXCLUDED.matches, kills = t.kills + EXCLUDED.kills, deaths = t.deaths + EXCLUDED.deaths,
		headshots = t.headshots + EXCLUDED.headshots, team_kills = t.team_kills + EXCLUDED.team_kills,
		suicides = t.suicides + EXCLUDED.suicides, vehicle_kills = t.vehicle_kills + EXCLUDED.vehicle_kills,
		kill_streak = CASE WHEN t.matches = 0 THEN EXCLUDED.kill_streak ELSE GREATEST(t.kill_streak, EXCLUDED.kill_streak) END,
		death_streak = CASE WHEN t.matches = 0 THEN EXCLUDED.death_streak ELSE GREATEST(t.death_streak, EXCLUDED.death_streak) END,
		wins = t.wins + EXCLUDED.wins, losses = t.losses + EXCLUDED.losses, draws = t.draws + EXCLUDED.draws,
		idle_seconds = t.idle_seconds + EXCLUDED.idle_seconds;
	INSERT INTO player_days AS t (server_id, day, steam_id, matches, kills, deaths, headshots, team_kills, suicides,
	                              vehicle_kills, kill_streak, death_streak, wins, losses, draws, idle_seconds)
	SELECT mp.server_id, (NEW.ended_at AT TIME ZONE 'UTC')::date, mp.steam_id, 1, mp.kills, mp.deaths, mp.headshots,
	       mp.team_kills, mp.suicides, mp.vehicle_kills, mp.kill_streak, mp.death_streak,
	       CASE WHEN x.r = 'win' THEN 1 ELSE 0 END, CASE WHEN x.r = 'loss' THEN 1 ELSE 0 END,
	       CASE WHEN x.r = 'draw' THEN 1 ELSE 0 END, mp.idle_seconds
	  FROM match_players mp
	  CROSS JOIN LATERAL (SELECT match_result(NEW.final_scores, NEW.winner, mp.faction) AS r) x
	 WHERE mp.match_id = NEW.id AND mp.server_id = NEW.server_id
	ON CONFLICT (server_id, day, steam_id) DO UPDATE SET
		matches = t.matches + EXCLUDED.matches, kills = t.kills + EXCLUDED.kills, deaths = t.deaths + EXCLUDED.deaths,
		headshots = t.headshots + EXCLUDED.headshots, team_kills = t.team_kills + EXCLUDED.team_kills,
		suicides = t.suicides + EXCLUDED.suicides, vehicle_kills = t.vehicle_kills + EXCLUDED.vehicle_kills,
		kill_streak = CASE WHEN t.matches = 0 THEN EXCLUDED.kill_streak ELSE GREATEST(t.kill_streak, EXCLUDED.kill_streak) END,
		death_streak = CASE WHEN t.matches = 0 THEN EXCLUDED.death_streak ELSE GREATEST(t.death_streak, EXCLUDED.death_streak) END,
		wins = t.wins + EXCLUDED.wins, losses = t.losses + EXCLUDED.losses, draws = t.draws + EXCLUDED.draws,
		idle_seconds = t.idle_seconds + EXCLUDED.idle_seconds;
	RETURN NEW;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "player_days_rebuild"() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM player_sessions WHERE left_at IS NOT NULL AND last_seen IS DISTINCT FROM left_at) THEN
		RAISE EXCEPTION 'a closed player session must have last_seen equal to left_at (migration 0039): player_days not built';
	END IF;
	DELETE FROM player_days;
	INSERT INTO player_days (server_id, day, steam_id, seconds, crossings, sessions, seed_seconds, cash, last_seen,
	                         matches, kills, deaths, headshots, team_kills, suicides, vehicle_kills,
	                         kill_streak, death_streak, wins, losses, draws, idle_seconds)
	WITH results AS (
		SELECT f.match_id, f.faction, match_result(m.final_scores, m.winner, f.faction) AS r
		  FROM (SELECT DISTINCT match_id, faction FROM match_players WHERE faction IS NOT NULL) f
		  JOIN matches m ON m.id = f.match_id
		 WHERE m.ended_at IS NOT NULL),
	s AS (
		SELECT ps.server_id, x.day, ps.steam_id, SUM(x.seconds) AS seconds,
		       array_agg(ps.joined_at ORDER BY ps.joined_at) FILTER (WHERE x.crossing) AS crossings,
		       (COUNT(*) FILTER (WHERE x.closes))::int AS sessions,
		       COALESCE(SUM(ps.seed_seconds) FILTER (WHERE x.closes), 0) AS seed_seconds,
		       COALESCE(SUM(ps.cash) FILTER (WHERE x.closes), 0) AS cash,
		       MAX(ps.last_seen) FILTER (WHERE x.closes) AS last_seen
		  FROM player_sessions ps CROSS JOIN LATERAL (
		         SELECT p.day, p.seconds, p.crossing, p.day = (ps.left_at AT TIME ZONE 'UTC')::date AS closes
		           FROM session_day_parts(ps.joined_at, ps.left_at) p) x
		 WHERE ps.left_at IS NOT NULL
		 GROUP BY 1, 2, 3),
	l AS (
		SELECT mp.server_id, (m.ended_at AT TIME ZONE 'UTC')::date AS day, mp.steam_id, COUNT(*)::int AS matches,
		       SUM(mp.kills) AS kills, SUM(mp.deaths) AS deaths, SUM(mp.headshots) AS headshots,
		       SUM(mp.team_kills) AS team_kills, SUM(mp.suicides) AS suicides, SUM(mp.vehicle_kills) AS vehicle_kills,
		       MAX(mp.kill_streak) AS kill_streak, MAX(mp.death_streak) AS death_streak,
		       (COUNT(*) FILTER (WHERE x.r = 'win'))::int AS wins,
		       (COUNT(*) FILTER (WHERE x.r = 'loss'))::int AS losses,
		       (COUNT(*) FILTER (WHERE x.r = 'draw'))::int AS draws,
		       SUM(mp.idle_seconds) AS idle_seconds
		  FROM match_players mp
		  JOIN matches m ON m.id = mp.match_id AND m.server_id = mp.server_id
		  LEFT JOIN results x ON x.match_id = mp.match_id AND x.faction = mp.faction
		 WHERE m.ended_at IS NOT NULL
		 GROUP BY 1, 2, 3)
	SELECT COALESCE(s.server_id, l.server_id), COALESCE(s.day, l.day), COALESCE(s.steam_id, l.steam_id),
	       COALESCE(s.seconds, 0), s.crossings, COALESCE(s.sessions, 0), COALESCE(s.seed_seconds, 0),
	       COALESCE(s.cash, 0), s.last_seen, COALESCE(l.matches, 0), COALESCE(l.kills, 0), COALESCE(l.deaths, 0),
	       COALESCE(l.headshots, 0), COALESCE(l.team_kills, 0), COALESCE(l.suicides, 0), COALESCE(l.vehicle_kills, 0),
	       COALESCE(l.kill_streak, 0), COALESCE(l.death_streak, 0), COALESCE(l.wins, 0), COALESCE(l.losses, 0),
	       COALESCE(l.draws, 0), COALESCE(l.idle_seconds, 0)
	  FROM s FULL JOIN l ON l.server_id = s.server_id AND l.day = s.day AND l.steam_id = s.steam_id;
END $$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "player_totals_rebuild"() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM player_totals;
	INSERT INTO player_totals (server_id, steam_id, sessions, seconds, seed_seconds, cash, last_seen,
	                           matches, kills, deaths, headshots, team_kills, suicides, vehicle_kills,
	                           kill_streak, death_streak, wins, losses, draws, idle_seconds)
	WITH results AS (
		SELECT f.match_id, f.faction, match_result(m.final_scores, m.winner, f.faction) AS r
		  FROM (SELECT DISTINCT match_id, faction FROM match_players WHERE faction IS NOT NULL) f
		  JOIN matches m ON m.id = f.match_id
		 WHERE m.ended_at IS NOT NULL),
	s AS (
		SELECT server_id, steam_id, COUNT(*)::int AS sessions,
		       SUM(EXTRACT(EPOCH FROM (left_at - joined_at))) AS seconds,
		       SUM(seed_seconds) AS seed_seconds, SUM(cash) AS cash, MAX(last_seen) AS last_seen
		  FROM player_sessions WHERE left_at IS NOT NULL
		 GROUP BY server_id, steam_id),
	l AS (
		SELECT mp.server_id, mp.steam_id, COUNT(*)::int AS matches, SUM(mp.kills) AS kills, SUM(mp.deaths) AS deaths,
		       SUM(mp.headshots) AS headshots, SUM(mp.team_kills) AS team_kills, SUM(mp.suicides) AS suicides,
		       SUM(mp.vehicle_kills) AS vehicle_kills, MAX(mp.kill_streak) AS kill_streak,
		       MAX(mp.death_streak) AS death_streak,
		       (COUNT(*) FILTER (WHERE x.r = 'win'))::int AS wins,
		       (COUNT(*) FILTER (WHERE x.r = 'loss'))::int AS losses,
		       (COUNT(*) FILTER (WHERE x.r = 'draw'))::int AS draws,
		       SUM(mp.idle_seconds) AS idle_seconds
		  FROM match_players mp
		  JOIN matches m ON m.id = mp.match_id AND m.server_id = mp.server_id
		  LEFT JOIN results x ON x.match_id = mp.match_id AND x.faction = mp.faction
		 WHERE m.ended_at IS NOT NULL
		 GROUP BY mp.server_id, mp.steam_id)
	SELECT COALESCE(s.server_id, l.server_id), COALESCE(s.steam_id, l.steam_id),
	       COALESCE(s.sessions, 0), COALESCE(s.seconds, 0), COALESCE(s.seed_seconds, 0), COALESCE(s.cash, 0), s.last_seen,
	       COALESCE(l.matches, 0), COALESCE(l.kills, 0), COALESCE(l.deaths, 0), COALESCE(l.headshots, 0),
	       COALESCE(l.team_kills, 0), COALESCE(l.suicides, 0), COALESCE(l.vehicle_kills, 0),
	       COALESCE(l.kill_streak, 0), COALESCE(l.death_streak, 0),
	       COALESCE(l.wins, 0), COALESCE(l.losses, 0), COALESCE(l.draws, 0), COALESCE(l.idle_seconds, 0)
	  FROM s FULL JOIN l ON l.server_id = s.server_id AND l.steam_id = s.steam_id;
	PERFORM player_days_rebuild();
END $$;
