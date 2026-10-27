-- 2-gram indexes for caseless (e.g. Chinese) chat search. Under the `C` ctype pg_trgm extracts no
-- trigrams from CJK text, so those LIKE searches otherwise scan every turn.
--
-- Not a migration: pg_bigm needs a superuser (polardb_admin), and only CONCURRENTLY keeps turn writes open.
-- Run outside a transaction:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/db/search-bigm-indexes.sql
-- If a build is interrupted, drop the INVALID index it leaves behind and rerun.

SET maintenance_work_mem = '1GB';
CREATE EXTENSION IF NOT EXISTS pg_bigm;
CREATE INDEX CONCURRENTLY IF NOT EXISTS v2_idx_space_sessions_title_bigm ON v2.space_sessions USING gin (title gin_bigm_ops);
CREATE INDEX CONCURRENTLY IF NOT EXISTS v2_idx_session_turns_user_text_bigm ON v2.session_turns USING gin (user_text gin_bigm_ops);
