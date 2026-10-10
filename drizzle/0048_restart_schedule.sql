ALTER TABLE "server_live" ADD COLUMN "restart_time_utc" text;--> statement-breakpoint
ALTER TABLE "server_live" ADD COLUMN "restart_time_utc_file" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "restart_schedule" jsonb;