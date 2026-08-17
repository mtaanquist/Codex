CREATE TABLE "assistant_review_runs" (
	"job_id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"state" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_review_runs" ADD CONSTRAINT "assistant_review_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;