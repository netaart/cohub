import { createNotifier } from "@cohub/core/notifications";
import { createLogger } from "@cohub/infra/logging";
import { dispatchRealtimeEvent } from "./channels.js";
import { db } from "./db/index.js";

export const notifier = createNotifier({
  db,
  publish: dispatchRealtimeEvent,
  logger: createLogger({ serviceName: "cohub-api" }),
});
