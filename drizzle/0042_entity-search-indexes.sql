CREATE INDEX "characters_owner_idx" ON "characters" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "characters_name_trgm_idx" ON "characters" USING gin ("name" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "lore_entries_owner_idx" ON "lore_entries" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "lore_entries_title_trgm_idx" ON "lore_entries" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX "places_owner_idx" ON "places" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "places_name_trgm_idx" ON "places" USING gin ("name" gin_trgm_ops);