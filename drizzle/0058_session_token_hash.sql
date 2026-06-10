-- The session cookie now carries a random token and the row stores only its
-- hash. Existing rows predate the column, so backfill them with a placeholder
-- that no real token hashes to: every current session stops validating and
-- everyone is signed out once. New sessions set a genuine hash on insert.
ALTER TABLE "sessions" ADD COLUMN "token_hash" text;--> statement-breakpoint
UPDATE "sessions" SET "token_hash" = 'legacy:' || gen_random_uuid() WHERE "token_hash" IS NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "token_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash");
