CREATE TABLE "v2"."user_preferences" (
	"user_uuid" varchar(255) PRIMARY KEY NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
