CREATE TABLE "sample_map_rollups" (
	"server_id" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"map" text NOT NULL,
	"secs" real DEFAULT 0 NOT NULL,
	CONSTRAINT "sample_map_rollups_server_id_bucket_map_pk" PRIMARY KEY("server_id","bucket","map")
);
--> statement-breakpoint
CREATE TABLE "sample_rollups" (
	"server_id" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"samples" integer DEFAULT 0 NOT NULL,
	"ok_samples" integer DEFAULT 0 NOT NULL,
	"up_s" real DEFAULT 0 NOT NULL,
	"down_s" real DEFAULT 0 NOT NULL,
	"player_s" real DEFAULT 0 NOT NULL,
	"max_players" integer,
	"max_cap" integer,
	CONSTRAINT "sample_rollups_server_id_bucket_pk" PRIMARY KEY("server_id","bucket")
);
