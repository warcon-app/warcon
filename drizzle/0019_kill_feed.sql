CREATE TABLE "kills" (
	"ts" timestamp with time zone NOT NULL,
	"server_id" text NOT NULL,
	"event_id" text NOT NULL,
	"instance_id" text NOT NULL,
	"match_id" text NOT NULL,
	"match_row" bigint,
	"event_time" real NOT NULL,
	"map" text NOT NULL,
	"killer_steam_id" text,
	"killer_name" text,
	"killer_faction" text,
	"victim_steam_id" text NOT NULL,
	"victim_name" text NOT NULL,
	"victim_faction" text,
	"cause" text,
	"distance_m" real,
	"headshot" boolean DEFAULT false NOT NULL,
	"suicide" boolean DEFAULT false NOT NULL,
	"team_kill" boolean DEFAULT false NOT NULL,
	"tags" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_live" ADD COLUMN IF NOT EXISTS "feed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "feed_token_enc" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "feed_token_hash" text;--> statement-breakpoint
CREATE INDEX "kills_event_idx" ON "kills" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "kills_server_ts_idx" ON "kills" USING btree ("server_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kills_killer_idx" ON "kills" USING btree ("killer_steam_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "kills_victim_idx" ON "kills" USING btree ("victim_steam_id","ts" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_feed_token_hash_unique" UNIQUE("feed_token_hash");--> statement-breakpoint
-- TimescaleDB: kills is history and is never pruned, so it becomes a hypertable with compression
-- (segmented by server, newest first) once a chunk is a week old. Plain Postgres keeps a normal table.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
		PERFORM create_hypertable('kills', by_range('ts'), if_not_exists => TRUE);
		EXECUTE 'ALTER TABLE kills SET (timescaledb.compress, timescaledb.compress_segmentby = ''server_id'', timescaledb.compress_orderby = ''ts DESC'')';
		PERFORM add_compression_policy('kills', INTERVAL '7 days', if_not_exists => TRUE);
	ELSE
		RAISE NOTICE 'timescaledb not installed: kills stays a plain table';
	END IF;
END $$;
