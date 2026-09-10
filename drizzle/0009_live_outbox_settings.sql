CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"trigger_id" text,
	"trigger_name" text DEFAULT '' NOT NULL,
	"trigger_kind" text DEFAULT '' NOT NULL,
	"action" text NOT NULL,
	"params" jsonb,
	"target" text DEFAULT '' NOT NULL,
	"detail" jsonb,
	"steam_id" text,
	"ok_message" text DEFAULT '' NOT NULL,
	"dedupe_key" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone,
	"outcome" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "server_live" (
	"server_id" text PRIMARY KEY NOT NULL,
	"ok" boolean DEFAULT false NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"tier" text DEFAULT 'idle' NOT NULL,
	"status" jsonb,
	"players" jsonb,
	"player_count" integer DEFAULT 0 NOT NULL,
	"status_at" timestamp with time zone,
	"players_at" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "worker_ownership" (
	"id" integer PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"acquired_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_live" ADD CONSTRAINT "server_live_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_dedupe_idx" ON "outbox" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("state","not_before");--> statement-breakpoint
CREATE INDEX "outbox_server_idx" ON "outbox" USING btree ("server_id","created_at" DESC NULLS LAST);