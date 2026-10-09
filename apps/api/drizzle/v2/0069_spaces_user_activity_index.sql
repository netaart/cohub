CREATE INDEX "v2_idx_spaces_user_activity" ON "v2"."spaces" USING btree ("user_uuid","last_activity_at" DESC NULLS LAST,"created_at" DESC NULLS LAST);--> statement-breakpoint
DROP INDEX "v2"."v2_idx_spaces_user_uuid";
