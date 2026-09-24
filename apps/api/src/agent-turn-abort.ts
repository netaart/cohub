import { randomUUID } from "node:crypto";
import { AGENT_TURN_ABORT_CHANNEL } from "@cohub/protocol";
import { redisCommandClient } from "./redis.js";

export const getAgentTurnAbortKey = (turnId: string) => `agent:turn:${turnId}:abort`;

export type AgentTurnAbortEvent = {
  id: string;
  spaceId: string;
  sessionId: string;
  turnId: string;
  reason: "abort" | "interrupt";
  continuedByTurnId?: string | null;
  actorUserId?: string | null;
  timestamp: number;
};

export async function requestAgentTurnAbort(input: {
  spaceId: string;
  sessionId: string;
  turnId: string;
  reason: "abort" | "interrupt";
  continuedByTurnId?: string | null;
  actorUserId?: string | null;
}) {
  const event: AgentTurnAbortEvent = {
    id: randomUUID(),
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    turnId: input.turnId,
    reason: input.reason,
    continuedByTurnId: input.continuedByTurnId ?? null,
    actorUserId: input.actorUserId ?? null,
    timestamp: Date.now(),
  };

  await redisCommandClient.set(getAgentTurnAbortKey(input.turnId), JSON.stringify(event), "EX", 60 * 60);
  await redisCommandClient.publish(AGENT_TURN_ABORT_CHANNEL, JSON.stringify(event));
  return event;
}
