import type {
  SessionActiveTurn,
  SessionTurnIssue,
  SessionTurnStatus,
} from "@cohub/protocol/model";

/** The subset of an active `session_turns` row that shapes a `SessionActiveTurn`. */
export type ActiveTurnRow = {
  id: string;
  sequence: number;
  status: SessionTurnStatus;
  provider: string | null;
  model: string | null;
  startedAt: Date | null;
  updatedAt?: Date | null;
  meta: unknown;
};

export type SettledTurnRow = {
  id: string;
  sequence: number;
  status: SessionTurnStatus;
  reason: string | null;
  errorMessage: string | null;
};

export type SessionActiveTurnState = {
  activeTurn: SessionActiveTurn | null;
  activeTurnSequence?: number;
  lastTurnIssue: SessionTurnIssue | null;
};

const readAnchorUserMessageId = (meta: unknown): string | null => {
  const record =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : null;
  return typeof record?.userMessageId === "string"
    ? record.userMessageId
    : null;
};

export const activeTurnFromRow = (
  row: ActiveTurnRow | null,
): SessionActiveTurn | null =>
  row
    ? {
        id: row.id,
        sequence: row.sequence,
        status: row.status as SessionActiveTurn["status"],
        provider: row.provider ?? null,
        model: row.model ?? null,
        startedAt: row.startedAt?.toISOString() ?? null,
        updatedAt:
          row.updatedAt instanceof Date
            ? row.updatedAt.toISOString()
            : (row.updatedAt ?? null),
        anchorUserMessageId: readAnchorUserMessageId(row.meta),
      }
    : null;

const turnIssueFromRow = (
  row: SettledTurnRow | null,
): SessionTurnIssue | null =>
  row && (row.status === "failed" || row.status === "interrupted")
    ? {
        turnId: row.id,
        sequence: row.sequence,
        status: row.status,
        reason: row.reason,
        errorMessage: row.errorMessage,
      }
    : null;

export const sessionActiveTurnState = (
  active: ActiveTurnRow | null,
  latestSequence: number | null,
  settled: SettledTurnRow | null = null,
): SessionActiveTurnState => {
  const activeTurn = activeTurnFromRow(active);
  const activeTurnSequence = activeTurn?.sequence ?? latestSequence;
  return {
    activeTurn,
    ...(activeTurnSequence == null ? {} : { activeTurnSequence }),

    lastTurnIssue: activeTurn ? null : turnIssueFromRow(settled),
  };
};
