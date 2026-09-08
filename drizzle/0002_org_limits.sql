ALTER TABLE "organizations" ADD COLUMN "server_limit" integer;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "suspended_reason" text DEFAULT '' NOT NULL;