CREATE TABLE "assistant_chats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"story_id" uuid,
	"universe_id" uuid,
	"user_id" uuid NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assistant_chats_scope_ck" CHECK (("assistant_chats"."story_id" is null) <> ("assistant_chats"."universe_id" is null))
);
--> statement-breakpoint
DROP INDEX "assistant_chat_summaries_story_idx";--> statement-breakpoint
DROP INDEX "assistant_chat_summaries_universe_idx";--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD COLUMN "chat_id" uuid;--> statement-breakpoint
ALTER TABLE "assistant_chat_summaries" ADD COLUMN "chat_id" uuid;--> statement-breakpoint
-- Backfill (hand-written): each existing conversation, one per scope and user,
-- becomes that scope's first chat, titled from its first user turn the way
-- chatTitle() in src/lib/assistant-chat.ts does.
INSERT INTO "assistant_chats" ("story_id", "universe_id", "user_id", "title", "created_at", "updated_at")
SELECT "story_id", "universe_id", "user_id",
	coalesce((array_agg(
		CASE WHEN length(btrim(regexp_replace("content", '\s+', ' ', 'g'))) > 60
			THEN rtrim(left(btrim(regexp_replace("content", '\s+', ' ', 'g')), 57)) || '...'
			ELSE btrim(regexp_replace("content", '\s+', ' ', 'g')) END
		ORDER BY "created_at", "id") FILTER (WHERE "role" = 'user'))[1], ''),
	min("created_at"), max("created_at")
FROM "assistant_chat_messages"
GROUP BY "story_id", "universe_id", "user_id";--> statement-breakpoint
UPDATE "assistant_chat_messages" AS m SET "chat_id" = c."id"
FROM "assistant_chats" AS c
WHERE c."user_id" = m."user_id"
	AND c."story_id" IS NOT DISTINCT FROM m."story_id"
	AND c."universe_id" IS NOT DISTINCT FROM m."universe_id";--> statement-breakpoint
UPDATE "assistant_chat_summaries" AS s SET "chat_id" = c."id"
FROM "assistant_chats" AS c
WHERE c."user_id" = s."user_id"
	AND c."story_id" IS NOT DISTINCT FROM s."story_id"
	AND c."universe_id" IS NOT DISTINCT FROM s."universe_id";--> statement-breakpoint
-- A summary whose turns were all cleared has nothing left to summarise.
DELETE FROM "assistant_chat_summaries" WHERE "chat_id" IS NULL;--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ALTER COLUMN "chat_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_chat_summaries" ALTER COLUMN "chat_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_chats" ADD CONSTRAINT "assistant_chats_story_id_stories_id_fk" FOREIGN KEY ("story_id") REFERENCES "public"."stories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_chats" ADD CONSTRAINT "assistant_chats_universe_id_universes_id_fk" FOREIGN KEY ("universe_id") REFERENCES "public"."universes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_chats" ADD CONSTRAINT "assistant_chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_chats_story_idx" ON "assistant_chats" USING btree ("story_id","user_id","updated_at");--> statement-breakpoint
CREATE INDEX "assistant_chats_universe_idx" ON "assistant_chats" USING btree ("universe_id","user_id","updated_at");--> statement-breakpoint
ALTER TABLE "assistant_chat_messages" ADD CONSTRAINT "assistant_chat_messages_chat_id_assistant_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."assistant_chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_chat_summaries" ADD CONSTRAINT "assistant_chat_summaries_chat_id_assistant_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."assistant_chats"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assistant_chat_messages_chat_idx" ON "assistant_chat_messages" USING btree ("chat_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_chat_summaries_chat_idx" ON "assistant_chat_summaries" USING btree ("chat_id");--> statement-breakpoint
CREATE INDEX "assistant_chat_summaries_story_idx" ON "assistant_chat_summaries" USING btree ("story_id","user_id");--> statement-breakpoint
CREATE INDEX "assistant_chat_summaries_universe_idx" ON "assistant_chat_summaries" USING btree ("universe_id","user_id");