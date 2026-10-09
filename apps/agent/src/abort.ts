import { Redis } from "ioredis";
import { env } from "./env.js";
import { redis } from "./redis.js";
import { createLogger } from "@cohub/infra/logging";
import { AGENT_TURN_ABORT_CHANNEL } from "@cohub/protocol";

const logger = createLogger({ serviceName: "cohub-agent" });
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

const subscriber = new Redis(env.REDIS_URL, { disableClientInfo: true });

export async function subscribeAbortEvents(handler: (event: AgentTurnAbortEvent) => void) {
  await subscriber.subscribe(AGENT_TURN_ABORT_CHANNEL);
  subscriber.on("message", (channel, raw) => {
    if (channel !== AGENT_TURN_ABORT_CHANNEL) return;
    try {
      const event = JSON.parse(raw) as AgentTurnAbortEvent;
      if (event?.turnId) handler(event);
    } catch (error) {
      logger.warn("[AgentAbort] invalid abort event", error);
    }
  });
}

export async function getAbortEvent(turnId: string): Promise<AgentTurnAbortEvent | null> {
  const raw = await redis.get(getAgentTurnAbortKey(turnId)).catch(() => null);
  if (!raw) return null;
  try {
    const event = JSON.parse(raw) as AgentTurnAbortEvent;
    return event?.turnId === turnId ? event : null;
  } catch {
    return null;
  }
}

export async function isAbortRequested(turnId: string) {
  return Boolean(await getAbortEvent(turnId));
}

export async function closeAbortSubscriber() {
  await subscriber.quit();
}
