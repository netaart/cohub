CREATE TABLE "v2"."space_workspace_writers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"space_id" uuid NOT NULL,
	"lease_until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "v2"."space_workspace_writes" (
	"space_id" uuid PRIMARY KEY NOT NULL,
	"gen" bigint NOT NULL,
	"settled_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "v2_idx_space_workspace_writers_space_id" ON "v2"."space_workspace_writers" USING btree ("space_id");