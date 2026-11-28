-- Usage jobs on a worker mismatched with this migration fail unclaimed; re-drive them with scripts/requeue-unaggregated-usage.ts.
LOCK TABLE "v2"."token_usage_stats_hourly" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
ALTER TABLE "v2"."token_usage_stats_hourly" ADD COLUMN "credential" varchar(16) DEFAULT 'platform' NOT NULL;--> statement-breakpoint
ALTER TABLE "v2"."token_usage_stats_hourly" ADD COLUMN "host" varchar(255);--> statement-breakpoint
UPDATE "v2"."token_usage_stats_hourly" SET "credential" = 'user' WHERE "harness" <> 'cohub';--> statement-breakpoint
ALTER TABLE "v2"."token_usage_stats_hourly" DROP CONSTRAINT "v2_uq_token_usage_stats_hourly_dims";--> statement-breakpoint
ALTER TABLE "v2"."token_usage_stats_hourly" ADD CONSTRAINT "v2_uq_token_usage_stats_hourly_dims" UNIQUE NULLS NOT DISTINCT("bucket_start_at","user_id","space_id","session_id","harness","credential","provider","host","model");--> statement-breakpoint
ALTER TABLE "v2"."token_usage_stats_hourly" ADD CONSTRAINT "v2_chk_token_usage_stats_hourly_credential" CHECK ("v2"."token_usage_stats_hourly"."credential" in ('platform', 'user'));
