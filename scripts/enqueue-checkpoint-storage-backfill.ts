#!/usr/bin/env tsx
import "dotenv/config";
import { COHUB_SYSTEM_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { config } from "../apps/api/src/config.js";

// Uploads pre-v3 checkpoint history to object storage. Idempotent; safe to rerun.
// Usage: tsx scripts/enqueue-checkpoint-storage-backfill.ts [--space-id <id>] [--batch <n>]
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const spaceId = option("space-id");
const batch = Number(option("batch") ?? 20);
if (!Number.isInteger(batch) || batch < 1) throw new Error("--batch must be a positive integer");

const queue = createBullmqQueue(COHUB_SYSTEM_QUEUE, { redisUrl: config.bullmqRedisUrl, telemetryServiceName: "checkpoint-storage-backfill" });
const job = await queue.add("checkpoint.storage_backfill", { ...(spaceId ? { spaceId } : {}), batch }, defaultJobRetention);
console.log(`enqueued checkpoint.storage_backfill job=${job.id}${spaceId ? ` space=${spaceId}` : ""}`);
await queue.close();
