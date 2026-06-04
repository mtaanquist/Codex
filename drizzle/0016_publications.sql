CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"handle" text NOT NULL,
	"title" text NOT NULL,
	"author" text,
	"description_md" text,
	"is_adult" boolean DEFAULT false NOT NULL,
	"content" jsonb NOT NULL,
	"version_label" text,
	"is_current" boolean DEFAULT true NOT NULL,
	"removed_at" timestamp with time zone,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;