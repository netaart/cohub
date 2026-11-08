CREATE TABLE "v2"."slug_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"owner_uuid" text,
	"old_slug" varchar(80) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v2_chk_slug_history_entity_type" CHECK ("v2"."slug_history"."entity_type" in ('username', 'space'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_slug_history_username" ON "v2"."slug_history" USING btree ("old_slug") WHERE "v2"."slug_history"."entity_type" = 'username';--> statement-breakpoint
CREATE UNIQUE INDEX "v2_uq_slug_history_space" ON "v2"."slug_history" USING btree ("owner_uuid","old_slug") WHERE "v2"."slug_history"."entity_type" = 'space' and "v2"."slug_history"."owner_uuid" is not null;--> statement-breakpoint
CREATE INDEX "v2_idx_slug_history_entity" ON "v2"."slug_history" USING btree ("entity_type","entity_id","created_at" DESC NULLS LAST);