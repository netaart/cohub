import { isUuidLike } from "./identifiers.js";
import { normalizeRequestSource, type RequestSource } from "./provenance.js";

export type SessionTurnOriginKind = "prompt" | "scheduled_prompt" | "background_task" | "hook";

/** The immediate caller, not the target Session or a previous Turn in that Session. */
export type SessionTurnOrigin = {
  kind: SessionTurnOriginKind;
  spaceId: string;
  sessionId: string;
  turnId: string;
  toolCallId?: string;
  /** Omitted for legacy records whose ancestry depth is unknown. */
  depth?: number;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const normalizeSessionTurnOrigin = (value: unknown): SessionTurnOrigin | null => {
  const input = record(value);
  if (!input || !["prompt", "scheduled_prompt", "background_task", "hook"].includes(String(input.kind))) return null;
  const source = normalizeRequestSource(input);
  if (!source?.spaceId || !source.sessionId || !source.turnId) return null;
  return {
    kind: input.kind as SessionTurnOriginKind,
    spaceId: source.spaceId,
    sessionId: source.sessionId,
    turnId: source.turnId,
    ...(source.toolCallId ? { toolCallId: source.toolCallId } : {}),
    ...(typeof input.depth === "number" && Number.isSafeInteger(input.depth) && input.depth > 0 ? { depth: input.depth } : {}),
  };
};

/** Reads durable provenance; legacy background tasks only knew their caller's Session/Turn. */
export const readSessionTurnOrigin = (meta: unknown, spaceId?: string): SessionTurnOrigin | null => {
  const input = record(meta);
  const origin = normalizeSessionTurnOrigin(input?.origin);
  if (origin) return origin;
  const context = record(input?.context);
  if (context?.kind !== "background_bash_task" || !isUuidLike(spaceId)) return null;
  const legacy = record(context.origin);
  return normalizeSessionTurnOrigin({ ...legacy, spaceId, kind: "background_task" });
};

/** Turn-finalized hooks have an explicit event Turn; other events must not invent one. */
export const turnEventRequestSource = (event: {
  type: string;
  spaceId: string;
  sessionId?: string | null;
  payload: unknown;
}): RequestSource | null => {
  if (event.type !== "session.turn.finalized") return null;
  const turn = record(record(event.payload)?.turn);
  const source = normalizeRequestSource({ spaceId: event.spaceId, sessionId: event.sessionId, turnId: turn?.id });
  return source?.turnId ? source : null;
};
