import type { SessionRecord } from "@neta-art/cohub";
import type { Column } from "./output.js";

type SessionStatusFields = Pick<SessionRecord, "activeTurn" | "lastTurnIssue">;

export function sessionStatusText(session: Partial<SessionStatusFields>): string {
  const turn = session.activeTurn;
  if (turn) return turn.status === "abort_requested" ? "stopping" : turn.status;
  const issue = session.lastTurnIssue;
  if (issue?.status === "failed") return "failed";
  return issue?.reason === "stale_active_recovered" ? "interrupted" : "";
}

export const SESSION_STATUS_COLUMN: Column = {
  key: "activeTurn",
  label: "Status",
  format: (_value, row) => sessionStatusText(row as Partial<SessionStatusFields>),
};
