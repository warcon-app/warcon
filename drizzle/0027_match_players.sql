CREATE TABLE "match_players" (
	"match_id" bigint NOT NULL,
	"steam_id" text NOT NULL,
	"faction" text NOT NULL,
	CONSTRAINT "match_players_match_id_steam_id_pk" PRIMARY KEY("match_id","steam_id")
);
