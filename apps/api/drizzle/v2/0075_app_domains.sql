CREATE TABLE "v2"."app_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"space_id" uuid NOT NULL,
	"hostname" varchar(253) NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"verification_token" varchar(64) NOT NULL,
	"token_issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"provider_hostname_id" varchar(64),
	"provider_status" varchar(32),
	"certificate_status" varchar(32),
	"provider_unhealthy_since" timestamp with time zone,
	"error_code" varchar(32),
	"error_message" text,
	"removal_intent" varchar(8),
	"billing_claimed_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"activated_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_by" varchar(255) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v2_chk_app_domains_status" CHECK ("v2"."app_domains"."status" in ('pending', 'provisioning', 'active', 'failed', 'removing')),
	CONSTRAINT "v2_chk_app_domains_removal_intent" CHECK ("v2"."app_domains"."removal_intent" is null or "v2"."app_domains"."removal_intent" in ('user', 'failure'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_app_domains_app" ON "v2"."app_domains" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_app_domains_hostname_exclusive" ON "v2"."app_domains" USING btree ("hostname") WHERE "v2"."app_domains"."status" in ('provisioning', 'active', 'removing');