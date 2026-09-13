CREATE TABLE "status_boards" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"url_enc" text NOT NULL,
	"url_hint" text DEFAULT '' NOT NULL,
	"heading" text DEFAULT '' NOT NULL,
	"server_ids" jsonb,
	"interval_ms" integer DEFAULT 30000 NOT NULL,
	"show_players" boolean DEFAULT true NOT NULL,
	"message_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_status" integer,
	"last_error" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "status_boards" ADD CONSTRAINT "status_boards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "status_boards_org_idx" ON "status_boards" USING btree ("org_id");