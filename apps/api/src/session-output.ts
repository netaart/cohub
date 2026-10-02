import { createSessionStatsRefresher, refreshSessionStatsAndPublish } from "@cohub/core/sessions";
import { isSettledStatsTurn } from "@cohub/protocol/model";
import { createLogger } from "@cohub/infra/logging";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MessageRecord, SessionTurnRecord } from "@cohub/protocol/model";
import type { GatewaySessionOutput } from "@cohub/protocol/gateway";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import {
  dispatchOutboundMessage,
  dispatchRealtimeEvent,
  getProviderMessageRefBySessionMessage,
  getBindingsBySessionId,
} from "./channels.js";
import { dispatchSpaceDomainEvent } from "./space-events.js";
import { db } from "./db/index.js";
import { spaceChannels } from "@cohub/db";
import { clearSessionStreamSnapshot } from "./session-stream-snapshot.js";
import { listResourceLabelRefs } from "@cohub/core/labels";
import { toRealtimeMessageRecord, toRealtimeTurnRecord, dispatchSessionActiveTurn } from "./realtime-events.js";


const logger = createLogger({ serviceName: "cohub-api" });
const scheduleSessionStatsRefresh = createSessionStatsRefresher(
  (sessionId, fromSequence) => refreshSessionStatsAndPublish(db, sessionId, dispatchRealtimeEvent, fromSequence),
  (error, sessionId) => logger.warn("[Metrics] failed to refresh session stats", { sessionId, error }),
);

const messageTurnId = (message: MessageRecord) =>
  typeof message.meta?.turnId === "string" && message.meta.turnId ? message.meta.turnId : null;

export const buildSessionOutputsForPersistedMessage = async (input: {
  spaceId: string;
  sessionId: string;
  message: MessageRecord;
}): Promise<GatewaySessionOutput[]> => {
  const outputs: GatewaySessionOutput[] = [{
    type: "session.message.persisted",
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    message: input.message,
  }];

  if (input.message.meta?.messageKind === "assistant_error" && input.message.stopReason !== "aborted") {
    outputs.push({
      type: "session.turn.error",
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      turnId: messageTurnId(input.message),
      anchorUserMessageId: typeof input.message.meta?.anchorUserMessageId === "string"
        ? (input.message.meta.anchorUserMessageId as string)
        : null,
      error: input.message.errorMessage ?? "assistant error",
    });
  }

  return outputs;
};

const shouldClearStreamSnapshotForMessage = (message: MessageRecord) => {
  const kind = message.meta?.messageKind;
  return kind === "assistant_final" || kind === "assistant_error" || message.stopReason === "aborted";
};

const dispatchSessionOutputToRealtime = async (output: GatewaySessionOutput) => {
  if (output.type === "session.turn.error") {
    await clearSessionStreamSnapshot({ spaceId: output.spaceId, sessionId: output.sessionId, turnId: output.turnId ?? null });
    await dispatchRealtimeEvent({
      id: randomUUID(),
      timestamp: Date.now(),
      domain: "session",
      type: output.type,
      spaceId: output.spaceId,
      sessionId: output.sessionId,
      payload: {
        anchorUserMessageId: output.anchorUserMessageId,
        error: output.error,
      },
    });
    return;
  }

  if (output.type !== "session.message.persisted") return;
  if (shouldClearStreamSnapshotForMessage(output.message)) {
    await clearSessionStreamSnapshot({ spaceId: output.spaceId, sessionId: output.sessionId, turnId: messageTurnId(output.message) });
  }
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: output.type,
    spaceId: output.spaceId,
    sessionId: output.sessionId,
    payload: {
      message: toRealtimeMessageRecord(output.message),
    },
  });
};

