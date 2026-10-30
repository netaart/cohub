import { randomUUID } from "node:crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import { shouldNotifyTurn, turnNotificationSource } from "@cohub/protocol/notifications";
import { getRealtimeUserRoom, type RealtimeRoom, type SessionTurnNotifyEvent } from "@cohub/protocol/realtime";
import { loadUserPreferences } from "../preferences/index.js";

type Database = PostgresJsDatabase<Record<string, unknown>>;
export type TurnNotifyDispatch = SessionTurnNotifyEvent & { rooms: RealtimeRoom[] };

const truncateTurnPreview = (text: string | null | undefined) => {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
};

/**
 * Tells the turn's owner it finished. A silenced completion is still published
 * (with `silent`) because clients also use it as an activity signal.
 */
export async function publishTurnNotification(
  db: Database,
  spaceId: string,
  turn: SessionTurnRecord,
  publish: (event: TurnNotifyDispatch) => Promise<unknown>,
  onPreferencesError: (error: unknown) => void,
) {
  const userUuid = turn.userUuid;
  if (!userUuid) return;
  const context = turn.meta?.context as { cronJobId?: unknown } | null | undefined;
  const source = turnNotificationSource(context);
  const cronJobId = source === "scheduled" && typeof context?.cronJobId === "string" ? context.cronJobId : null;
  const notify = turn.status !== "completed" || source === "chat"
    || await loadUserPreferences(db, userUuid).then(
      (preferences) => shouldNotifyTurn(preferences.notifications, { status: turn.status, source, cronJobId }),
      (error: unknown) => {
        onPreferencesError(error);
        return true;
      },
    );
  await publish({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: "session.turn.notify",
    spaceId,
    sessionId: turn.sessionId,
    rooms: [getRealtimeUserRoom(userUuid)],
    payload: {
      spaceId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      status: turn.status,
      finishReason: turn.summary?.finishReason ?? null,
      userPreview: truncateTurnPreview(turn.userText),
      durationMs: turn.durationMs,
      stepCount: turn.intermediateSummary?.messageCount ?? null,
      sequence: turn.sequence ?? null,
      provider: turn.provider,
      model: turn.model,
      completedAt: turn.completedAt,
      source,
      cronJobId,
      silent: !notify,
    },
  });
}
