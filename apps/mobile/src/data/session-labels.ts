import type { CohubClient, LabelAssignmentRecord, LabelListItem } from "@neta-art/cohub";

export const SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX = "session-source:";
export const WEB_APP_SOURCE_LABEL_SYSTEM_KEY = `${SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX}web`;

export type SessionLabel = {
  id: string;
  name: string;
  systemKey: string | null;
  /** true for server-owned taxonomy labels (Source → Web App, User root, …). */
  system: boolean;
};

/** Labels that are session taxonomy (Source tree) rather than user organization. */
export function isSystemSessionLabel(label: LabelListItem) {
  if (label.source === "system") return true;
  const key = label.systemKey?.trim();
  return Boolean(key && key.startsWith(SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX));
}

export function isWebAppSourceLabel(label: LabelListItem) {
  return label.systemKey === WEB_APP_SOURCE_LABEL_SYSTEM_KEY || label.name === "Web App";
}

export function toSessionLabel(label: LabelListItem): SessionLabel {
  return { id: label.id, name: label.name, systemKey: label.systemKey ?? null, system: isSystemSessionLabel(label) };
}

/** Flat user-facing labels (excluding system taxonomy and stray children of system roots). */
export function toUserSessionLabels(labels: LabelListItem[]): SessionLabel[] {
  return labels
    .filter((label) => !isSystemSessionLabel(label))
    .map(toSessionLabel)
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** Source taxonomy labels (Web App etc.), sorted Web App first like the web sidebar. */
export function toSourceSessionLabels(labels: LabelListItem[]): SessionLabel[] {
  const sourceRoot = labels.find(
    (label) => label.source === "system" && label.parentId === null && label.name.toLowerCase() === "source",
  );
  return (sourceRoot?.children ?? [])
    .slice()
    .sort((left, right) => {
      const leftWeb = isWebAppSourceLabel(left);
      const rightWeb = isWebAppSourceLabel(right);
      if (leftWeb !== rightWeb) return leftWeb ? -1 : 1;
      if (left.rank !== right.rank) return left.rank - right.rank;
      return left.name.localeCompare(right.name);
    })
    .map(toSessionLabel);
}

export async function fetchSessionLabels(client: CohubClient, spaceId: string): Promise<LabelListItem[]> {
  const result = await client.space(spaceId).labels.list();
  return result.labels;
}

export async function fetchSessionLabelAssignments(
  client: CohubClient,
  spaceId: string,
  sessionId: string,
): Promise<LabelAssignmentRecord[]> {
  const result = await client.space(spaceId).labels.getResourceLabels("session", sessionId);
  return result.assignments;
}

export async function attachSessionLabel(client: CohubClient, spaceId: string, labelRef: string, sessionId: string) {
  await client.space(spaceId).labels.attach(labelRef, { resourceType: "session", resourceRef: sessionId });
}

export async function detachSessionLabel(client: CohubClient, spaceId: string, labelRef: string, sessionId: string) {
  await client.space(spaceId).labels.detach(labelRef, { resourceType: "session", resourceRef: sessionId });
}

export async function createSessionLabel(client: CohubClient, spaceId: string, name: string): Promise<SessionLabel | null> {
  const result = await client.space(spaceId).labels.create(name);
  const created = result.labels[0];
  return created ? toSessionLabel(created) : null;
}

export async function fetchLabelSessionIds(
  client: CohubClient,
  spaceId: string,
  labelRef: string,
  options: { limit?: number } = {},
): Promise<string[]> {
  const result = await client.space(spaceId).labels.listItems(labelRef, { limit: options.limit ?? 100 });
  const refSet = new Set(result.items.map((item) => item.resourceRef).filter(Boolean));
  for (const session of result.sessions ?? []) refSet.add(session.id);
  return [...refSet];
}

export function formatLabelRef(label: { name: string; id?: string }) {
  const name = label.name.trim();
  return name || label.id || "";
}
