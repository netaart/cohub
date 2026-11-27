-- Usage jobs on a worker mismatched with this migration fail unclaimed; re-drive them with scripts/requeue-unaggregated-usage.ts.
LOCK TABLE "v2"."token_usage_stats_hourly" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
WITH "duplicates" AS (
  DELETE FROM "v2"."token_usage_stats_hourly"
  WHERE ctid IN (
    SELECT ctid FROM (
      SELECT ctid, count(*) OVER (PARTITION BY "bucket_start_at", "user_id", "space_id", "session_id", "provider", "model") AS "copies"
      FROM "v2"."token_usage_stats_hourly"
    ) AS "counted"
    WHERE "copies" > 1
  )
  RETURNING *
)
INSERT INTO "v2"."token_usage_stats_hourly" (
  "bucket_start_at", "user_id", "space_id", "session_id", "provider", "model",
  "request_count", "success_count", "error_count",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens",
  "cost_input", "cost_output", "cost_cache_read", "cost_cache_write", "cost_total",
  "created_at", "updated_at"
)
SELECT
  "bucket_start_at", "user_id", "space_id", "session_id", "provider", "model",
  sum("request_count"), sum("success_count"), sum("error_count"),
  sum("input_tokens"), sum("output_tokens"), sum("cache_read_tokens"), sum("cache_write_tokens"), sum("total_tokens"),
  sum("cost_input"), sum("cost_output"), sum("cost_cache_read"), sum("cost_cache_write"), sum("cost_total"),
  min("created_at"), max("updated_at")
FROM "duplicates"
GROUP BY "bucket_start_at", "user_id", "space_id", "session_id", "provider", "model";--> statement-breakpoint
DROP INDEX "v2"."v2_uq_token_usage_stats_hourly_bucket_dims";--> statement-breakpoint
ALTER TABLE "v2"."token_usage_stats_hourly" ADD COLUMN "harness" varchar(32) DEFAULT 'cohub' NOT NULL;--> statement-breakpoint
ALTER TABLE "v2"."token_usage_stats_hourly" ADD CONSTRAINT "v2_uq_token_usage_stats_hourly_dims" UNIQUE NULLS NOT DISTINCT("bucket_start_at","user_id","space_id","session_id","harness","provider","model");
