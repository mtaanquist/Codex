ALTER TABLE "characters" ADD COLUMN "arc_summary_stories" uuid[];--> statement-breakpoint
-- One-off backfill. An arc written before this column existed did not record
-- which stories it read, so it is given every story of its universe: more
-- than it read, never less. An out-of-date arc is kept from the Assistant
-- when a story on its list is muted or gone, so this cannot let a muted
-- story's text through. Only this derived column is written.
UPDATE "characters" c SET "arc_summary_stories" = coalesce(
	(SELECT array_agg(st."id") FROM "stories" st WHERE st."universe_id" = c."universe_id"),
	'{}'::uuid[]
)
WHERE c."arc_summary_md" IS NOT NULL;
