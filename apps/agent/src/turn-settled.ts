import { createTurnSettledHandler } from "@cohub/infra/session-turn-settled";
import { env } from "./env.js";

export const onTurnSettled = createTurnSettledHandler({
  redisUrl: env.BULLMQ_REDIS_URL,
  telemetryServiceName: "cohub-agent-turn-settled",
});
