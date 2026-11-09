DROP INDEX "lists_org_kind_name_uidx";--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "on_from" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "on_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "every_server" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
-- the org lists there are, one per kind (checked on the hosted panel 2026-10-09), are its defaults
UPDATE "lists" SET "is_default" = true WHERE "server_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "lists_org_default_uidx" ON "lists" USING btree ("org_id","kind") WHERE "lists"."is_default";--> statement-breakpoint
CREATE UNIQUE INDEX "lists_org_kind_name_uidx" ON "lists" USING btree ("org_id","kind",lower("name")) WHERE "lists"."server_id" is null and "lists"."archived_at" is null;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_group_kind" CHECK ("lists"."server_id" is not null or "lists"."is_default" or "lists"."kind" = 'reserve');--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_group_shape" CHECK (("lists"."server_id" is null and not "lists"."is_default") or ("lists"."on_from" is null and "lists"."on_until" is null and "lists"."every_server" and "lists"."archived_at" is null));--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_window" CHECK ("lists"."on_from" is null or "lists"."on_until" is null or "lists"."on_from" < "lists"."on_until");