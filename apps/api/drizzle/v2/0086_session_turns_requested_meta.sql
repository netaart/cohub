-- session_turns is large and write-hot: pre-create these indexes before deploy so the migration is a no-op and writes stay open:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "v2_idx_session_turns_requested_thinking_level" ON "v2"."session_turns" USING btree ("session_id","sequence") WHERE ("meta"->>'requestedThinkingLevel') is not null;
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "v2_idx_session_turns_requested_context_window" ON "v2"."session_turns" USING btree ("session_id","sequence") WHERE ("meta"->>'requestedContextWindow') is not null;
CREATE INDEX IF NOT EXISTS "v2_idx_session_turns_requested_thinking_level" ON "v2"."session_turns" USING btree ("session_id","sequence") WHERE ("v2"."session_turns"."meta"->>'requestedThinkingLevel') is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "v2_idx_session_turns_requested_context_window" ON "v2"."session_turns" USING btree ("session_id","sequence") WHERE ("v2"."session_turns"."meta"->>'requestedContextWindow') is not null;
