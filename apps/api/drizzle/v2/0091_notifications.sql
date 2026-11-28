CREATE TABLE "v2"."inbox_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recipient_id" varchar(255) NOT NULL,
	"kind" varchar(40) NOT NULL,
	"group_key" text NOT NULL,
	"space_id" uuid,
	"session_id" uuid,
	"turn_id" uuid,
	"actor_ids" text[] DEFAULT '{}'::text[] NOT NULL,
	"payload" jsonb NOT NULL,
	"count" integer DEFAULT 1 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."notification_preferences" (
	"user_id" varchar(255) NOT NULL,
	"scope_type" varchar(16) NOT NULL,
	"scope_id" text DEFAULT '' NOT NULL,
	"kind" varchar(40) NOT NULL,
	"channels" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v2_pk_notification_preferences" PRIMARY KEY("user_id","scope_type","scope_id","kind"),
	CONSTRAINT "v2_chk_notification_preferences_scope_type" CHECK ("v2"."notification_preferences"."scope_type" in ('global', 'space', 'session'))
);
--> statement-breakpoint
CREATE TABLE "v2"."push_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"device_id" varchar(64) NOT NULL,
	"transport" varchar(16) NOT NULL,
	"token" text NOT NULL,
	"keys" jsonb,
	"locale" varchar(16),
	"failure_count" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v2_chk_push_targets_transport" CHECK ("v2"."push_targets"."transport" in ('webpush', 'fcm', 'apns'))
);
--> statement-breakpoint
ALTER TABLE "v2"."user_profiles" ADD COLUMN "email" varchar(320);--> statement-breakpoint
ALTER TABLE "v2"."user_profiles" ADD COLUMN "locale" varchar(16);--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_inbox_items_recipient_group" ON "v2"."inbox_items" USING btree ("recipient_id","group_key");--> statement-breakpoint
CREATE INDEX "v2_idx_inbox_items_recipient_updated" ON "v2"."inbox_items" USING btree ("recipient_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "v2_idx_inbox_items_recipient_unread" ON "v2"."inbox_items" USING btree ("recipient_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "v2"."inbox_items"."read_at" is null;--> statement-breakpoint
CREATE INDEX "v2_idx_inbox_items_recipient_session_unread" ON "v2"."inbox_items" USING btree ("recipient_id","session_id") WHERE "v2"."inbox_items"."read_at" is null and "v2"."inbox_items"."session_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_push_targets_transport_token" ON "v2"."push_targets" USING btree ("transport","token");--> statement-breakpoint
CREATE INDEX "v2_idx_push_targets_user_active" ON "v2"."push_targets" USING btree ("user_id") WHERE "v2"."push_targets"."disabled_at" is null;