-- session_messages is large: pre-create this index before deploy so the migration is a no-op and writes stay open:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "v2_idx_session_messages_compaction" ON "v2"."session_messages" USING btree ("session_id") WHERE "role" = 'system';
CREATE INDEX IF NOT EXISTS "v2_idx_session_messages_compaction" ON "v2"."session_messages" USING btree ("session_id") WHERE "v2"."session_messages"."role" = 'system';
