CREATE TABLE "v2"."resource_like_counts" (
	"resource_type" varchar(20) NOT NULL,
	"resource_id" uuid NOT NULL,
	"like_count" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "v2_pk_resource_like_counts" PRIMARY KEY("resource_type","resource_id"),
	CONSTRAINT "v2_chk_resource_like_counts_resource_type" CHECK ("v2"."resource_like_counts"."resource_type" in ('app')),
	CONSTRAINT "v2_chk_resource_like_counts_like_count" CHECK ("v2"."resource_like_counts"."like_count" >= 0)
);
--> statement-breakpoint
-- "Liked" is now a reserved user system label; keep existing custom ones under a free name.
UPDATE "v2"."labels" SET "name" = "name" || ' (' || left("id"::text, 8) || ')', "slug" = 'liked-' || left("id"::text, 8), "updated_at" = now()
WHERE "scope_type" = 'user' AND "parent_id" IS NULL AND lower("name") = 'liked' AND "system_key" IS NULL;
