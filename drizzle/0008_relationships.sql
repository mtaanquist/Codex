CREATE TABLE "entity_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"universe_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"from_type" text NOT NULL,
	"from_id" uuid NOT NULL,
	"to_type" text NOT NULL,
	"to_id" uuid NOT NULL,
	"relation_type_id" uuid NOT NULL,
	"story_id" uuid,
	"notes_md" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relation_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"universe_id" uuid,
	"key" text NOT NULL,
	"forward_label" text NOT NULL,
	"reverse_label" text,
	"bidirectional" boolean DEFAULT false NOT NULL,
	"from_type" text NOT NULL,
	"to_type" text NOT NULL,
	"category" text,
	"sort_order" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "relation_types_universe_key" UNIQUE NULLS NOT DISTINCT("universe_id","key")
);
--> statement-breakpoint
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_relation_type_id_relation_types_id_fk" FOREIGN KEY ("relation_type_id") REFERENCES "public"."relation_types"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_relationships" ADD CONSTRAINT "entity_relationships_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relation_types" ADD CONSTRAINT "relation_types_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "entity_relationships_from_idx" ON "entity_relationships" USING btree ("from_type","from_id");--> statement-breakpoint
CREATE INDEX "entity_relationships_to_idx" ON "entity_relationships" USING btree ("to_type","to_id");--> statement-breakpoint
CREATE INDEX "entity_relationships_scope_idx" ON "entity_relationships" USING btree ("universe_id","story_id");--> statement-breakpoint
INSERT INTO "relation_types" ("universe_id", "key", "forward_label", "reverse_label", "bidirectional", "from_type", "to_type", "category", "sort_order") VALUES
(NULL, 'parent_of', 'parent of', 'child of', false, 'character', 'character', 'family', 0),
(NULL, 'sibling_of', 'sibling of', NULL, true, 'character', 'character', 'family', 1),
(NULL, 'spouse_of', 'spouse of', NULL, true, 'character', 'character', 'family', 2),
(NULL, 'friend_of', 'friend of', NULL, true, 'character', 'character', 'social', 3),
(NULL, 'rival_of', 'rival of', NULL, true, 'character', 'character', 'social', 4),
(NULL, 'enemy_of', 'enemy of', NULL, true, 'character', 'character', 'social', 5),
(NULL, 'ally_of', 'ally of', NULL, true, 'character', 'character', 'social', 6),
(NULL, 'mentor_of', 'mentor of', 'student of', false, 'character', 'character', 'social', 7),
(NULL, 'serves', 'serves', 'served by', false, 'character', 'character', 'social', 8),
(NULL, 'born_in', 'born in', 'birthplace of', false, 'character', 'place', 'geography', 9),
(NULL, 'raised_in', 'raised in', 'childhood home of', false, 'character', 'place', 'geography', 10),
(NULL, 'lives_in', 'lives in', 'home of', false, 'character', 'place', 'geography', 11),
(NULL, 'rules', 'rules', 'ruled by', false, 'character', 'place', 'geography', 12),
(NULL, 'exiled_from', 'exiled from', 'has exiled', false, 'character', 'place', 'geography', 13),
(NULL, 'part_of', 'part of', 'contains', false, 'place', 'place', 'geography', 14);
