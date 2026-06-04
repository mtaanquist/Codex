CREATE TABLE "publication_assets" (
	"publication_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	CONSTRAINT "publication_assets_publication_id_asset_id_pk" PRIMARY KEY("publication_id","asset_id")
);
--> statement-breakpoint
ALTER TABLE "publication_assets" ADD CONSTRAINT "publication_assets_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publication_assets" ADD CONSTRAINT "publication_assets_asset_id_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."assets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "publication_assets_asset_idx" ON "publication_assets" USING btree ("asset_id");--> statement-breakpoint
CREATE UNIQUE INDEX "publications_one_current_per_story" ON "publications" USING btree ("story_id") WHERE "publications"."is_current";