UPDATE "v2"."space_members" SET "created_at" = coalesce("updated_at", now()) WHERE "created_at" IS NULL;--> statement-breakpoint
CREATE INDEX "v2_idx_space_members_user_joined" ON "v2"."space_members" USING btree ("user_id","created_at" DESC NULLS LAST,"space_id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "v2"."space_members" ALTER COLUMN "created_at" SET NOT NULL;--> statement-breakpoint
DROP INDEX "v2"."v2_idx_space_members_user";
