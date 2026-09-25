ALTER TABLE "kills" ALTER COLUMN "event_time" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kills" ALTER COLUMN "victim_steam_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "kills" ADD COLUMN IF NOT EXISTS "event_type" text DEFAULT 'killed' NOT NULL;--> statement-breakpoint
ALTER TABLE "kills" ADD COLUMN IF NOT EXISTS "parsed_kill" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "kills" ADD COLUMN IF NOT EXISTS "raw_event" jsonb;
