ALTER TABLE "users" ADD COLUMN "pen_name" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "commissions_open" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "commissions_md" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "avatar_asset_id" uuid;