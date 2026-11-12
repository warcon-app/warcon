ALTER TABLE "match_players" ADD COLUMN "hidden_name" text;--> statement-breakpoint
ALTER TABLE "player_sessions" ADD COLUMN "hidden_name" text;--> statement-breakpoint
ALTER TABLE "player_sessions" ADD COLUMN "anonymous" boolean DEFAULT false NOT NULL;