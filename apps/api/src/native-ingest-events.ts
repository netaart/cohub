import { asc, inArray } from "drizzle-orm";
import { sessionMessages } from "@cohub/db";
import { createLogger } from "@cohub/infra/logging";
import { db } from "./db/index.js";
import type { NativeIngestEffects } from "./native-turns.js";
import { dispatchSessionCreated, dispatchSessionUpdated, dispatchTurnCreated, messageRecordFromRow } from "./realtime-events.js";
import { dispatchSessionOutput, dispatchTurnFinalized, dispatchTurnUpdated } from "./session-output.js";
import { enqueueSessionMessagePostprocess } from "./session-message-postprocess-queue.js";
import { getSessionTurnById, hydrateTurnAuthorProfiles } from "./session-turns.js";
import { getSpaceSessionById } from "./space-sessions.js";
import { touchSpaceActivity } from "./space-activity.js";

const logger = createLogger({ serviceName: "cohub-api" });
const warn = (event: string) => (error: unknown) => logger.warn(`[NativeTurn] ${event} failed`, { error });

/**
 * Realtime and follow-up work for an ingest batch; it mirrors durable writes and never fails them.
 */
export async function publishNativeIngest(spaceId: string, effects: NativeIngestEffects): Promise<void> {
  const created = new Set(effects.createdSessions);
  const live = effects.turns.filter((turn) => !turn.imported);
  const settled = effects.turns.filter((turn) => turn.changed);
  const turnIds = [...new Set([...live, ...settled].map((turn) => turn.turnId))];
  const messages = turnIds.length ? await db.select().from(sessionMessages).where(inArray(sessionMessages.turnId, turnIds)).orderBy(asc(sessionMessages.sequence)) : [];
  const byTurn = new Map<string, typeof messages>();
  for (const message of messages) {
    if (!message.turnId) continue;
    const list = byTurn.get(message.turnId);
    if (list) list.push(message); else byTurn.set(message.turnId, [message]);
  }

  for (const sessionId of new Set(effects.turns.map((turn) => turn.sessionId))) {
    const session = await getSpaceSessionById(sessionId).catch(() => null);
    if (session && created.has(sessionId)) await dispatchSessionCreated(session).catch(warn("session.created"));
    for (const entry of live.filter((turn) => turn.sessionId === sessionId)) {
      const turn = await getSessionTurnById(sessionId, entry.turnId).catch(() => null);
      if (!turn) continue;
      const turnMessages = byTurn.get(entry.turnId) ?? [];
      if (entry.created) {
        await dispatchTurnCreated({ spaceId, sessionId, turn: (await hydrateTurnAuthorProfiles([turn]))[0] ?? turn }).catch(warn("turn.created"));
        for (const message of turnMessages.filter((row) => row.role === "user")) await dispatchSessionOutput({ type: "session.message.persisted", spaceId, sessionId, message: messageRecordFromRow(message) }).catch(warn("user message"));
      }
      if (entry.changed) {
        await dispatchTurnUpdated({ spaceId, sessionId, turn }).catch(warn("turn.updated"));
        await dispatchTurnFinalized({ spaceId, sessionId, turn }).catch(warn("turn.finalized"));
        for (const message of turnMessages.filter((row) => row.role === "assistant")) await dispatchSessionOutput({ type: "session.message.persisted", spaceId, sessionId, message: messageRecordFromRow(message) }).catch(warn("assistant message"));
      }
    }
    if (session) await dispatchSessionUpdated({ session, changed: ["latestMessageText", "lastMessageAt", "lastMessageId"] }).catch(warn("session.updated"));
  }
  for (const entry of settled) {
    for (const message of byTurn.get(entry.turnId) ?? []) {
      if (message.role === "assistant") await enqueueSessionMessagePostprocess({ sessionId: entry.sessionId, messageId: message.id }).catch(warn("postprocess enqueue"));
    }
  }
  await touchSpaceActivity(spaceId).catch(warn("activity touch"));
}
