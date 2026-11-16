CREATE TABLE "story_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"label" text NOT NULL,
	"note_md" text,
	"content" jsonb NOT NULL,
	"word_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "source_draft_id" uuid;--> statement-breakpoint
ALTER TABLE "story_drafts" ADD CONSTRAINT "story_drafts_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "story_drafts" ADD CONSTRAINT "story_drafts_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "story_drafts_story_idx" ON "story_drafts" USING btree ("story_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_source_draft_id_story_drafts_id_fk" FOREIGN KEY ("source_draft_id") REFERENCES "public"."story_drafts"("id") ON DELETE set null ON UPDATE no action;