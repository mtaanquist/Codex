CREATE TABLE "pending_object_deletions" (
	"storage_key" text PRIMARY KEY NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL
);
