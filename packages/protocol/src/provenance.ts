import { isUuidLike } from "./identifiers.js";

/** Request provenance via X-Cohub-Source-* headers. Never used for authorization. */

export const COHUB_SOURCE_HEADER = {
  space: "X-Cohub-Source-Space",
  session: "X-Cohub-Source-Session",
  turn: "X-Cohub-Source-Turn",
  toolCall: "X-Cohub-Source-Tool-Call",
  client: "X-Cohub-Source-Client",
  sandboxVersion: "X-Cohub-Source-Sandbox",
  via: "X-Cohub-Source-Via",
} as const;

export type CohubSourceHeaderName =
  (typeof COHUB_SOURCE_HEADER)[keyof typeof COHUB_SOURCE_HEADER];

export type RequestSourceVia = "cli" | "bash" | "tool" | "api" | "web" | (string & {});

/** Caller context: via (channel) and optional identity fields. */
export type RequestSource = {
  spaceId?: string;
  sessionId?: string;
  turnId?: string;
  toolCallId?: string;
  /**
   * Logical id of the frontend instance that originated this chain of work.
   * Survives reloads and WebSocket reconnects, and is distinct per browser tab.
   * Used to route UI commands back to the originating client. Routing hint only
   * — never an authorization input.
   */
  clientId?: string;
  /** Untrusted provenance hint derived from the Sandbox runtime environment. */
  sandboxVersion?: string;
  via?: RequestSourceVia;
};

export const isRequestSourceUuid = (value: unknown): value is string =>
  isUuidLike(value);

export const REQUEST_SOURCE_VIA_MAX_LENGTH = 64;

/** Opaque, url-safe client instance id. */
const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const isRequestSourceClientId = (value: unknown): value is string =>
  typeof value === "string" && CLIENT_ID_RE.test(value);

/** Remove C0 controls and DEL without a control-char regex (biome-friendly). */
export const stripControlChars = (value: string): string => {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 32 && code !== 127) out += value[i];
  }
  return out;
};

