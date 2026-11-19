ALTER TABLE "characters" ADD COLUMN "assistant_enriched_input" text;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "arc_summary_input" text;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD COLUMN "assistant_enriched_input" text;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "assistant_enriched_input" text;