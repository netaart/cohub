import { DEFAULT_AGENT_WORKER_CONCURRENCY } from "@cohub/infra/bullmq";
import { z } from "zod";

const redisUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "redis:" || url.protocol === "rediss:";
    } catch {
      return false;
    }
  }, "REDIS_URL must use redis:// or rediss://");

const defaultAgentInstanceId = process.env.HOSTNAME?.trim() || `agent-${process.pid}`;

export const EnvSchema = z.object({
  AGENT_INSTANCE_ID: z.string().min(1).default(defaultAgentInstanceId),
  REDIS_URL: redisUrlSchema.default("redis://localhost:6379"),
  BULLMQ_REDIS_URL: redisUrlSchema.default(process.env.REDIS_URL ?? "redis://localhost:6379"),
  DATABASE_URL: z.string().min(1),
  AGENT_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(DEFAULT_AGENT_WORKER_CONCURRENCY),
  AGENT_JOB_LOCK_DURATION_MS: z.coerce.number().int().positive().default(120_000),
  AGENT_JOB_LOCK_RENEW_TIME_MS: z.coerce.number().int().positive().default(45_000),
  AGENT_JOB_STALLED_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  AGENT_JOB_MAX_STALLED_COUNT: z.coerce.number().int().min(0).default(1),
  AGENT_SESSION_LOCK_TTL_MS: z.coerce.number().int().positive().default(120_000),
  AGENT_SESSION_LOCK_RENEW_INTERVAL_MS: z.coerce.number().int().positive().default(30_000),
  AGENT_STALE_ACTIVE_TURN_MS: z.coerce.number().int().positive().default(30 * 60_000),
  AGENT_BUSY_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(1_000),
  AGENT_BUSY_RETRY_MAX_DELAY_MS: z.coerce.number().int().positive().default(30_000),
  AGENT_SHUTDOWN_DRAIN_TIMEOUT_MS: z.coerce.number().int().positive().default(24 * 60 * 60_000),
  WORKSPACE_ROOT: z
    .string()
    .min(1)
    .refine((value) => value.startsWith("/"), {
      message: "WORKSPACE_ROOT must be an absolute path",
    })
    .default("/space-storage"),
  CHECKPOINT_CACHE_ROOT: z
    .string()
    .min(1)
    .refine((value) => value.startsWith("/"), {
      message: "CHECKPOINT_CACHE_ROOT must be an absolute path",
    })
    .default("/checkpoint-cache"),
  SESSIONS_DIR: z
    .string()
    .min(1)
    .refine((value) => value.startsWith("/"), {
      message: "SESSIONS_DIR must be an absolute path",
    })
    .default("/sessions"),
  PLATFORM_CONFIG_ROOT: z
    .string()
    .min(1)
    .refine((value) => value.startsWith("/"), {
      message: "PLATFORM_CONFIG_ROOT must be an absolute path",
    })
    .default("/configs"),
  ENV: z.enum(["dev", "prod"]).default("dev"),
  AGENT_VERSION: z.string().optional(),
  WORKER_SECRET: z.string().optional(),
  APP_ENCRYPTION_KEY: z.string().min(1),
  SESSIONS_NAMESPACE: z.string().min(1),
  TURN_OBJECT_S3_ENDPOINT: z.string().min(1).default("https://oss-us-west-1-internal.aliyuncs.com"),
  TURN_OBJECT_S3_REGION: z.string().min(1).default("us-west-1"),
  TURN_OBJECT_S3_BUCKET: z.string().min(1).default("cohub-sessions"),
  TURN_OBJECT_S3_ACCESS_KEY_ID: z.string().optional(),
  TURN_OBJECT_S3_SECRET_ACCESS_KEY: z.string().optional(),
  TURN_OBJECT_S3_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  TURN_OBJECT_S3_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  TURN_OBJECT_CDN_BASE_URL: z.string().optional().transform((value) => value?.replace(/\/+$/, "")),
  /**
   * How grep and find use the sandbox workspace index. `shadow` answers from
   * the full rg/fd walk and compares the index plan against it; `on` answers
   * from the plan; `off` never asks the index.
   */
  AGENT_SEARCH_INDEX: z.enum(["off", "shadow", "on"]).default("shadow"),
});

export type Env = z.infer<typeof EnvSchema>;
export const env = EnvSchema.parse(process.env);

export const AGENT_INSTANCE_HEARTBEAT_MS = 5000;
export const SPACE_OWNER_LEASE_MS = 15000;
