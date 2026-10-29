CREATE TABLE "v2"."space_workspace_usage" (
	"space_id" uuid PRIMARY KEY NOT NULL,
	"bytes" bigint,
	"measured_at" timestamp with time zone,
	"attempted_at" timestamp with time zone,
	"changed_at" timestamp with time zone,
	"failures" integer DEFAULT 0 NOT NULL,
	"error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v2_chk_space_workspace_usage_bytes" CHECK ("v2"."space_workspace_usage"."bytes" is null or "v2"."space_workspace_usage"."bytes" >= 0)
);
