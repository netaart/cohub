import type { SessionArchiveFilter, SessionRecord } from "@neta-art/cohub";
import type { Column } from "./output.js";

type SessionStatusFields = Pick<SessionRecord, "activeTurn" | "lastTurnIssue" | "archivedAt">;

export function sessionStatusText(session: Partial<SessionStatusFields>): string {
  const turn = session.activeTurn;
  if (turn) return turn.status === "abort_requested" ? "stopping" : turn.status;
  if (session.archivedAt) return "archived";
  const issue = session.lastTurnIssue;
  if (issue?.status === "failed") return "failed";
  if (issue?.reason === "billing") return "stopped: insufficient balance";
  return issue?.reason === "stale_active_recovered" ? "interrupted" : "";
}

export const SESSION_STATUS_COLUMN: Column = {
  key: "activeTurn",
  label: "Status",
  format: (_value, row) => sessionStatusText(row as Partial<SessionStatusFields>),
};

export function sessionArchiveFilter(opts: { archived?: boolean; all?: boolean }): SessionArchiveFilter | undefined {
  if (opts.archived && opts.all) {
    process.stderr.write("\n  ✗ Use either --archived or --all\n\n");
    process.exit(1);
  }
  return opts.archived ? "only" : opts.all ? "include" : undefined;
}
