DROP INDEX "stories_owner_slug_idx";--> statement-breakpoint
DROP INDEX "universes_owner_slug_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "stories_owner_slug_idx" ON "stories" USING btree ("owner_id","slug") WHERE "stories"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "universes_owner_slug_idx" ON "universes" USING btree ("owner_id","slug") WHERE "universes"."deleted_at" is null;