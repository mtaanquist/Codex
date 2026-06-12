CREATE TABLE "assistant_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"story_id" uuid,
	"role" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer,
	"completion_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_usage" ADD CONSTRAINT "assistant_usage_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_usage" ADD CONSTRAINT "assistant_usage_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_usage_user_idx" ON "assistant_usage" USING btree ("user_id","created_at");