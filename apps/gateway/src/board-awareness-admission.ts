import { BOARD_SCRIPT_BROADCASTS_PER_SECOND } from "@cohub/protocol/realtime";

export const BOARD_AWARENESS_MAX_EVENTS_PER_SECOND = 60;
export const BOARD_AWARENESS_MAX_PENDING = 32;
/** Clients send at most BOARD_SCRIPT_BROADCASTS_PER_SECOND in their own window; ours may straddle two of theirs. */
export const BOARD_SCRIPT_MAX_BROADCASTS_PER_SECOND = 2 * BOARD_SCRIPT_BROADCASTS_PER_SECOND;

export type BoardAwarenessRate = {
  startedAt: number;
  count: number;
};

/** Consume one event from a fixed one-second admission window. */
export function consumeBoardAwarenessRate(
  rate: BoardAwarenessRate,
  now = Date.now(),
  limit = BOARD_AWARENESS_MAX_EVENTS_PER_SECOND,
): boolean {
  if (now - rate.startedAt >= 1_000) {
    rate.startedAt = now;
    rate.count = 1;
    return true;
  }
  rate.count += 1;
  return rate.count <= limit;
}

/** Transient awareness is dropped instead of building an unbounded publish tail. */
export function hasBoardAwarenessCapacity(
  pending: number,
  maxPending = BOARD_AWARENESS_MAX_PENDING,
): boolean {
  return pending < maxPending;
}
