import {
  getSessionInitiatorLabelSystemKey,
  getSessionSourceLabelSystemKey,
  readSessionInitiator,
  resolveSessionSourceKey,
  SESSION_INITIATOR_LABEL_SYSTEM_KEY_PREFIX,
  SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX,
  SESSION_SOURCE_NAMES,
  type SessionInitiator,
  type SessionSourceKey,
} from "@cohub/protocol/model";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { assignLabelsToSession } from "./index.js";
import { getOrCreateSpaceSystemLabel } from "./system-label.js";

type LabelsDb = PostgresJsDatabase<Record<string, unknown>>;

export {
  getSessionInitiatorLabelSystemKey,
  getSessionSourceLabelSystemKey,
  SESSION_INITIATOR_LABEL_SYSTEM_KEY_PREFIX,
  SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX,
};
export const SESSION_SOURCE_ROOT_LABEL_SYSTEM_KEY = getSessionSourceLabelSystemKey("root");
export const SESSION_INITIATOR_ROOT_LABEL_SYSTEM_KEY = getSessionInitiatorLabelSystemKey("root");

const INITIATOR_LABEL_NAMES: Record<SessionInitiator, string> = {
  human: "Human",
  agent: "Agent",
  automation: "Automation",
};

type SessionSystemLabel = { rootName: string; rootKey: string; name: string; key: string };

const sourceLabel = (key: SessionSourceKey): SessionSystemLabel => ({
  rootName: "Source",
  rootKey: SESSION_SOURCE_ROOT_LABEL_SYSTEM_KEY,
  name: SESSION_SOURCE_NAMES[key],
  key: getSessionSourceLabelSystemKey(key),
});

const initiatorLabel = (initiator: SessionInitiator): SessionSystemLabel => ({
  rootName: "Initiator",
  rootKey: SESSION_INITIATOR_ROOT_LABEL_SYSTEM_KEY,
  name: INITIATOR_LABEL_NAMES[initiator],
  key: getSessionInitiatorLabelSystemKey(initiator),
});

const LEGACY_SOURCE_LABEL_NAMES: Record<string, SessionSourceKey> = { "Web App": "web" };

export function resolveKnownSessionSourceLabelSystemKey(labelRef: string) {
  const name = labelRef.startsWith("Source/") ? labelRef.slice("Source/".length) : null;
  if (!name) return null;
  const key = LEGACY_SOURCE_LABEL_NAMES[name]
    ?? (Object.keys(SESSION_SOURCE_NAMES) as SessionSourceKey[]).find((candidate) => SESSION_SOURCE_NAMES[candidate] === name);
  return key && key !== "other" ? getSessionSourceLabelSystemKey(key) : null;
}

export function resolveSessionSourceLabelKey(input: { source?: string | null; provider?: string | null }): SessionSourceKey {
  const fromProvider = input.provider?.trim() ? resolveSessionSourceKey(input.provider) : "other";
  if (fromProvider !== "other") return fromProvider;
  return input.source?.trim() ? resolveSessionSourceKey(input.source) : "other";
}

async function resolveSystemLabelId(db: LabelsDb, spaceId: string, label: SessionSystemLabel) {
  const root = await getOrCreateSpaceSystemLabel(db, { spaceId, name: label.rootName, parentId: null, depth: 0, systemKey: label.rootKey });
  const child = await getOrCreateSpaceSystemLabel(db, { spaceId, name: label.name, parentId: root.id, depth: 1, systemKey: label.key });
  return child.id;
}

async function assignSessionSystemLabels(db: LabelsDb, spaceId: string, sessionId: string, labels: SessionSystemLabel[]) {
  const labelIds = await Promise.all(labels.map((label) => resolveSystemLabelId(db, spaceId, label)));
  await assignLabelsToSession({ db, spaceId, sessionId, labelIds, userId: null, source: "system" });
}

export async function assignSessionAttributionLabels(input: {
  db: LabelsDb;
  spaceId: string;
  session: { id: string; source: string | null; meta: unknown };
  provider?: string | null;
}) {
  await assignSessionSystemLabels(input.db, input.spaceId, input.session.id, [
    sourceLabel(resolveSessionSourceLabelKey({ source: input.session.source, provider: input.provider })),
    initiatorLabel(readSessionInitiator(input.session) ?? "human"),
  ]);
}

export async function assignSessionInitiatorLabel(input: {
  db: LabelsDb;
  spaceId: string;
  sessionId: string;
  initiator: SessionInitiator;
}) {
  await assignSessionSystemLabels(input.db, input.spaceId, input.sessionId, [initiatorLabel(input.initiator)]);
}

export async function resolveSessionInitiatorLabelId(db: LabelsDb, spaceId: string, initiator: SessionInitiator) {
  return resolveSystemLabelId(db, spaceId, initiatorLabel(initiator));
}
