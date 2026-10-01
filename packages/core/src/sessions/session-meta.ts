const normalizeRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? { ...(value as Record<string, unknown>) } : {};

export const inheritSessionMetaForFork = (meta: unknown): Record<string, unknown> => {
  const inherited = normalizeRecord(meta);
  // Creation provenance belongs to the parent; the child has its own session_forks record.
  delete inherited.origin;
  delete inherited.requestSource;
  return inherited;
};

export const MAX_SESSION_TITLE_LENGTH = 255;
export type SessionTitleSource = "fallback" | "generated" | "user";

export const normalizeSessionTitle = (value: string | null | undefined): string | null => {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return Array.from(normalized).slice(0, MAX_SESSION_TITLE_LENGTH).join("");
};

export const readSessionTitleSource = (meta: unknown): SessionTitleSource | null => {
  const title = normalizeRecord(normalizeRecord(meta).title);
  return title.source === "fallback" || title.source === "generated" || title.source === "user"
    ? title.source
    : null;
};

export const canClaimSessionFallbackTitle = (title: string | null, meta: unknown): boolean =>
  !title?.trim() && readSessionTitleSource(meta) !== "user";

export const setSessionTitleMeta = (
  meta: unknown,
  input: {
    source: SessionTitleSource;
    model?: string;
    configRevision?: string;
    generatedAt?: string;
    rawOutput?: string;
    usage?: unknown;
  },
): Record<string, unknown> => {
  const base = normalizeRecord(meta);
  const current = normalizeRecord(base.title);
  return {
    ...base,
    title: {
      ...current,
      source: input.source,
      ...(input.model ? { model: input.model } : {}),
      ...(input.configRevision ? { configRevision: input.configRevision } : {}),
      ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
      ...(input.rawOutput ? { rawOutput: input.rawOutput } : {}),
      ...(input.usage !== undefined ? { usage: input.usage } : {}),
    },
  };
};

export const normalizeUserUuids = (userUuids: Array<string | null | undefined>) => {
  const seen = new Set<string>();
  const values: string[] = [];
  for (const value of userUuids) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    values.push(normalized);
  }
  return values;
};

export const readSessionParticipantUserUuids = (meta: unknown): string[] => {
  const base = normalizeRecord(meta);
  const participants = normalizeRecord(base.participants);
  const userUuids = Array.isArray(participants.userUuids) ? participants.userUuids : [];
  return normalizeUserUuids(userUuids.filter((value): value is string => typeof value === "string"));
};

export const setSessionParticipantsMeta = (
  meta: unknown,
  userUuids: Array<string | null | undefined>,
  now = new Date(),
): Record<string, unknown> => {
  const base = normalizeRecord(meta);
  const participants = normalizeRecord(base.participants);
  return {
    ...base,
    participants: {
      ...participants,
      version: 1,
      userUuids: normalizeUserUuids(userUuids),
      updatedAt: now.toISOString(),
    },
  };
};

export const initializeSessionParticipantsMeta = (
  meta: unknown,
  userUuid: string,
  now = new Date(),
): Record<string, unknown> => setSessionParticipantsMeta(meta, [userUuid], now);

export const addSessionParticipantMeta = (
  meta: unknown,
  userUuid: string | null | undefined,
  now = new Date(),
): Record<string, unknown> => setSessionParticipantsMeta(meta, [...readSessionParticipantUserUuids(meta), userUuid], now);
