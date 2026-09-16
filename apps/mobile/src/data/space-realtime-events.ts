import type { CohubClient, SessionRecord } from "@neta-art/cohub";
import type { LatestSessionTurn } from "./session-status";

export type SpaceRealtimeEvent = Parameters<Parameters<CohubClient["onUserEvent"]>[0]>[0];

type SpaceChange = {
  exact: string[];
  prefixes: string[];
  sessionId?: string;
  session?: Partial<SessionRecord>;
  turn?: Partial<LatestSessionTurn>;
};

/** Only summary/lifecycle events invalidate reads; stream patches belong to the Chat reducer. */
export function spaceRealtimeChange(event: SpaceRealtimeEvent): SpaceChange {
  const change: SpaceChange = { exact: [], prefixes: [] };
  const spaceId = event.spaceId;
  if (typeof spaceId !== "string" || !spaceId.trim()) return change;
  switch (event.type) {
    case "session.created":
    case "session.updated": {
      const session = event.payload.session as Partial<SessionRecord> | undefined;
      if (typeof event.sessionId !== "string" || !session || session.id !== event.sessionId || session.spaceId !== spaceId || typeof session.updatedAt !== "string" || !Number.isFinite(Date.parse(session.updatedAt))) throw new Error("Invalid realtime Chat metadata. Reopen the Space to retry.");
      change.sessionId = event.sessionId;
      const metadata: Partial<SessionRecord> = { id: session.id, spaceId, updatedAt: session.updatedAt };
      for (const key of ["title", "source", "latestMessageText", "lastMessageId", "lastMessageAt"] as const) {
        const value = session[key];
        if (value === undefined) continue;
        if (value !== null && (typeof value !== "string" || (key === "lastMessageAt" && !Number.isFinite(Date.parse(value))))) throw new Error("Invalid realtime Chat metadata. Reopen the Space to retry.");
        metadata[key] = value;
      }
      change.session = metadata;
      change.prefixes.push("chats", "running:");
      change.exact.push(`space:${spaceId}:chats`, `space:${spaceId}:chat-panel`);
      break;
    }
    case "session.turn.created":
    case "session.turn.updated":
    case "session.turn.finalized": {
      const turn = event.payload.turn as Partial<LatestSessionTurn & { sessionId: string }> | undefined;
      if (typeof event.sessionId !== "string" || !event.sessionId || typeof turn?.id !== "string" || !turn.id || (turn.sessionId !== undefined && turn.sessionId !== event.sessionId) || (turn.sequence !== undefined && (!Number.isSafeInteger(turn.sequence) || turn.sequence < 1)) || (turn.status !== undefined && !["queued", "running", "abort_requested", "completed", "failed", "interrupted", "merged", "cancelled"].includes(turn.status)) || (turn.updatedAt !== undefined && (typeof turn.updatedAt !== "string" || !Number.isFinite(Date.parse(turn.updatedAt))))) throw new Error("Invalid realtime Chat status. Reopen the Space to retry.");
      change.sessionId = event.sessionId;
      change.turn = { id: turn.id, ...(turn.sequence === undefined ? {} : { sequence: turn.sequence }), ...(turn.status === undefined ? {} : { status: turn.status }), ...(turn.updatedAt === undefined ? {} : { updatedAt: turn.updatedAt }) };
      change.exact.push("chat-statuses", `space:${spaceId}:chats`, `space:${spaceId}:chat-panel`);
      change.prefixes.push("chats", "running:");
      break;
    }
    case "space.fs.changed":
      change.prefixes.push(`space:${spaceId}:files:`, `space:${spaceId}:files-panel:`);
      break;
    case "app.version.published":
      change.exact.push(`space:${spaceId}:resources`);
      break;
    case "task.created":
    case "task.updated": {
      const task = event.payload.task as { id?: unknown; status?: unknown } | undefined;
      if (typeof task?.id !== "string" || !task.id) throw new Error("Invalid realtime Task. Reopen the Space to retry.");
      change.exact.push(`space:${spaceId}:tasks`, `task:${task.id}`);
      if (event.type === "task.updated" && (task?.status === "completed" || task?.status === "failed")) change.exact.push(`space:${spaceId}:resources`);
      break;
    }
    case "label.assignments.updated":
      change.prefixes.push("chats", "running:");
      change.exact.push(`space:${spaceId}:chat-panel`);
      break;
  }
  return change;
}
