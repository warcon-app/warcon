DROP INDEX "lists_org_kind_name_uidx";--> statement-breakpoint
ALTER TABLE "lists" ADD COLUMN IF NOT EXISTS "server_id" text;--> statement-breakpoint
ALTER TABLE "lists" ADD CONSTRAINT "lists_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lists_server_kind_uidx" ON "lists" USING btree ("server_id","kind") WHERE "lists"."server_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "lists_org_kind_name_uidx" ON "lists" USING btree ("org_id","kind","name") WHERE "lists"."server_id" is null;