ALTER TABLE "characters" ADD COLUMN "badge_color" text;--> statement-breakpoint
ALTER TABLE "characters" ADD COLUMN "badge_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD COLUMN "badge_color" text;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD COLUMN "badge_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "badge_color" text;--> statement-breakpoint
ALTER TABLE "places" ADD COLUMN "badge_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "characters" ADD CONSTRAINT "characters_badge_asset_id_assets_id_fk" FOREIGN KEY ("badge_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lore_entries" ADD CONSTRAINT "lore_entries_badge_asset_id_assets_id_fk" FOREIGN KEY ("badge_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "places" ADD CONSTRAINT "places_badge_asset_id_assets_id_fk" FOREIGN KEY ("badge_asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;