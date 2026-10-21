import { createSessionGoalContinuation, getSessionGoal, listStalledSessionGoals } from "@cohub/core/sessions";
import { createLogger } from "@cohub/infra/logging";
import { db } from "./db/index.js";
import { enqueueAgentTurnJob } from "./agent-turn-queue.js";
import { dispatchSessionGoalUpdated, dispatchTurnCreated } from "./realtime-events.js";

const logger = createLogger({ serviceName: "cohub-api" });
const RECOVERY_INTERVAL_MS = 30_000;

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function resumeStalledSessionGoals() {
  if (running) return;
  running = true;
  try {
    const sessions = await listStalledSessionGoals(db, { idleSeconds: 30, limit: 50 });
    for (const session of sessions) {
      try {
        const result = await createSessionGoalContinuation(db, session);
        if (result.continuation) {
          await enqueueAgentTurnJob({
            spaceId: session.spaceId,
            sessionId: session.sessionId,
            reason: "goal",
          });
          await dispatchTurnCreated({
            spaceId: session.spaceId,
            sessionId: session.sessionId,
            turn: result.continuation.turn,
          });
        } else if (result.goalChanged) {
          const goal = await getSessionGoal(db, session.sessionId);
          await dispatchSessionGoalUpdated({ ...session, goal });
        } else {
          // A queued user or goal turn may have lost its queue job. Waking the
          // session is a no-op when the job is already present.
          await enqueueAgentTurnJob({
            spaceId: session.spaceId,
            sessionId: session.sessionId,
            reason: "goal",
          });
        }
      } catch (error) {
        logger.warn(`[SessionGoal] failed to resume stalled goal sessionId=${session.sessionId}`, error);
      }
    }
  } finally {
    running = false;
  }
}

export function startSessionGoalRecovery() {
  if (timer) return;
  timer = setInterval(() => {
    void resumeStalledSessionGoals().catch((error) => {
      logger.warn("[SessionGoal] stalled goal scan failed", error);
    });
  }, RECOVERY_INTERVAL_MS);
  timer.unref?.();
}
