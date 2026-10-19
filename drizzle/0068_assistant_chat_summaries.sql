CREATE TABLE "assistant_chat_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid,
	"universe_id" uuid,
	"user_id" uuid NOT NULL,
	"summary" text NOT NULL,
	"covered_digest" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_chat_summaries_scope_ck" CHECK (("assistant_chat_summaries"."story_id" is null) <> ("assistant_chat_summaries"."universe_id" is null))
);
--> statement-breakpoint
ALTER TABLE "assistant_chat_summaries" ADD CONSTRAINT "assistant_chat_summaries_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_chat_summaries" ADD CONSTRAINT "assistant_chat_summaries_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_chat_summaries" ADD CONSTRAINT "assistant_chat_summaries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_chat_summaries_story_idx" ON "assistant_chat_summaries" USING btree ("story_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_chat_summaries_universe_idx" ON "assistant_chat_summaries" USING btree ("universe_id","user_id");