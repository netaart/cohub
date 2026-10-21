import { publishRealtimeEnvelope } from "../redis.js";
import type { SessionGoal } from "@cohub/protocol/model";

export async function publishSessionGoalUpdated(input: {
  spaceId: string;
  sessionId: string;
  goal: SessionGoal;
}) {
  await publishRealtimeEnvelope({
    domain: "session",
    type: "session.goal.updated",
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    payload: { goal: input.goal },
  });
}
