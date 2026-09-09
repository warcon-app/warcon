CREATE TABLE "player_marks" (
	"org_id" text NOT NULL,
	"steam_id" text NOT NULL,
	"watched" boolean DEFAULT false NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"updated_by" text,
	"updated_by_name" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "player_marks_org_id_steam_id_pk" PRIMARY KEY("org_id","steam_id")
);
--> statement-breakpoint
CREATE TABLE "player_notes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"steam_id" text NOT NULL,
	"author_id" text,
	"author_name" text DEFAULT '' NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_bans" (
	"server_id" text NOT NULL,
	"steam_id" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"banned_by" text DEFAULT '' NOT NULL,
	"banned_at_utc" text DEFAULT '' NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_bans_server_id_steam_id_pk" PRIMARY KEY("server_id","steam_id")
);
--> statement-breakpoint
CREATE TABLE "steam_profiles" (
	"steam_id" text PRIMARY KEY NOT NULL,
	"persona" text DEFAULT '' NOT NULL,
	"avatar" text DEFAULT '' NOT NULL,
	"profile_url" text DEFAULT '' NOT NULL,
	"public" boolean DEFAULT false NOT NULL,
	"account_created_at" timestamp with time zone,
	"vac_bans" integer DEFAULT 0 NOT NULL,
	"game_bans" integer DEFAULT 0 NOT NULL,
	"days_since_last_ban" integer,
	"community_banned" boolean DEFAULT false NOT NULL,
	"economy_ban" text DEFAULT 'none' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"error" text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" text PRIMARY KEY NOT NULL,
	"server_id" text NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb NOT NULL,
	"state" jsonb,
	"last_fired_at" timestamp with time zone,
	"last_result" text DEFAULT '' NOT NULL,
	"fire_count" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"url_enc" text NOT NULL,
	"url_hint" text DEFAULT '' NOT NULL,
	"events" jsonb NOT NULL,
	"server_ids" jsonb,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_sent_at" timestamp with time zone,
	"last_status" integer,
	"last_error" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "player_marks" ADD CONSTRAINT "player_marks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_notes" ADD CONSTRAINT "player_notes_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_bans" ADD CONSTRAINT "server_bans_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "player_notes_idx" ON "player_notes" USING btree ("org_id","steam_id","id");--> statement-breakpoint
CREATE INDEX "server_bans_steam_idx" ON "server_bans" USING btree ("steam_id");--> statement-breakpoint
CREATE INDEX "triggers_server_idx" ON "triggers" USING btree ("server_id");--> statement-breakpoint
CREATE INDEX "webhooks_org_idx" ON "webhooks" USING btree ("org_id");