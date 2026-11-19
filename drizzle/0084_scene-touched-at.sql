ALTER TABLE "scenes" ADD COLUMN "touched_at" timestamp with time zone;--> statement-breakpoint
-- Set apart from the add so no existing row is rewritten; readers fall back
-- to updated_at while touched_at is null.
ALTER TABLE "scenes" ALTER COLUMN "touched_at" SET DEFAULT clock_timestamp();
