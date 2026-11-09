CREATE TABLE "match_events" (
	"ts" timestamp with time zone NOT NULL,
	"server_id" text NOT NULL,
	"event_id" text NOT NULL,
	"seq" integer NOT NULL,
	"instance_id" text NOT NULL,
	"type" text NOT NULL,
	"event_time" double precision,
	"match_id" text,
	"map" text NOT NULL,
	"state" text,
	"players" integer,
	"winning_faction" text,
	"scores" jsonb
);
--> statement-breakpoint
ALTER TABLE "server_live" ADD COLUMN "match_state" jsonb;--> statement-breakpoint
CREATE INDEX "match_events_event_idx" ON "match_events" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "match_events_server_ts_idx" ON "match_events" USING btree ("server_id","ts" DESC NULLS LAST);--> statement-breakpoint
-- TimescaleDB: match_events is history and is never pruned, so it becomes a hypertable with
-- compression (segmented by server, newest first) once a chunk is a week old, as kills does (0019).
-- Plain Postgres keeps a normal table.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
		PERFORM create_hypertable('match_events', by_range('ts'), if_not_exists => TRUE);
		EXECUTE 'ALTER TABLE match_events SET (timescaledb.compress, timescaledb.compress_segmentby = ''server_id'', timescaledb.compress_orderby = ''ts DESC'')';
		PERFORM add_compression_policy('match_events', INTERVAL '7 days', if_not_exists => TRUE);
	ELSE
		RAISE NOTICE 'timescaledb not installed: match_events stays a plain table';
	END IF;
END $$;
