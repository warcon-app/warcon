CREATE TABLE "list_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"list_id" text NOT NULL,
	"steam_id" text NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"expires_at" timestamp with time zone,
	"priority" integer DEFAULT 0 NOT NULL,
	"added_by" text,
	"added_by_name" text DEFAULT '' NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" text,
	"removed_by_name" text DEFAULT '' NOT NULL,
	"removal" text
);
--> statement-breakpoint
CREATE TABLE "lists" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text DEFAULT 'Default' NOT NULL,
	"share_token" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lists_share_token_unique" UNIQUE("share_token")
);
--> statement-breakpoint
CREATE TABLE "server_list_state" (
	"server_id" text NOT NULL,
	"kind" text NOT NULL,
	"steam_id" text NOT NULL,
	"source_list_id" text,
	"state" text NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"attempted_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_list_state_server_id_kind_steam_id_pk" PRIMARY KEY("server_id","kind","steam_id")
);
--> statement-breakpoint
CREATE TABLE "server_list_sync" (
	"server_id" text PRIMARY KEY NOT NULL,
	"synced_at" timestamp with time zone,
	"reserved_cap" integer,
	"reserved_used" integer DEFAULT 0 NOT NULL,
	"cap_checked_at" timestamp with time zone,
	"last_error" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "server_lists" (
	"server_id" text NOT NULL,
	"list_id" text NOT NULL,
	CONSTRAINT "server_lists_server_id_list_id_pk" PRIMARY KEY("server_id","list_id")
);
--> statement-breakpoint
CREATE TABLE "server_reserved" (
	"server_id" text NOT NULL,
	"steam_id" text NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "server_reserved_server_id_steam_id_pk" PRIMARY KEY("server_id","steam_id")
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "members_reserved" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "steam_id" text;--> statement-breakpoint
ALTER TABLE "list_entries" ADD CONSTRAINT "list_entries_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_list_state" ADD CONSTRAINT "server_list_state_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_list_state" ADD CONSTRAINT "server_list_state_source_list_id_lists_id_fk" FOREIGN KEY ("source_list_id") REFERENCES "public"."lists"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_list_sync" ADD CONSTRAINT "server_list_sync_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_lists" ADD CONSTRAINT "server_lists_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_lists" ADD CONSTRAINT "server_lists_list_id_lists_id_fk" FOREIGN KEY ("list_id") REFERENCES "public"."lists"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_reserved" ADD CONSTRAINT "server_reserved_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "list_entries_active_uidx" ON "list_entries" USING btree ("list_id","steam_id") WHERE "list_entries"."removed_at" is null;--> statement-breakpoint
CREATE INDEX "list_entries_list_idx" ON "list_entries" USING btree ("list_id","removed_at");--> statement-breakpoint
CREATE INDEX "list_entries_steam_idx" ON "list_entries" USING btree ("steam_id");--> statement-breakpoint
CREATE UNIQUE INDEX "lists_org_kind_name_uidx" ON "lists" USING btree ("org_id","kind","name");--> statement-breakpoint
CREATE INDEX "server_list_state_source_idx" ON "server_list_state" USING btree ("source_list_id");--> statement-breakpoint
CREATE INDEX "server_lists_list_idx" ON "server_lists" USING btree ("list_id");--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_steam_id_unique" UNIQUE("steam_id");--> statement-breakpoint
-- Every org gets one ban list and one reserved-slot list, and every existing server subscribes to
-- its org's lists (createOrg / createServer keep this up for new rows).
INSERT INTO "lists" ("id", "org_id", "kind", "name")
SELECT gen_random_uuid()::text, o."id", k."kind", 'Default'
  FROM "organizations" o, (VALUES ('ban'), ('reserve')) AS k("kind");--> statement-breakpoint
INSERT INTO "server_lists" ("server_id", "list_id")
SELECT s."id", l."id" FROM "servers" s JOIN "lists" l ON l."org_id" = s."org_id";
