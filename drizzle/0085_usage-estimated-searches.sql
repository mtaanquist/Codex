ALTER TABLE "assistant_usage" ADD COLUMN "estimated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "assistant_usage" ADD COLUMN "web_search_requests" integer;