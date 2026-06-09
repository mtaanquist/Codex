ALTER TABLE "review_comments" ADD COLUMN "assistant" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD COLUMN "assistant" boolean DEFAULT false NOT NULL;