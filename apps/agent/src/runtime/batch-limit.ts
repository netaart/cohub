import { RUNTIME_MAX_BATCH_INPUT_BYTES, RUNTIME_MAX_BATCH_MESSAGES } from "@cohub/protocol";

/**
 * Bound one claim so a single Runtime execution stays inside the transfer budget.
 * A single oversized input cannot be split further; the transport reports that clearly.
 */
export function limitBatchSize<T>(
  turns: T[],
  sizeOf: (turn: T) => number,
  limits: { messages: number; bytes: number } = { messages: RUNTIME_MAX_BATCH_MESSAGES, bytes: RUNTIME_MAX_BATCH_INPUT_BYTES },
): T[] {
  const batch: T[] = [];
  let bytes = 0;
  for (const turn of turns) {
    if (batch.length >= limits.messages) break;
    const size = sizeOf(turn);
    if (batch.length > 0 && bytes + size > limits.bytes) break;
    batch.push(turn);
    bytes += size;
  }
  return batch.length ? batch : turns.slice(0, 1);
}

/** The owner's approval mode governs a merged execution, so a change of mode ends the batch. */
export function limitBatchToApprovalMode<T extends { meta: unknown }>(turns: T[]): T[] {
  const modeOf = (turn: T) => turn.meta && typeof turn.meta === "object" ? (turn.meta as { approvalMode?: unknown }).approvalMode : undefined;
  const first = turns[0];
  if (!first) return turns;
  const end = turns.findIndex((turn) => modeOf(turn) !== modeOf(first));
  return end === -1 ? turns : turns.slice(0, end);
}

/** Merged follow-ups run as one Turn, so the newest context window request in the batch wins. */
export function resolveBatchContextWindow(turns: Array<{ meta: unknown }>): number | undefined {
  for (const turn of [...turns].reverse()) {
    const value = (turn.meta as Record<string, unknown> | null)?.requestedContextWindow;
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}
