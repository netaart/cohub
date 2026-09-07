export type SessionStatus = "running" | "completed" | "failed" | "stopped" | "idle";

export function getSessionStatus(value: string | null | undefined): SessionStatus {
  switch (value) {
    case "running":
    case "in_progress":
    case "pending":
    case "queued":
    case "abort_requested":
    case "needs_input":
    case "waiting":
      return "running";
    case "completed":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "interrupted":
    case "cancelled":
      return "stopped";
    default:
      return "idle";
  }
}

export const sessionStatusLabels: Record<SessionStatus, string> = {
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
  idle: "Idle",
};
