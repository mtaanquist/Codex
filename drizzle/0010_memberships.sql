CREATE TABLE "character_story_memberships" (
	"character_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "character_story_memberships_character_id_story_id_pk" PRIMARY KEY("character_id","story_id")
);
--> statement-breakpoint
CREATE TABLE "place_story_memberships" (
	"place_id" uuid NOT NULL,
	"story_id" uuid NOT NULL,
	"declared_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "place_story_memberships_place_id_story_id_pk" PRIMARY KEY("place_id","story_id")
);
--> statement-breakpoint
ALTER TABLE "character_story_memberships" ADD CONSTRAINT "character_story_memberships_character_id_characters_id_fk" FOREIGN KEY ("character_id") REFERENCES "public"."characters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "character_story_memberships" ADD CONSTRAINT "character_story_memberships_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_story_memberships" ADD CONSTRAINT "place_story_memberships_place_id_places_id_fk" FOREIGN KEY ("place_id") REFERENCES "public"."places"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "place_story_memberships" ADD CONSTRAINT "place_story_memberships_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;