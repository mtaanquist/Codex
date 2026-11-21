CREATE TABLE "entity_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"universe_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"description_md" text,
	"seen_in" text,
	"assistant" boolean DEFAULT false NOT NULL,
	"client_id" uuid,
	"from_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"entity_id" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scene_split_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"scene_id" uuid NOT NULL,
	"before" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"client_id" uuid,
	"from_name" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_proposals" ADD CONSTRAINT "entity_proposals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_proposals" ADD CONSTRAINT "entity_proposals_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_proposals" ADD CONSTRAINT "entity_proposals_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_split_proposals" ADD CONSTRAINT "scene_split_proposals_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_split_proposals" ADD CONSTRAINT "scene_split_proposals_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_split_proposals" ADD CONSTRAINT "scene_split_proposals_scene_id_scenes_id_fk" FOREIGN KEY ("scene_id") REFERENCES "public"."scenes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_split_proposals" ADD CONSTRAINT "scene_split_proposals_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_proposals_universe_idx" ON "entity_proposals" USING btree ("universe_id","status");--> statement-breakpoint
CREATE INDEX "scene_split_proposals_story_idx" ON "scene_split_proposals" USING btree ("story_id","status");