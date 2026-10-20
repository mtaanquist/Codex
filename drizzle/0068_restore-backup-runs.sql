-- Backups taken before backup_runs was kept in the dump restore without the
-- table, while the migration ledger says it exists. Recreate it if missing;
-- a no-op on every healthy database.
CREATE TABLE IF NOT EXISTS "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"object_key" text,
	"size_bytes" bigint,
	"content_hash" text,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
