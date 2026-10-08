import { ACTIVE_SESSION_TURN_STATUSES } from "@cohub/db";
import type { SessionActiveTurn, SessionTurnIssue, SessionTurnRecord, SessionTurnStatus } from "@cohub/protocol/model";
import { getRealtimeSpaceRoom, getRealtimeUserRoom } from "@cohub/protocol/realtime";

/** The subset of an active `session_turns` row that shapes a `SessionActiveTurn`. */
export type ActiveTurnRow = {
  id: string;
  sequence: number;
  status: SessionTurnStatus;
  provider: string | null;
  model: string | null;
  startedAt: Date | null;
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
  const record = meta && typeof meta === "object" && !Array.isArray(meta)
    ? (meta as Record<string, unknown>)
    : null;
  return typeof record?.userMessageId === "string" ? record.userMessageId : null;
};

export const isActiveTurnStatus = (status: string): status is SessionActiveTurn["status"] =>
  (ACTIVE_SESSION_TURN_STATUSES as readonly string[]).includes(status);

export const activeTurnFromRow = (row: ActiveTurnRow | null): SessionActiveTurn | null => row
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

const turnIssueFromRow = (row: SettledTurnRow | null): SessionTurnIssue | null =>
  row && (row.status === "failed" || row.status === "interrupted")
    ? { turnId: row.id, sequence: row.sequence, status: row.status, reason: row.reason, errorMessage: row.errorMessage }
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

/** Live Turn transitions only; settled Turns reach clients in the Session snapshot. */
export function sessionActiveTurnEvent(input: {
  spaceId: string;
  turn: Parameters<typeof activeTurnFromTurn>[0] & Pick<SessionTurnRecord, "sessionId" | "userUuid">;
}) {
  const activeTurn = activeTurnFromTurn(input.turn);
  if (!activeTurn) return null;
  const { spaceId, turn } = input;
  return {
    domain: "session" as const,
    type: "session.updated" as const,
    spaceId,
    sessionId: turn.sessionId,
    rooms: [getRealtimeSpaceRoom(spaceId), ...(turn.userUuid ? [getRealtimeUserRoom(turn.userUuid)] : [])],
    payload: {
      session: { id: turn.sessionId, spaceId, activeTurn, activeTurnSequence: activeTurn.sequence, lastTurnIssue: null },
      changed: ["activeTurn", "activeTurnSequence", "lastTurnIssue"],
    },
  };
}
