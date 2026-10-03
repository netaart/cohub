import { isUuidLike } from "./identifiers.js";
import type { SessionTurnOriginKind } from "./turn-origin.js";

/**
 * An entry in `meta.messagesSent` on the caller Turn — the caller-side mirror of
 * `meta.origin` on the child. No title (renames would desync) and no status (live
 * state belongs to the child Session).
 */
export type SentTurnRef = {
  sessionId: string;
  turnId: string;
  kind: SessionTurnOriginKind;
};

const KINDS: readonly SessionTurnOriginKind[] = ["prompt", "scheduled_prompt", "background_task", "hook"];

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

export const normalizeSentTurnRef = (value: unknown): SentTurnRef | null => {
  const input = record(value);
  if (!input) return null;
  if (!isUuidLike(input.sessionId) || !isUuidLike(input.turnId)) return null;
  const kind = String(input.kind) as SessionTurnOriginKind;
  if (!KINDS.includes(kind)) return null;
  return { sessionId: input.sessionId as string, turnId: input.turnId as string, kind };
};

/** Deduplicates by child Turn, so a retried request cannot render one twice. */
export const readSentTurns = (meta: unknown): SentTurnRef[] => {
  const raw = record(meta)?.messagesSent;
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const refs: SentTurnRef[] = [];
  for (const value of raw) {
    const ref = normalizeSentTurnRef(value);
    if (!ref || seen.has(ref.turnId)) continue;
    seen.add(ref.turnId);
    refs.push(ref);
  }
  return refs;
};
