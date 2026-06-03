CREATE TABLE "entity_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"surrounding_text" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX "entity_mentions_target_idx" ON "entity_mentions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "entity_mentions_source_idx" ON "entity_mentions" USING btree ("source_type","source_id");