const dispatchSessionOutputToChannels = async (output: GatewaySessionOutput) => {
  if (output.type !== "session.message.persisted") return;
  const message = output.message;
  if (message.role !== "assistant") return;

  const bindings = await getBindingsBySessionId(output.sessionId);
  if (bindings.length > 0) {
    for (const binding of bindings) {
      const turnAnchorMessageId = typeof message.meta?.anchorUserMessageId === "string"
        ? (message.meta.anchorUserMessageId as string)
        : message.id;
      const anchorRef = await getProviderMessageRefBySessionMessage({
        spaceChannelId: binding.spaceChannelId,
        sessionMessageId: turnAnchorMessageId,
        direction: "inbound",
      }).catch(() => null);

      await dispatchOutboundMessage({
        spaceChannelId: binding.spaceChannelId,
        spaceId: output.spaceId,
        spaceSessionId: output.sessionId,
        sessionMessageId: message.id,
        provider: binding.provider,
        externalChatId: binding.externalChatId,
        replyToExternalMessageId: anchorRef?.externalMessageId ?? undefined,
        content: message.content,
        meta: {
          sessionOutput: output,
          bindingKey: binding.bindingKey,
          sessionMessageRole: message.role,
          turnAnchorMessageId,
        },
      }).catch((error) => logger.error("[SessionOutput] failed to dispatch bound outbound message", { spaceId: output.spaceId, sessionId: output.sessionId, spaceChannelId: binding.spaceChannelId, sessionMessageId: message.id, error }));
    }
    return;
  }

  const channels = await db.select().from(spaceChannels).where(eq(spaceChannels.spaceId, output.spaceId));
  for (const channel of channels as Array<{ id: string }>) {
    await dispatchOutboundMessage({
      spaceChannelId: channel.id,
      spaceId: output.spaceId,
      spaceSessionId: output.sessionId,
      sessionMessageId: message.id,
      content: message.content,
      meta: {
        sessionOutput: output,
        sessionMessageRole: message.role,
      },
    }).catch((error) => logger.error("[SessionOutput] failed to dispatch channel outbound message", { spaceId: output.spaceId, sessionId: output.sessionId, spaceChannelId: channel.id, sessionMessageId: message.id, error }));
  }
};

export const dispatchSessionOutput = async (output: GatewaySessionOutput) => {
  await dispatchSessionOutputToRealtime(output);
  await dispatchSessionOutputToChannels(output);
};

export const dispatchTurnUpdated = async (input: { spaceId: string; sessionId: string; turn: SessionTurnRecord }) => {
  if (isSettledStatsTurn(input.turn)) void scheduleSessionStatsRefresh(input.sessionId, input.turn.sequence);
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: "session.turn.updated",
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    payload: {
      turn: toRealtimeTurnRecord(input.turn),
    },
  });
  await dispatchSessionActiveTurn({ spaceId: input.spaceId, sessionId: input.sessionId, turn: input.turn });
};

const truncateTurnPreview = (text: string | null | undefined) => {
  const normalized = text?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > 180 ? `${normalized.slice(0, 177)}...` : normalized;
};

export const dispatchTurnFinalized = async (input: { spaceId: string; sessionId: string; turn: SessionTurnRecord }) => {
  void scheduleSessionStatsRefresh(input.sessionId, input.turn.sequence);
  await clearSessionStreamSnapshot({ spaceId: input.spaceId, sessionId: input.sessionId, turnId: input.turn.id });
  const sessionLabelRefs = await listResourceLabelRefs({
    db,
    spaceId: input.spaceId,
    resourceType: "session",
    resourceRef: input.sessionId,
  }).catch((error) => {
    logger.warn("[SessionTurn] failed to load session labels for finalized event", {
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
  await dispatchSpaceDomainEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: "session.turn.finalized",
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    payload: {
      turn: toRealtimeTurnRecord(input.turn),
      sessionLabelRefs,
    },
  });
  await dispatchSessionActiveTurn({ spaceId: input.spaceId, sessionId: input.sessionId, turn: input.turn });

  if (!input.turn.userUuid) return;
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "session",
    type: "session.turn.notify",
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    rooms: [getRealtimeUserRoom(input.turn.userUuid)],
    payload: {
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      turnId: input.turn.id,
      status: input.turn.status,
      finishReason: input.turn.summary?.finishReason ?? null,
      userPreview: truncateTurnPreview(input.turn.userText),
      durationMs: input.turn.durationMs,
      stepCount: input.turn.intermediateSummary?.messageCount ?? null,
      sequence: input.turn.sequence ?? null,
      provider: input.turn.provider,
      model: input.turn.model,
      completedAt: input.turn.completedAt,
    },
  });
};

export const dispatchSessionOutputs = async (outputs: GatewaySessionOutput[]) => {
  for (const output of outputs) {
    await dispatchSessionOutput(output);
  }
};
