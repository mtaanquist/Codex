CREATE TABLE "review_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"base_revision_id" uuid NOT NULL,
	"range_start" integer NOT NULL,
	"range_end" integer NOT NULL,
	"replacement" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by_user_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD CONSTRAINT "review_suggestions_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD CONSTRAINT "review_suggestions_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD CONSTRAINT "review_suggestions_reviewer_id_reviewers_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD CONSTRAINT "review_suggestions_base_revision_id_revisions_id_fk" FOREIGN KEY ("base_revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD CONSTRAINT "review_suggestions_decided_by_user_id_users_id_fk" FOREIGN KEY ("decided_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_suggestions_scene_idx" ON "review_suggestions" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "review_suggestions_story_idx" ON "review_suggestions" USING btree ("story_id");