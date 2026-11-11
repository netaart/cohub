-- task_runs is large: pre-create this index before deploy so the migration only drops the old one and writes stay open:
--   CREATE INDEX CONCURRENTLY IF NOT EXISTS "v2_idx_task_runs_cron_job_created" ON "v2"."task_runs" USING btree ("cron_job_id","created_at","id");
CREATE INDEX IF NOT EXISTS "v2_idx_task_runs_cron_job_created" ON "v2"."task_runs" USING btree ("cron_job_id","created_at","id");--> statement-breakpoint
DROP INDEX IF EXISTS "v2"."v2_idx_task_runs_cron_job_id";
