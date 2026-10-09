DROP TABLE "v2"."user_git_accounts";--> statement-breakpoint
DROP INDEX "v2"."v2_uq_spaces_storage_repo_name";--> statement-breakpoint
ALTER TABLE "v2"."spaces" ALTER COLUMN "storage_repo_name" DROP NOT NULL;
