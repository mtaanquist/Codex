CREATE TABLE "assistant_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"chapter_id" uuid,
	"scene_id" uuid,
	"position" integer,
	"brief" text NOT NULL,
	"target_words" integer NOT NULL,
	"pov" text,
	"text_md" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"note" text,
	"job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_drafts" ADD CONSTRAINT "assistant_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_drafts" ADD CONSTRAINT "assistant_drafts_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_drafts" ADD CONSTRAINT "assistant_drafts_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_drafts" ADD CONSTRAINT "assistant_drafts_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_drafts_story_idx" ON "assistant_drafts" USING btree ("story_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_drafts_open_scene_idx" ON "assistant_drafts" USING btree ("user_id","scene_id") WHERE "assistant_drafts"."status" in ('pending', 'running', 'ready');