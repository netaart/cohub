import { eq } from "drizzle-orm";
import { spaceSessions } from "@cohub/db";
import type { SessionTurnRecord } from "@cohub/protocol/model";
import { createLogger } from "@cohub/infra/logging";
import { config } from "../config.js";
import { db } from "../db/index.js";
import {
  ApnsProviderToken,
  createApnsClient,
  createHttp2ApnsTransport,
  type ApnsClient,
  type ApnsNotification,
  type ApnsTarget,
} from "./apns.js";
import { deleteRejectedPushTarget, listUserPushTargets } from "./push-targets.js";

const logger = createLogger({ serviceName: "cohub-api" });

export type TurnPushStatus = "completed" | "failed";

const TURN_PUSH_LOC_KEYS: Record<TurnPushStatus, string> = {
  completed: "COHUB_TURN_COMPLETED",
  failed: "COHUB_TURN_FAILED",
};

/** Undelivered turn pushes stop mattering after a day. */
const TURN_PUSH_TTL_SECONDS = 24 * 60 * 60;

export const isTurnPushStatus = (status: string): status is TurnPushStatus =>
  status === "completed" || status === "failed";

/** Client-agnostic payload: iOS renders `aps`, clients route on `cohub`. */
export const buildTurnPushNotification = (input: {
  userUuid: string;
  spaceId: string;
  sessionId: string;
  turnId: string;
  status: TurnPushStatus;
  sessionTitle: string | null | undefined;
  userPreview: string | null | undefined;
  nowMs: number;
}): ApnsNotification => ({
  payload: {
    aps: {
      alert: {
        title: input.sessionTitle?.trim() || input.userPreview?.trim() || "Cohub",
        "loc-key": TURN_PUSH_LOC_KEYS[input.status],
      },
      sound: "default",
      "thread-id": input.sessionId,
    },
    cohub: {
      user: input.userUuid,
      space: input.spaceId,
      session: input.sessionId,
      turn: input.turnId,
      status: input.status,
    },
  },
  collapseId: input.turnId,
  expiresAt: Math.floor(input.nowMs / 1000) + TURN_PUSH_TTL_SECONDS,
});

export type TurnPushDependencies = {
  getClient: () => ApnsClient | null;
  listTargets: (userUuid: string) => Promise<ApnsTarget[]>;
  getSessionTitle: (sessionId: string) => Promise<string | null>;
  now: () => number;
};

let defaultClient: ApnsClient | null | undefined;

const getDefaultClient = () => {
  if (defaultClient !== undefined) return defaultClient;
  const apns = config.apns;
  defaultClient = apns
    ? createApnsClient({
        providerToken: new ApnsProviderToken(apns),
        topics: apns.topics,
        transport: createHttp2ApnsTransport(),
        deleteTarget: deleteRejectedPushTarget,
        logger,
      })
    : null;
  return defaultClient;
};

const defaultDependencies: TurnPushDependencies = {
  getClient: getDefaultClient,
  listTargets: listUserPushTargets,
  getSessionTitle: async (sessionId) => {
    const [row] = await db
      .select({ title: spaceSessions.title })
      .from(spaceSessions)
      .where(eq(spaceSessions.id, sessionId))
      .limit(1);
    return row?.title ?? null;
  },
  now: Date.now,
};

/** Pushes a finished turn to its starter's devices. Callers fire and forget. */
export const sendTurnPush = async (
  input: { spaceId: string; sessionId: string; turn: SessionTurnRecord; userPreview: string | null },
  deps: TurnPushDependencies = defaultDependencies,
) => {
  const { turn } = input;
  if (!turn.userUuid || !isTurnPushStatus(turn.status)) return;
  const client = deps.getClient();
  if (!client) return;
  const targets = await deps.listTargets(turn.userUuid);
  if (targets.length === 0) return;
  const sessionTitle = await deps.getSessionTitle(input.sessionId);
  await client.send(targets, buildTurnPushNotification({
    userUuid: turn.userUuid,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    turnId: turn.id,
    status: turn.status,
    sessionTitle,
    userPreview: input.userPreview,
    nowMs: deps.now(),
  }));
};
