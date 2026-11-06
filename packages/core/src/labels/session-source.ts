import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { assignLabelsToSession } from "./index.js";
import { getOrCreateSpaceSystemLabel } from "./system-label.js";

type LabelsDb = PostgresJsDatabase<Record<string, unknown>>;

export type SessionSourceLabelInput = {
  source?: string | null;
  provider?: string | null;
};

type SourceLabelDefinition = {
  key: string;
  ref: string;
};

const ROOT_LABEL_NAME = "Source";

const SOURCE_LABELS: Record<string, string> = {
  public_api: "Source/Public API",
  scheduled_task: "Source/Scheduled Task",
  space_hook: "Source/Hook",
  web: "Source/Web App",
  web_app: "Source/Web App",
  websocket: "Source/Websocket",
  cli: "Source/CLI",
  feishu: "Source/Feishu",
  wechat: "Source/WeChat",
  discord: "Source/Discord",
  qq: "Source/QQ",
};

const normalizeKey = (value: string | null | undefined) => value?.trim().toLowerCase().replace(/[\s-]+/g, "_") || null;

const SOURCE_LABEL_REF_TO_KEY = new Map<string, string>();
for (const [key, ref] of Object.entries(SOURCE_LABELS)) {
  if (!SOURCE_LABEL_REF_TO_KEY.has(ref)) SOURCE_LABEL_REF_TO_KEY.set(ref, key);
}

export const SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX = "session-source:";
export const SESSION_SOURCE_ROOT_LABEL_SYSTEM_KEY = `${SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX}root`;

export function getSessionSourceLabelSystemKey(sourceKey: string) {
  return `${SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX}${sourceKey}`;
}

export function resolveKnownSessionSourceLabelSystemKey(labelRef: string) {
  const sourceKey = SOURCE_LABEL_REF_TO_KEY.get(labelRef);
  return sourceKey ? getSessionSourceLabelSystemKey(sourceKey) : null;
}

export function resolveSessionSourceLabelSystemKey(labelRef: string) {
  return resolveKnownSessionSourceLabelSystemKey(labelRef) ?? getSessionSourceLabelSystemKey("other");
}

/**
 * Stable key for a raw `space_sessions.source` value, used both by the source
 * labels above and by cross-space session filtering. A null source means a
 * legacy web chat, matching the historical client-side default. Aliases that
 * share a label (`web` / `web_app`) collapse to the first key in the table.
 */
export function resolveSessionSourceKey(source: string | null | undefined): string {
  const sourceKey = normalizeKey(source) ?? "web";
  const direct = SOURCE_LABEL_REF_TO_KEY.get(SOURCE_LABELS[sourceKey] ?? "");
  if (direct) return direct;
  const channelPrefixMatch = sourceKey.match(/^channel[:_](.+)$/);
  const channelKey = channelPrefixMatch?.[1] ?? (sourceKey.includes(":") ? sourceKey.split(":")[0] : null);
  const channelRef = channelKey ? SOURCE_LABELS[channelKey] : undefined;
  return (channelRef && SOURCE_LABEL_REF_TO_KEY.get(channelRef)) || "other";
}

/** Selectable kinds, vocabulary order with `other` last. */
export const SESSION_SOURCE_KEYS: readonly string[] = [
  ...new Set(Object.keys(SOURCE_LABELS).map(resolveSessionSourceKey)),
  "other",
];

export function resolveSessionSourceLabelRef(input: SessionSourceLabelInput): string {
  const providerKey = normalizeKey(input.provider);
  if (providerKey && SOURCE_LABELS[providerKey]) return SOURCE_LABELS[providerKey];

  const sourceKey = normalizeKey(input.source);
  if (!sourceKey) return "Source/Other";
  if (SOURCE_LABELS[sourceKey]) return SOURCE_LABELS[sourceKey];

  const channelPrefixMatch = sourceKey.match(/^channel[:_](.+)$/);
  const channelKey = channelPrefixMatch?.[1] ?? (sourceKey.includes(":") ? sourceKey.split(":")[0] : null);
  if (channelKey && SOURCE_LABELS[channelKey]) return SOURCE_LABELS[channelKey];

  return "Source/Other";
}

function resolveSessionSourceLabelDefinition(input: SessionSourceLabelInput): SourceLabelDefinition {
  const labelRef = resolveSessionSourceLabelRef(input);
  const key = SOURCE_LABEL_REF_TO_KEY.get(labelRef) ?? "other";
  return { key, ref: labelRef };
}

export async function assignSessionSourceSystemLabel(input: {
  db: LabelsDb;
  spaceId: string;
  sessionId: string;
  source?: string | null;
  provider?: string | null;
}) {
  const labelDefinition = resolveSessionSourceLabelDefinition({ source: input.source, provider: input.provider });
  const [, childName] = labelDefinition.ref.split("/") as [string, string];
  const rootLabel = await getOrCreateSpaceSystemLabel(input.db, {
    spaceId: input.spaceId,
    name: ROOT_LABEL_NAME,
    parentId: null,
    depth: 0,
    systemKey: SESSION_SOURCE_ROOT_LABEL_SYSTEM_KEY,
  });
  const childLabel = await getOrCreateSpaceSystemLabel(input.db, {
    spaceId: input.spaceId,
    name: childName,
    parentId: rootLabel.id,
    depth: 1,
    systemKey: getSessionSourceLabelSystemKey(labelDefinition.key),
  });
  await assignLabelsToSession({
    db: input.db,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    labelIds: [childLabel.id],
    userId: null,
    source: "system",
  });
}