const asNonEmpty = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = stripControlChars(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asUuid = (value: unknown): string | undefined => {
  const trimmed = asNonEmpty(value);
  return trimmed && isRequestSourceUuid(trimmed) ? trimmed : undefined;
};

const asVia = (value: unknown): string | undefined => {
  const cleaned = asNonEmpty(value);
  if (!cleaned) return undefined;
  return cleaned.slice(0, REQUEST_SOURCE_VIA_MAX_LENGTH);
};

const asClientId = (value: unknown): string | undefined => {
  const cleaned = asNonEmpty(value);
  return cleaned && isRequestSourceClientId(cleaned) ? cleaned : undefined;
};

export const SANDBOX_VERSION_MAX_LENGTH = 128;

const asSandboxVersion = (value: unknown): string | undefined =>
  asNonEmpty(value)?.slice(0, SANDBOX_VERSION_MAX_LENGTH);

export const isRequestSourceEmpty = (
  source: RequestSource | null | undefined,
): boolean => {
  if (!source) return true;
  return (
    !source.spaceId &&
    !source.sessionId &&
    !source.turnId &&
    !source.toolCallId &&
    !source.clientId &&
    !source.sandboxVersion &&
    !source.via
  );
};

export const hasRequestSourceIdentity = (
  source: RequestSource | null | undefined,
): boolean => {
  if (!source) return false;
  return Boolean(
    source.spaceId || source.sessionId || source.turnId || source.toolCallId || source.clientId,
  );
};

/** Drop invalid UUIDs; via-only is valid. */
export const normalizeRequestSource = (
  input: unknown,
): RequestSource | null => {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const spaceId = asUuid(record.spaceId);
  const sessionId = asUuid(record.sessionId);
  const turnId = asUuid(record.turnId);
  // Harness tool-call ids are opaque (e.g. call_*, toolu_*), not necessarily UUIDs.
  const toolCallId = asNonEmpty(record.toolCallId);
  const validToolCallId = toolCallId && toolCallId.length <= 255 ? toolCallId : undefined;
  const clientId = asClientId(record.clientId);
  const sandboxVersion = asSandboxVersion(record.sandboxVersion);
  const via = asVia(record.via);
  const source: RequestSource = {
    ...(spaceId ? { spaceId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(validToolCallId ? { toolCallId: validToolCallId } : {}),
    ...(clientId ? { clientId } : {}),
    ...(sandboxVersion ? { sandboxVersion } : {}),
    ...(via ? { via } : {}),
  };
  return isRequestSourceEmpty(source) ? null : source;
};

export const parseRequestSourceFromHeaders = (
  getHeader: (name: string) => string | null | undefined,
): RequestSource | null =>
  normalizeRequestSource({
    spaceId: getHeader(COHUB_SOURCE_HEADER.space),
    sessionId: getHeader(COHUB_SOURCE_HEADER.session),
    turnId: getHeader(COHUB_SOURCE_HEADER.turn),
    toolCallId: getHeader(COHUB_SOURCE_HEADER.toolCall),
    clientId: getHeader(COHUB_SOURCE_HEADER.client),
    sandboxVersion: getHeader(COHUB_SOURCE_HEADER.sandboxVersion),
    via: getHeader(COHUB_SOURCE_HEADER.via),
  });

export const requestSourceToHeaders = (
  source: RequestSource | null | undefined,
): Record<string, string> => {
  const normalized = normalizeRequestSource(source);
  if (!normalized) return {};
  const headers: Record<string, string> = {};
  if (normalized.spaceId) headers[COHUB_SOURCE_HEADER.space] = normalized.spaceId;
  if (normalized.sessionId) headers[COHUB_SOURCE_HEADER.session] = normalized.sessionId;
  if (normalized.turnId) headers[COHUB_SOURCE_HEADER.turn] = normalized.turnId;
  if (normalized.toolCallId) headers[COHUB_SOURCE_HEADER.toolCall] = normalized.toolCallId;
  if (normalized.clientId) headers[COHUB_SOURCE_HEADER.client] = normalized.clientId;
  if (normalized.sandboxVersion) {
    headers[COHUB_SOURCE_HEADER.sandboxVersion] = normalized.sandboxVersion;
  }
  if (normalized.via) headers[COHUB_SOURCE_HEADER.via] = normalized.via;
  return headers;
};

/** Read COHUB_* env into a RequestSource. */
export const readRequestSourceFromEnv = (
  env: Record<string, string | undefined> = {},
  defaults?: { via?: RequestSourceVia },
): RequestSource | null =>
  normalizeRequestSource({
    spaceId: env.COHUB_SPACE_ID,
    sessionId: env.COHUB_SESSION_ID,
    turnId: env.COHUB_TURN_ID,
    toolCallId: env.COHUB_TOOL_CALL_ID,
    clientId: env.COHUB_SOURCE_CLIENT_ID,
    sandboxVersion: asNonEmpty(env.COHUB_SANDBOX_VERSION) ?? env.IMAGE_VERSION,
    via: env.COHUB_SOURCE_VIA ?? defaults?.via,
  });

export const resolveRequestSourceChannel = (
  source: RequestSource | null | undefined,
  fallback = "public_api",
): string => {
  const via = asVia(source?.via);
  if (via) return via;
  return asVia(fallback) ?? "public_api";
};

/** Put identity under meta.source; strip body source. Via-only is skipped. */
export const mergeRequestSourceIntoMeta = (
  meta: Record<string, unknown> | null | undefined,
  headerSource: RequestSource | null | undefined,
): Record<string, unknown> | null => {
  const fromHeader = normalizeRequestSource(headerSource);
  const identity =
    fromHeader && hasRequestSourceIdentity(fromHeader) ? fromHeader : null;

  if (!identity) {
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) return meta ?? null;
    if (!("source" in meta)) return meta;
    const { source: _drop, ...rest } = meta;
    return Object.keys(rest).length > 0 ? rest : null;
  }

  const base =
    meta && typeof meta === "object" && !Array.isArray(meta) ? { ...meta } : {};
  delete base.source;
  return { ...base, source: identity };
};

export const COHUB_SOURCE_HEADER_NAMES: readonly string[] = Object.values(COHUB_SOURCE_HEADER);
