ALTER TABLE "assistant_usage" ADD COLUMN "cached_prompt_tokens" integer;--> statement-breakpoint
ALTER TABLE "assistant_usage" ADD COLUMN "cache_write_tokens" integer;--> statement-breakpoint
ALTER TABLE "assistant_usage" ADD COLUMN "cache_write_1h_tokens" integer;