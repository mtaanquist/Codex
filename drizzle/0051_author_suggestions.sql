ALTER TABLE "review_suggestions" ALTER COLUMN "reviewer_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD COLUMN "author_user_id" uuid;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD CONSTRAINT "review_suggestions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;