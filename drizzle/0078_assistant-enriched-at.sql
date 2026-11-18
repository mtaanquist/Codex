ALTER TABLE "characters" ADD COLUMN "assistant_enriched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD COLUMN "assistant_enriched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "assistant_enriched_at" timestamp with time zone;