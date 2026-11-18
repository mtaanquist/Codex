ALTER TABLE "review_comments" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "review_suggestions" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();--> statement-breakpoint
ALTER TABLE "review_threads" ALTER COLUMN "created_at" SET DEFAULT clock_timestamp();