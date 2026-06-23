ALTER TABLE "assistant_chat_messages" ALTER COLUMN "story_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD COLUMN "universe_id" uuid;--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD CONSTRAINT "assistant_chat_messages_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_chat_messages_universe_idx" ON "assistant_chat_messages" USING btree ("universe_id","user_id","created_at");--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD CONSTRAINT "assistant_chat_messages_scope_ck" CHECK (("assistant_chat_messages"."story_id" is null) <> ("assistant_chat_messages"."universe_id" is null));