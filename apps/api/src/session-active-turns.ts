import type { SessionActiveTurn, SessionTurnRecord, SessionTurnStatus } from "@cohub/protocol/model";

/**
 * The subset of an active `session_turns` row that shapes a `SessionActiveTurn`.
 * Rows are expected newest-first per session and already filtered to active
 * statuses; the first row for a session wins.
 */
export type ActiveTurnRow = {
  sessionId: string;
  id: string;
  sequence: number;
  status: SessionTurnStatus;
  provider: string | null;
  model: string | null;
  startedAt: Date | null;
  meta: unknown;
};

const readAnchorUserMessageId = (meta: unknown): string | null => {
  const record = meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : null;
  return typeof record?.userMessageId === "string" ? record.userMessageId : null;
};

export const ACTIVE_TURN_STATUSES = ["queued", "running", "abort_requested"] as const;

export const isActiveTurnStatus = (status: string): status is SessionActiveTurn["status"] =>
  (ACTIVE_TURN_STATUSES as readonly string[]).includes(status);

export const activeTurnFromRow = (row: Omit<ActiveTurnRow, "sessionId"> | null): SessionActiveTurn | null => row
  ? {
      id: row.id,
      sequence: row.sequence,
      status: row.status as SessionActiveTurn["status"],
      provider: row.provider ?? null,
      model: row.model ?? null,
      startedAt: row.startedAt?.toISOString() ?? null,
      anchorUserMessageId: readAnchorUserMessageId(row.meta),
    }
  : null;

export const activeTurnFromTurn = (
  turn: Pick<SessionTurnRecord, "id" | "sequence" | "status" | "provider" | "model" | "startedAt" | "meta">,
): SessionActiveTurn | null =>
  isActiveTurnStatus(turn.status)
    ? {
        id: turn.id,
        sequence: turn.sequence,
        status: turn.status,
        provider: turn.provider ?? null,
        model: turn.model ?? null,
        startedAt: turn.startedAt ?? null,
        anchorUserMessageId: readAnchorUserMessageId(turn.meta),
      }
    : null;

/**
 * Attach the active turn (if any) to each session, preserving the input order.
 * Pure — the caller owns the query, this owns the shape.
 */
export const pickActiveTurns = <T extends { id: string }>(
  sessions: T[],
  rows: ActiveTurnRow[],
): (T & { activeTurn: SessionActiveTurn | null; activeTurnSequence?: number })[] => {
  const bySessionId = new Map<string, SessionActiveTurn>();
  for (const row of rows) {
    if (bySessionId.has(row.sessionId)) continue;
    const active = activeTurnFromRow(row);
    if (!active) continue;
    bySessionId.set(row.sessionId, active);
  }
  return sessions.map((session) => {
    const activeTurn = bySessionId.get(session.id) ?? null;
    return {
      ...session,
      activeTurn,
      ...(activeTurn ? { activeTurnSequence: activeTurn.sequence } : {}),
    };
  });
};
