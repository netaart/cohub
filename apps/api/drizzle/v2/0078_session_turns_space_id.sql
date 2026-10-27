ALTER TABLE "v2"."session_turns" ADD COLUMN IF NOT EXISTS "space_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v2_idx_session_turns_space_created_at" ON "v2"."session_turns" USING btree ("space_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);
