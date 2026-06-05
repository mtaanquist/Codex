CREATE TABLE "review_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"thread_id" uuid NOT NULL,
	"author_user_id" uuid,
	"author_reviewer_id" uuid,
	"body_md" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"email" text,
	"can_suggest" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_invitations_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "review_threads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"anchor_start" integer,
	"anchor_end" integer,
	"base_revision_id" uuid,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reviewers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"invitation_id" uuid NOT NULL,
	"user_id" uuid,
	"display_name" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_thread_id_review_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."review_threads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_author_reviewer_id_reviewers_id_fk" FOREIGN KEY ("author_reviewer_id") REFERENCES "public"."reviewers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_invitations" ADD CONSTRAINT "review_invitations_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_invitations" ADD CONSTRAINT "review_invitations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_threads" ADD CONSTRAINT "review_threads_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_threads" ADD CONSTRAINT "review_threads_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_threads" ADD CONSTRAINT "review_threads_base_revision_id_revisions_id_fk" FOREIGN KEY ("base_revision_id") REFERENCES "public"."revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_threads" ADD CONSTRAINT "review_threads_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewers" ADD CONSTRAINT "reviewers_invitation_id_review_invitations_id_fk" FOREIGN KEY ("invitation_id") REFERENCES "public"."review_invitations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviewers" ADD CONSTRAINT "reviewers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_comments_thread_idx" ON "review_comments" USING btree ("thread_id");--> statement-breakpoint
CREATE INDEX "review_invitations_story_idx" ON "review_invitations" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "review_threads_scene_idx" ON "review_threads" USING btree ("scene_id");--> statement-breakpoint
CREATE INDEX "review_threads_story_idx" ON "review_threads" USING btree ("story_id");--> statement-breakpoint
CREATE INDEX "reviewers_invitation_idx" ON "reviewers" USING btree ("invitation_id");