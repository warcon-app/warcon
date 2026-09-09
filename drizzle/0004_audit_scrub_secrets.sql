-- Config documents and raw request bodies used to be stored verbatim in audit rows (the
-- ServerSettings.ini document carries Password= / ServerPassword= lines). The app now stores a
-- fingerprint instead; this drops the text already written.
UPDATE "audit_log" SET "detail" = ("detail" - 'text') || '{"text":"[removed]"}'::jsonb
WHERE "action" IN ('rcon.configApply', 'rcon.configValidate') AND "detail" ? 'text';--> statement-breakpoint
UPDATE "audit_log" SET "detail" = ("detail" - 'body') || '{"body":"[removed]"}'::jsonb
WHERE "action" = 'rcon.raw' AND jsonb_typeof("detail" -> 'body') = 'string';
