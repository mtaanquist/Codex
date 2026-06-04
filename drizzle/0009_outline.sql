CREATE TABLE "outline_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"parent_id" uuid,
	"position" integer NOT NULL,
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"linked_scene_id" uuid,
	"linked_chapter_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "outline_nodes" ADD CONSTRAINT "outline_nodes_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_nodes" ADD CONSTRAINT "outline_nodes_parent_id_outline_nodes_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."outline_nodes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_nodes" ADD CONSTRAINT "outline_nodes_linked_scene_id_scenes_id_fk" FOREIGN KEY ("linked_scene_id") REFERENCES "public"."scenes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outline_nodes" ADD CONSTRAINT "outline_nodes_linked_chapter_id_chapters_id_fk" FOREIGN KEY ("linked_chapter_id") REFERENCES "public"."chapters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "outline_nodes_story_idx" ON "outline_nodes" USING btree ("story_id","parent_id","position");