ALTER TABLE "scenes" ADD COLUMN "touched_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL;--> statement-breakpoint
-- Existing scenes start from their last prose change.
UPDATE "scenes" SET "touched_at" = "updated_at";
