ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "status_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "status_style" text DEFAULT 'banner' NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "status_messages" jsonb;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN IF NOT EXISTS "status_sent_at" timestamp with time zone;