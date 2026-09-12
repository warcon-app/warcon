-- Editable per-organisation roles. Every org gets the three built-ins with the capability sets
-- that reproduce what viewer / operator / admin could do before; existing grants and invite links
-- are re-pointed at them so nobody's access changes on upgrade. The generated DDL was reordered by
-- hand: the new columns are added nullable, backfilled, then made NOT NULL before the old ones go.
CREATE TABLE "org_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"builtin" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_roles" ADD CONSTRAINT "org_roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_roles_builtin_uidx" ON "org_roles" USING btree ("org_id","builtin") WHERE "org_roles"."builtin" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "org_roles_name_uidx" ON "org_roles" USING btree ("org_id",lower("name"));--> statement-breakpoint
-- Seed the built-ins for every existing org (createOrg does this for new ones; see src/lib/capabilities.ts).
INSERT INTO "org_roles" ("id", "org_id", "name", "capabilities", "builtin", "sort_order")
SELECT gen_random_uuid()::text, o."id", r."name", r."caps"::jsonb, r."name", r."ord"
  FROM "organizations" o
  CROSS JOIN (VALUES
    ('viewer', '["server.view"]', 0),
    ('operator', '["server.view","chat.send","players.moderate","match.control","rotation.edit","players.notes"]', 1),
    ('admin', '["server.view","chat.send","players.moderate","match.control","rotation.edit","players.notes","rotation.save","players.notes.manage","bans.manage","slots.manage","lists.edit","config.apply","automation.manage","audit.read","rcon.raw"]', 2)
  ) AS r("name", "caps", "ord");--> statement-breakpoint
-- Grants: viewer / operator / admin -> the matching built-in of the server's org.
ALTER TABLE "server_grants" ADD COLUMN "role_id" text;--> statement-breakpoint
UPDATE "server_grants" g SET "role_id" = r."id"
  FROM "servers" s, "org_roles" r
 WHERE s."id" = g."server_id" AND r."org_id" = s."org_id" AND r."builtin" = g."role";--> statement-breakpoint
-- Defensive: a grant with a role name outside the three (impossible under the old CHECK) has nothing to map to.
DELETE FROM "server_grants" WHERE "role_id" IS NULL;--> statement-breakpoint
ALTER TABLE "server_grants" ALTER COLUMN "role_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "server_grants" ADD CONSTRAINT "server_grants_role_id_org_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."org_roles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "server_grants_role_idx" ON "server_grants" USING btree ("role_id");--> statement-breakpoint
ALTER TABLE "server_grants" DROP COLUMN "role";--> statement-breakpoint
-- Invite links: the default server role they hand out, same mapping.
ALTER TABLE "org_invites" ADD COLUMN "server_role_id" text;--> statement-breakpoint
UPDATE "org_invites" i SET "server_role_id" = r."id"
  FROM "org_roles" r
 WHERE r."org_id" = i."org_id" AND r."builtin" = i."server_role";--> statement-breakpoint
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_server_role_id_org_roles_id_fk" FOREIGN KEY ("server_role_id") REFERENCES "public"."org_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invites" DROP COLUMN "server_role";
