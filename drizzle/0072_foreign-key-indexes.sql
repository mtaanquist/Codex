CREATE INDEX "character_story_memberships_story_idx" ON "character_story_memberships" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "notes_scene_idx" ON "notes" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "notes_owner_idx" ON "notes" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "place_story_memberships_story_idx" ON "place_story_memberships" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "review_suggestions_base_revision_idx" ON "review_suggestions" USING btree ("base_revision_id");--> statement-breakpoint
CREATE INDEX "review_threads_base_revision_idx" ON "review_threads" USING btree ("base_revision_id");--> statement-breakpoint
CREATE INDEX "scenes_chapter_idx" ON "scenes" USING btree ("chapter_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");