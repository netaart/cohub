import { eq, inArray } from "drizzle-orm";
import { sessionTurns, spaces, spaceSessions, userProfiles } from "@cohub/db";
import type { NotificationTurnJobData } from "@cohub/protocol";
import type { ContentBlock } from "@cohub/protocol/core";
import { readRecordedTurnInitiator } from "@cohub/protocol/model";
import { createDrizzlePermissionStore, hasPermission } from "../permissions/index.js";
import { formatMentionsForDisplay, parseMentions } from "../references/mentions.js";
import type { NotificationDb, NotifyItem } from "./store.js";

const PREVIEW_LENGTH = 180;
const MAX_MENTIONS = 20;

const preview = (text: string | null | undefined) => {
  const value = formatMentionsForDisplay(text ?? "").replace(/\s+/g, " ").trim();
  if (!value) return null;
  return value.length > PREVIEW_LENGTH ? `${value.slice(0, PREVIEW_LENGTH - 1)}…` : value;
};

const contentText = (content: ContentBlock[]) =>
  content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

async function loadTurn(db: NotificationDb, turnId: string) {
  const [row] = await db.select({
    id: sessionTurns.id,
    sessionId: sessionTurns.sessionId,
    spaceId: spaceSessions.spaceId,
    userUuid: sessionTurns.userUuid,
    status: sessionTurns.status,
    executionKind: sessionTurns.executionKind,
    userContent: sessionTurns.userContent,
    userText: sessionTurns.userText,
    durationMs: sessionTurns.durationMs,
    intermediateSummary: sessionTurns.intermediateSummary,
    meta: sessionTurns.meta,
    sessionTitle: spaceSessions.title,
    spaceTitle: spaces.name,
  })
    .from(sessionTurns)
    .innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .innerJoin(spaces, eq(spaces.id, spaceSessions.spaceId))
    .where(eq(sessionTurns.id, turnId))
    .limit(1);
  return row ?? null;
}

type LoadedTurn = NonNullable<Awaited<ReturnType<typeof loadTurn>>>;

const canViewSession = (db: NotificationDb, userUuid: string, turn: LoadedTurn) =>
  hasPermission({
    store: createDrizzlePermissionStore(db),
    user: { uuid: userUuid },
    permission: "session.view",
    context: { spaceId: turn.spaceId, sessionId: turn.sessionId },
  });

async function turnFinished(db: NotificationDb, turn: LoadedTurn): Promise<NotifyItem[]> {
  if (!turn.userUuid || turn.executionKind === "note") return [];
  if (turn.status !== "completed" && turn.status !== "failed") return [];
  const initiator = readRecordedTurnInitiator(turn.meta);
  if (turn.status === "completed" && (initiator === "agent" || initiator === "automation")) return [];
  if (!(await canViewSession(db, turn.userUuid, turn))) return [];
  return [{
    recipientId: turn.userUuid,
    kind: "turn.finished",
    groupKey: `turn:${turn.sessionId}`,
    spaceId: turn.spaceId,
    sessionId: turn.sessionId,
    turnId: turn.id,
    payload: {
      spaceTitle: turn.spaceTitle,
      sessionTitle: turn.sessionTitle,
      preview: preview(turn.userText),
      status: turn.status,
      durationMs: turn.durationMs,
      stepCount: turn.intermediateSummary?.messageCount ?? null,
    },
  }];
}

async function userMentions(db: NotificationDb, turn: LoadedTurn): Promise<NotifyItem[]> {
  const author = turn.userUuid;
  const candidates = [...new Set(parseMentions(contentText(turn.userContent)).flatMap((mention) =>
    mention.type === "user" && mention.userUuid !== author ? [mention.userUuid] : []))].slice(0, MAX_MENTIONS);
  if (candidates.length === 0) return [];
  const known = await db.select({ userUuid: userProfiles.userUuid }).from(userProfiles).where(inArray(userProfiles.userUuid, candidates));
  const allowed = await Promise.all(known.map(async ({ userUuid }) => (await canViewSession(db, userUuid, turn) ? userUuid : null)));
  return allowed.flatMap((recipientId) => recipientId
    ? [{
      recipientId,
      kind: "mention.user" as const,
      groupKey: `mention:${turn.id}`,
      spaceId: turn.spaceId,
      sessionId: turn.sessionId,
      turnId: turn.id,
      actorId: author,
      payload: { spaceTitle: turn.spaceTitle, sessionTitle: turn.sessionTitle, preview: preview(turn.userText) },
    }]
    : []);
}

export async function turnNotifications(db: NotificationDb, job: Pick<NotificationTurnJobData, "turnId" | "event">): Promise<NotifyItem[]> {
  const turn = await loadTurn(db, job.turnId);
  if (!turn) return [];
  return job.event === "settled" ? turnFinished(db, turn) : userMentions(db, turn);
}
