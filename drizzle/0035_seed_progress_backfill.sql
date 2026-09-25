-- The persistent seed-reward balance was introduced after seed_seconds had already been recorded.
-- Seed each enabled rule from the last three days without crediting a player twice when that
-- rule's destination list already gave them a reserved slot today. `observed` is the server's
-- all-time counter, not only the backfill window: the next worker observation can then add only
-- genuinely new seed time. Existing live progress wins if this is applied after the new worker
-- has already written state.
WITH totals AS (
	SELECT t.id AS trigger_id, t.server_id, t.org_id, t.config, ps.steam_id,
	       SUM(ps.seed_seconds)::bigint AS observed,
	       COALESCE(SUM(ps.seed_seconds) FILTER (
	           WHERE ps.last_seen >= CURRENT_TIMESTAMP - INTERVAL '3 days'
	       ), 0)::bigint AS recent
	  FROM triggers t
	  JOIN player_sessions ps ON ps.server_id = t.server_id
	 WHERE t.kind = 'seed_reward' AND t.enabled AND ps.seed_seconds > 0
	 GROUP BY t.id, t.server_id, t.org_id, t.config, ps.steam_id
), balances AS (
	SELECT x.trigger_id, x.steam_id, x.observed,
	       CASE WHEN EXISTS (
	           SELECT 1
	             FROM list_entries e
	             JOIN lists l ON l.id = e.list_id
	            WHERE l.kind = 'reserve' AND e.steam_id = x.steam_id
	              AND e.added_at >= CURRENT_DATE
	              AND e.added_at < CURRENT_DATE + INTERVAL '1 day'
	              AND (
	                  (x.config->>'scope' = 'server' AND l.server_id = x.server_id)
	                  OR
	                  (COALESCE(x.config->>'scope', 'org') <> 'server'
	                   AND l.org_id = x.org_id AND l.server_id IS NULL)
	              )
	       ) THEN 0 ELSE x.recent END AS balance
	  FROM totals x
), packed AS (
	SELECT trigger_id,
	       jsonb_object_agg(
	           steam_id,
	           jsonb_build_object(
	               'observed', observed,
	               'balance', balance,
	               'seenAt', FLOOR(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::bigint
	           ) ORDER BY steam_id
	       ) AS players
	  FROM balances
	 GROUP BY trigger_id
)
UPDATE triggers t
   SET state = jsonb_set(
	       CASE WHEN jsonb_typeof(t.state) = 'object' THEN t.state ELSE '{}'::jsonb END,
	       '{players}',
	       p.players || CASE
	           WHEN jsonb_typeof(t.state->'players') = 'object' THEN t.state->'players'
	           ELSE '{}'::jsonb
	       END,
	       true
   )
  FROM packed p
 WHERE t.id = p.trigger_id;--> statement-breakpoint
