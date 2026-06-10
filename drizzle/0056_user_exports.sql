CREATE TABLE "user_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"target_id" uuid,
	"format" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"storage_key" text,
	"filename" text,
	"content_type" text,
	"byte_size" bigint,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user_exports" ADD CONSTRAINT "user_exports_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_exports_owner_idx" ON "user_exports" USING btree ("owner_id","created_at" DESC NULLS LAST);