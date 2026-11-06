import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { labelAssignments } from "@cohub/db";
import { getOrCreateSpaceSystemLabel } from "./system-label.js";

export type SessionChannelLabelInput = {
  db: PostgresJsDatabase<Record<string, unknown>>;
  spaceId: string;
  sessionId: string;
  channelId: string;
  spaceChannelId?: string | null;
  provider?: string | null;
  userId?: string | null;
};

const SCOPE_TYPE = "space";
const ROOT_LABEL_NAME = "Channel";
const MAX_LABEL_NAME_LENGTH = 80;

export const SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX = "session-channel:";
export const SESSION_CHANNEL_ROOT_LABEL_SYSTEM_KEY = `${SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX}root`;

export const getSessionChannelLabelSystemKey = (channelId: string) =>
  `${SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX}${channelId}`;

export const parseSessionChannelLabelSystemKey = (systemKey: string | null | undefined) => {
  if (!systemKey?.startsWith(SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX)) return null;
  const channelId = systemKey.slice(SESSION_CHANNEL_LABEL_SYSTEM_KEY_PREFIX.length).trim();
  return channelId && channelId !== "root" ? channelId : null;
};

const normalizeChannelId = (channelId: string | null | undefined) => {
  const normalized = channelId?.trim();
  if (!normalized || normalized.length > MAX_LABEL_NAME_LENGTH || normalized.includes("/")) return null;
  return normalized;
};

export async function assignSessionChannelSystemLabel(input: SessionChannelLabelInput) {
  const channelId = normalizeChannelId(input.channelId);
  if (!channelId) return null;

  const rootLabel = await getOrCreateSpaceSystemLabel(input.db, {
    spaceId: input.spaceId,
    name: ROOT_LABEL_NAME,
    parentId: null,
    depth: 0,
    systemKey: SESSION_CHANNEL_ROOT_LABEL_SYSTEM_KEY,
    userId: input.userId ?? null,
  });

  const childLabel = await getOrCreateSpaceSystemLabel(input.db, {
    spaceId: input.spaceId,
    name: channelId,
    parentId: rootLabel.id,
    depth: 1,
    systemKey: getSessionChannelLabelSystemKey(channelId),
    userId: input.userId ?? null,
  });

  const existingAssignment = await input.db
    .select({ labelId: labelAssignments.labelId })
    .from(labelAssignments)
    .where(and(
      eq(labelAssignments.scopeType, SCOPE_TYPE),
      eq(labelAssignments.scopeId, input.spaceId),
      eq(labelAssignments.resourceType, "session"),
      eq(labelAssignments.resourceRef, input.sessionId),
      eq(labelAssignments.labelId, childLabel.id),
    ))
    .limit(1);

  if (existingAssignment.length === 0) {
    await input.db.insert(labelAssignments).values({
      labelId: childLabel.id,
      scopeType: SCOPE_TYPE,
      scopeId: input.spaceId,
      resourceType: "session",
      resourceRef: input.sessionId,
      rank: null,
      source: "system",
      createdBy: input.userId ?? null,
      meta: {
        kind: "session_channel",
        channelId,
        spaceChannelId: input.spaceChannelId ?? null,
        provider: input.provider?.trim() || null,
      },
    }).onConflictDoNothing();
  }

  return childLabel.id;
}
