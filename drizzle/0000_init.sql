CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"issuer" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_id" text,
	"actor_name" text DEFAULT '' NOT NULL,
	"server_id" text,
	"server_name" text DEFAULT '' NOT NULL,
	"category" text NOT NULL,
	"action" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"detail" jsonb,
	"outcome" text NOT NULL,
	"status" integer,
	"message" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"user_agent" text DEFAULT '' NOT NULL,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"first_at" timestamp with time zone NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"map" text,
	"experiences" text,
	"lighting" text,
	"peak_players" integer DEFAULT 0 NOT NULL,
	"final_scores" jsonb,
	"winner" text
);
--> statement-breakpoint
CREATE TABLE "player_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"steam_id" text NOT NULL,
	"name" text NOT NULL,
	"faction" text,
	"joined_at" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"kills" integer DEFAULT 0 NOT NULL,
	"deaths" integer DEFAULT 0 NOT NULL,
	"cash" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "samples" (
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	"server_id" text NOT NULL,
	"ok" boolean NOT NULL,
	"player_count" integer,
	"max_players" integer,
	"map" text,
	"experiences" text,
	"lighting" text,
	"match_seconds" integer,
	"scores" jsonb,
	"latency_ms" integer,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "server_grants" (
	"server_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_grants_server_id_user_id_pk" PRIMARY KEY("server_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "servers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"scheme" text DEFAULT 'http' NOT NULL,
	"password_enc" text NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	"impersonated_by" text,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"username" text,
	"display_username" text,
	"role" text,
	"banned" boolean DEFAULT false,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"must_change_password" boolean DEFAULT false NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email"),
	CONSTRAINT "user_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_grants" ADD CONSTRAINT "server_grants_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_grants" ADD CONSTRAINT "server_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "account_issuer_account_id_uidx" ON "account" USING btree ("issuer","account_id");--> statement-breakpoint
CREATE INDEX "audit_ts_idx" ON "audit_log" USING btree ("ts");--> statement-breakpoint
CREATE INDEX "audit_server_idx" ON "audit_log" USING btree ("server_id","id");--> statement-breakpoint
CREATE INDEX "audit_actor_idx" ON "audit_log" USING btree ("actor_id","id");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("category","action");--> statement-breakpoint
CREATE INDEX "matches_server_idx" ON "matches" USING btree ("server_id","started_at");--> statement-breakpoint
CREATE INDEX "player_sessions_open_idx" ON "player_sessions" USING btree ("server_id","left_at");--> statement-breakpoint
CREATE INDEX "player_sessions_seen_idx" ON "player_sessions" USING btree ("server_id","last_seen");--> statement-breakpoint
CREATE INDEX "player_sessions_steam_idx" ON "player_sessions" USING btree ("steam_id","joined_at");--> statement-breakpoint
CREATE INDEX "samples_server_ts_idx" ON "samples" USING btree ("server_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "server_grants_user_idx" ON "server_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" USING btree ("identifier");--> statement-breakpoint
-- TimescaleDB: `samples` becomes a hypertable with 90-day retention when the extension is installed
-- (the timescale/timescaledb image creates it in the default database). Plain Postgres keeps a
-- normal table and the poller prunes old samples itself.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
		PERFORM create_hypertable('samples', by_range('ts'), if_not_exists => TRUE);
		PERFORM add_retention_policy('samples', INTERVAL '90 days', if_not_exists => TRUE);
	ELSE
		RAISE NOTICE 'timescaledb not installed: samples stays a plain table';
	END IF;
END $$;
