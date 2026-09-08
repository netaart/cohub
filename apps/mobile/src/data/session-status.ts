import type { CohubClient, SessionTurnRecord, UserSessionListItem } from "@neta-art/cohub";

const STATUS_REQUEST_TIMEOUT_MS = 15_000;

function withTimeout<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Loading Chat status timed out after 15 seconds")), STATUS_REQUEST_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export type SessionStatus = "running" | "completed" | "failed" | "stopped" | "idle";

export type LatestSessionTurn = Pick<SessionTurnRecord, "id" | "sequence" | "status" | "updatedAt">;

export function latestTurn<T extends { sequence: number }>(turns: readonly T[]): T | null {
  return turns.reduce<T | null>((latest, turn) => !latest || turn.sequence > latest.sequence ? turn : latest, null);
}

export function reconcileLatestTurn(current: LatestSessionTurn | null | undefined, incoming: LatestSessionTurn | null): LatestSessionTurn | null {
  if (!incoming) return current ?? null;
  if (current) {
    if (incoming.sequence < current.sequence) return current;
    if (incoming.sequence === current.sequence) {
      const delta = Date.parse(incoming.updatedAt) - Date.parse(current.updatedAt);
      if (delta < 0) return current;
      // A late running snapshot must not undo finalization at the same timestamp.
      const terminal = ["completed", "failed", "interrupted", "merged", "cancelled"];
      if (delta === 0 && terminal.includes(current.status) && !terminal.includes(incoming.status)) return current;
    }
  }
  return { id: incoming.id, sequence: incoming.sequence, status: incoming.status, updatedAt: incoming.updatedAt };
}

export function reconcileTurnStatusPatch(current: LatestSessionTurn | null | undefined, patch: Partial<LatestSessionTurn>): LatestSessionTurn | null {
  const turn = current?.id === patch.id ? { ...current, ...patch } : patch;
  if (!turn.id || turn.sequence === undefined || !turn.status || !turn.updatedAt) return current ?? null;
  return reconcileLatestTurn(current, { id: turn.id, sequence: turn.sequence, status: turn.status, updatedAt: turn.updatedAt });
}

export async function loadSessionLatestTurns(
  client: CohubClient,
  sessions: Pick<UserSessionListItem, "id" | "spaceId">[],
  onTurn: (sessionId: string, turn: LatestSessionTurn | null) => void,
): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  await Promise.all(Array.from({ length: Math.min(6, sessions.length) }, async () => {
    while (next < sessions.length) {
      const session = sessions[next++]!;
      try {
        const response = await withTimeout(client.space(session.spaceId).session(session.id).turns.listPaginated({ limit: 1, direction: "older" }));
        onTurn(session.id, latestTurn(response.turns));
      } catch (error) {
        errors.push(error);
      }
    }
  }));
  if (errors.length) throw new Error(`Could not refresh ${errors.length} Chat status request(s). Pull to refresh and retry.`, { cause: errors[0] });
}

export function getSessionStatus(value: string | null | undefined): SessionStatus {
  switch (value) {
    case "running":
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
