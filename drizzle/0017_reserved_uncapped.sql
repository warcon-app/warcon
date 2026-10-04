ALTER TABLE "server_live" ADD COLUMN IF NOT EXISTS "reserved_slots" integer;--> statement-breakpoint
ALTER TABLE "list_entries" DROP COLUMN "priority";--> statement-breakpoint
ALTER TABLE "server_list_sync" DROP COLUMN "reserved_cap";--> statement-breakpoint
ALTER TABLE "server_list_sync" DROP COLUMN "reserved_used";--> statement-breakpoint
ALTER TABLE "server_list_sync" DROP COLUMN "cap_checked_at";