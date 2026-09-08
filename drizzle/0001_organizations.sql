CREATE TABLE "org_invites" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"token" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"org_role" text DEFAULT 'member' NOT NULL,
	"server_role" text,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_invites_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "org_members" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"invite_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_members_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "org_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "org_id" text;--> statement-breakpoint
-- Every install gets a 'Default' org (so the owner can add servers straight after setup). On an
-- existing install it takes every server; owners become org owners, everyone else a member.
INSERT INTO "organizations" ("id", "name", "slug")
VALUES (gen_random_uuid()::text, 'Default', 'default');--> statement-breakpoint
INSERT INTO "org_members" ("org_id", "user_id", "role")
SELECT o."id", u."id", CASE WHEN u."role" = 'owner' THEN 'owner' ELSE 'member' END
FROM "organizations" o, "user" u
WHERE o."slug" = 'default';--> statement-breakpoint
UPDATE "servers" SET "org_id" = (SELECT "id" FROM "organizations" WHERE "slug" = 'default')
WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "org_invites_org_idx" ON "org_invites" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "org_members_user_idx" ON "org_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_org_idx" ON "audit_log" USING btree ("org_id","id");--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;