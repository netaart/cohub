import { createTurnJobs } from "@cohub/infra/session-turn-settled";
import { env } from "./env.js";

export const onTurnSettled = createTurnJobs({
  redisUrl: env.BULLMQ_REDIS_URL,
  telemetryServiceName: "cohub-agent-turn-settled",
}).turnSettled;
