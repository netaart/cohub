import { createTurnJobs } from "@cohub/infra/session-turn-settled";
import { config } from "./config.js";

const turnJobs = createTurnJobs({
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-turn-settled",
});

export const onTurnSettled = turnJobs.turnSettled;
export const onTurnWritten = turnJobs.turnWritten;
