ALTER TABLE "review_comments" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "client_name" text;--> statement-breakpoint
ALTER TABLE "review_comments" ADD COLUMN "client_host" text;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD COLUMN "client_id" uuid;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD COLUMN "client_name" text;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD COLUMN "client_host" text;--> statement-breakpoint
ALTER TABLE "review_comments" ADD CONSTRAINT "review_comments_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_suggestions" ADD CONSTRAINT "review_suggestions_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_comments_client_idx" ON "review_comments" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "review_suggestions_client_idx" ON "review_suggestions" USING btree ("client_id");