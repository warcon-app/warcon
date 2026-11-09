ALTER TABLE "server_reserved" ADD COLUMN "configured" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "server_reserved" ADD COLUMN "live" boolean DEFAULT true NOT NULL;