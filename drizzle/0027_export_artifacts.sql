CREATE TABLE "export_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"format" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "export_artifacts_one_per_format" UNIQUE("publication_id","format")
);
--> statement-breakpoint
ALTER TABLE "publications" ADD COLUMN "downloads_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "export_artifacts" ADD CONSTRAINT "export_artifacts_publication_id_publications_id_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE cascade ON UPDATE no action;