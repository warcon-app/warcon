ALTER TABLE "organizations" ADD COLUMN "allow_public_matches" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "public_matches" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "webhooks" ADD COLUMN "link_matches" boolean DEFAULT true NOT NULL;