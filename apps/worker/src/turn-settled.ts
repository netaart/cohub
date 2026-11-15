import { createTurnSettledHandler } from "@cohub/infra/session-turn-settled";
import { config } from "./config.js";

export const onTurnSettled = createTurnSettledHandler({
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-worker-turn-settled",
});
