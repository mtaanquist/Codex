ALTER TABLE "stories" ADD COLUMN "page_setup" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "page_setup" jsonb DEFAULT '{}'::jsonb NOT NULL;