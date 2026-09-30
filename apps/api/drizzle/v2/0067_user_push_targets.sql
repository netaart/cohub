CREATE TABLE "v2"."user_push_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_uuid" varchar(255) NOT NULL,
	"token" varchar(200) NOT NULL,
	"environment" varchar(20) NOT NULL,
	"topic" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v2_chk_user_push_targets_environment" CHECK ("v2"."user_push_targets"."environment" in ('sandbox', 'production'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_user_push_targets_token" ON "v2"."user_push_targets" USING btree ("token");--> statement-breakpoint
CREATE INDEX "v2_idx_user_push_targets_user_uuid" ON "v2"."user_push_targets" USING btree ("user_uuid");