-- Before 0008 the app wrote jsonb through a path that JSON-encoded values twice, so arrays and
-- objects were stored as JSON strings (jsonb_typeof = 'string'). Unwrap those rows; a genuine
-- string value that does not look like JSON is left alone.
UPDATE "audit_log" SET "detail" = ("detail" #>> '{}')::jsonb
 WHERE jsonb_typeof("detail") = 'string' AND left("detail" #>> '{}', 1) IN ('[', '{');
--> statement-breakpoint
UPDATE "samples" SET "scores" = ("scores" #>> '{}')::jsonb
 WHERE jsonb_typeof("scores") = 'string' AND left("scores" #>> '{}', 1) IN ('[', '{');
--> statement-breakpoint
UPDATE "samples" SET "cash" = ("cash" #>> '{}')::jsonb
 WHERE jsonb_typeof("cash") = 'string' AND left("cash" #>> '{}', 1) IN ('[', '{');
--> statement-breakpoint
UPDATE "matches" SET "final_scores" = ("final_scores" #>> '{}')::jsonb
 WHERE jsonb_typeof("final_scores") = 'string' AND left("final_scores" #>> '{}', 1) IN ('[', '{');
--> statement-breakpoint
UPDATE "triggers" SET "config" = ("config" #>> '{}')::jsonb
 WHERE jsonb_typeof("config") = 'string' AND left("config" #>> '{}', 1) IN ('[', '{');
--> statement-breakpoint
UPDATE "triggers" SET "state" = ("state" #>> '{}')::jsonb
 WHERE jsonb_typeof("state") = 'string' AND left("state" #>> '{}', 1) IN ('[', '{');
--> statement-breakpoint
UPDATE "webhooks" SET "events" = ("events" #>> '{}')::jsonb
 WHERE jsonb_typeof("events") = 'string' AND left("events" #>> '{}', 1) IN ('[', '{');
--> statement-breakpoint
UPDATE "webhooks" SET "server_ids" = ("server_ids" #>> '{}')::jsonb
 WHERE jsonb_typeof("server_ids") = 'string' AND left("server_ids" #>> '{}', 1) IN ('[', '{');
