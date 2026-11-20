ALTER TABLE "review_suggestions" ADD COLUMN "follows_suggestion_id" uuid;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD CONSTRAINT "review_suggestions_follows_suggestion_id_review_suggestions_id_fk" FOREIGN KEY ("follows_suggestion_id") REFERENCES "public"."review_suggestions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_suggestions_follows_idx" ON "review_suggestions" USING btree ("follows_suggestion_id");