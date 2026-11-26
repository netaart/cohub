import { randomUUID } from "node:crypto";
import {
  AGENT_TURN_ABORT_CHANNEL,
  AGENT_TURN_ABORT_TTL_SECONDS,
  agentTurnAbortKey,
  isNativeClientTurn,
  resolveHarness,
  type AgentTurnAbortEvent,
} from "@cohub/protocol";

export type AgentTurnAbortRedis = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: "EX", ttl: number, condition?: "NX"): Promise<unknown>;
  publish(channel: string, message: string): Promise<unknown>;
};

const storedStopReason = (raw: string | null) => {
  try {
    return raw == null ? null : (JSON.parse(raw) as Partial<AgentTurnAbortEvent>).reason ?? null;
  } catch {
    return null;
  }
};

export const steerStopsTurnAtOnce = (meta: unknown) => resolveHarness(meta) !== "cohub" || isNativeClientTurn(meta);

/** An abort replaces any stop; a steer replaces only a billing stop. */
export async function requestAgentTurnAbort(
  redis: AgentTurnAbortRedis,
  input: Omit<AgentTurnAbortEvent, "id" | "timestamp">,
): Promise<AgentTurnAbortEvent | null> {
  const event: AgentTurnAbortEvent = { ...input, id: randomUUID(), timestamp: Date.now() };
  const raw = JSON.stringify(event);
  const key = agentTurnAbortKey(event.turnId);
  if (event.reason === "abort") await redis.set(key, raw, "EX", AGENT_TURN_ABORT_TTL_SECONDS);
  else if (!await redis.set(key, raw, "EX", AGENT_TURN_ABORT_TTL_SECONDS, "NX")) {
    const current = storedStopReason(await redis.get(key));
    if (event.reason === "interrupt" && current === "billing") await redis.set(key, raw, "EX", AGENT_TURN_ABORT_TTL_SECONDS);
    else if (event.reason !== "billing" || current !== "billing") return null;
  }
  await redis.publish(AGENT_TURN_ABORT_CHANNEL, raw);
  return event;
}
