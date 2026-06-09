CREATE INDEX "chapters_story_idx" ON "chapters" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "characters_universe_idx" ON "characters" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "lore_entries_universe_idx" ON "lore_entries" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "places_universe_idx" ON "places" USING btree ("universe_id");--> statement-breakpoint
CREATE INDEX "scenes_story_idx" ON "scenes" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "stories_universe_idx" ON "stories" USING btree ("universe_id");