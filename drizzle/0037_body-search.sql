-- Trigram matching for the palette's body-text search. The extension ships
-- with Postgres contrib, present in the official images.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "scenes_body_trgm_idx" ON "scenes" USING gin ("body_md" gin_trgm_ops);
