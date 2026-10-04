ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "server_limit" integer;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "suspended_reason" text DEFAULT '' NOT NULL;