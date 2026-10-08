CREATE INDEX IF NOT EXISTS "v2_idx_session_turns_active" ON "v2"."session_turns" USING btree ("session_id","sequence") WHERE "v2"."session_turns"."status" in ('queued', 'running', 'abort_requested');
