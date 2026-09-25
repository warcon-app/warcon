ALTER TABLE "steam_profiles" ADD COLUMN IF NOT EXISTS "friends_state" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "steam_profiles" ADD COLUMN IF NOT EXISTS "friends_total" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "steam_profiles" ADD COLUMN IF NOT EXISTS "friends_checked" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "steam_profiles" ADD COLUMN IF NOT EXISTS "banned_friends" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "steam_profiles" ADD COLUMN IF NOT EXISTS "friends_checked_at" timestamp with time zone;