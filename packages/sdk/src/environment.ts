import { PERMISSIONS, type Permission } from "./types.js";

export type CohubEnvironment = "prod" | "dev";

export type CohubRuntimeKind = "sandbox" | "browser" | "local";

export type CohubExecutionContext = {
  source: string | null;
  actorUserId: string | null;
  viewerUserId: string | null;
  spaceId: string | null;
  sessionId: string | null;
  turnId: string | null;
  toolCallId: string | null;
  sourceClientId: string | null;
  taskRunId: string | null;
  appId: string | null;
  appVersionId: string | null;
  action: string | null;
  scopes: Permission[];
  modelProvider: string | null;
  modelId: string | null;
};

export type CohubContext = {
  runtime: { kind: CohubRuntimeKind };
  execution: CohubExecutionContext | null;
};

export const COHUB_ENVIRONMENTS = {
  prod: {
    apiBaseUrl: "https://api.cohub.live",
    webBaseUrl: "https://cohub.live",
    websocketUrl: "wss://gateway.cohub.live/ws",
    voiceInputWebsocketUrl: "wss://gateway.cohub.live/asr/ws",
  },
  dev: {
    apiBaseUrl: "https://api-dev.cohub.live",
    webBaseUrl: "https://dev.cohub.live",
    websocketUrl: "wss://gateway-dev.cohub.live/ws",
    voiceInputWebsocketUrl: "wss://gateway-dev.cohub.live/asr/ws",
  },
} as const satisfies Record<CohubEnvironment, { apiBaseUrl: string; webBaseUrl: string; websocketUrl: string; voiceInputWebsocketUrl: string }>;

const readProcessEnv = (): Record<string, string | undefined> | undefined => {
  const runtime = globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  };
  return runtime.process?.env;
};

const readRuntimeEnv = (): string | undefined => readProcessEnv()?.ENV;

/** Existing scoped identity injected into Sandbox command processes. */
export const resolveExecutionToken = (): string | null =>
  readProcessEnv()?.COHUB_EXECUTION_TOKEN?.trim() || null;

function decodeExecutionPayload(): Record<string, unknown> | null {
  const encoded = resolveExecutionToken()?.split(".")[1];
  if (!encoded) return null;
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const decoded = JSON.parse(globalThis.atob(base64)) as unknown;
    return decoded && typeof decoded === "object" ? decoded as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const readString = (env: Record<string, string | undefined> | undefined, key: string) =>
  env?.[key]?.trim() || null;

const readPayloadString = (payload: Record<string, unknown> | null, key: string) =>
  typeof payload?.[key] === "string" && payload[key] ? payload[key] as string : null;

const KNOWN_PERMISSIONS = new Set<string>(PERMISSIONS);

const readScopes = (payload: Record<string, unknown> | null): Permission[] =>
  Array.isArray(payload?.scopes)
    ? payload.scopes.filter((scope): scope is Permission => typeof scope === "string" && KNOWN_PERMISSIONS.has(scope))
    : [];

export function getCohubContext(): CohubContext {
  const env = readProcessEnv();
  const token = resolveExecutionToken();
  const isBrowser = typeof window !== "undefined" && typeof document !== "undefined";
  const runtime = token ? "sandbox" : isBrowser ? "browser" : "local";
  const payload = decodeExecutionPayload();

  if (!token && runtime !== "sandbox") {
    return { runtime: { kind: runtime }, execution: null };
  }

  return {
    runtime: { kind: runtime },
    execution: {
      source: readPayloadString(payload, "source"),
      actorUserId: readString(env, "COHUB_USER_UUID") ?? readPayloadString(payload, "actorUserId"),
      viewerUserId: readPayloadString(payload, "viewerUserId"),
      spaceId: readString(env, "COHUB_SPACE_ID") ?? readPayloadString(payload, "spaceId"),
      sessionId: readString(env, "COHUB_SESSION_ID") ?? readPayloadString(payload, "sessionId"),
      turnId: readString(env, "COHUB_TURN_ID") ?? readPayloadString(payload, "turnId"),
      toolCallId: readString(env, "COHUB_TOOL_CALL_ID"),
      sourceClientId: readString(env, "COHUB_SOURCE_CLIENT_ID"),
      taskRunId: readPayloadString(payload, "taskRunId"),
      appId: readPayloadString(payload, "appId"),
      appVersionId: readPayloadString(payload, "appVersionId"),
      action: readPayloadString(payload, "action"),
      scopes: readScopes(payload),
      modelProvider: readString(env, "COHUB_MODEL_PROVIDER"),
      modelId: readString(env, "COHUB_MODEL_ID"),
    },
  };
}

export function resolveExecutionAppId(): string | null {
  return readPayloadString(decodeExecutionPayload(), "appId");
}

export const resolveCohubEnvironment = (env?: CohubEnvironment): CohubEnvironment => {
  if (env) return env;
  return readRuntimeEnv() === "dev" ? "dev" : "prod";
};

export const normalizeBaseUrl = (url: string) => url.trim().replace(/\/+$/, "");

const normalizeWebsocketPath = (input: string, path: string, replacePaths: string[] = []) => {
  let withProtocol = normalizeBaseUrl(input)
    .replace(/^http:/, "ws:")
    .replace(/^https:/, "wss:");
  for (const replacePath of replacePaths) {
    if (withProtocol.endsWith(replacePath)) {
      withProtocol = withProtocol.slice(0, -replacePath.length);
      break;
    }
  }
  return withProtocol.endsWith(path) ? withProtocol : `${withProtocol}${path}`;
};

export const normalizeWebsocketUrl = (input: string) => normalizeWebsocketPath(input, "/ws", ["/asr/ws"]);

export const normalizeVoiceInputWebsocketUrl = (input: string) =>
  normalizeWebsocketPath(input, "/asr/ws", ["/ws"]);

export const resolveApiBaseUrl = (options: {
  baseUrl?: string;
  env?: CohubEnvironment;
} = {}) => {
  const baseUrl = options.baseUrl?.trim() || readProcessEnv()?.COHUB_BASE_URL?.trim();
  if (baseUrl) return normalizeBaseUrl(baseUrl);
  return COHUB_ENVIRONMENTS[resolveCohubEnvironment(options.env)].apiBaseUrl;
};

export const resolveWebBaseUrl = (options: { url?: string; env?: CohubEnvironment } = {}) => {
  const url = options.url?.trim() || readProcessEnv()?.COHUB_WEB_URL?.trim();
  if (url) return normalizeBaseUrl(url);
  return COHUB_ENVIRONMENTS[resolveCohubEnvironment(options.env)].webBaseUrl;
};

export const resolveWebsocketUrl = (options: {
  url?: string;
  env?: CohubEnvironment;
} = {}) => {
  const url = options.url?.trim() || readProcessEnv()?.COHUB_WS_URL?.trim();
  if (url) return normalizeWebsocketUrl(url);
  return COHUB_ENVIRONMENTS[resolveCohubEnvironment(options.env)].websocketUrl;
};

export const resolveVoiceInputWebsocketUrl = (options: {
  url?: string;
  env?: CohubEnvironment;
} = {}) => {
  const env = readProcessEnv();
  const url = options.url?.trim() || env?.COHUB_VOICE_WS_URL?.trim() || env?.COHUB_WS_URL?.trim();
  if (url) return normalizeVoiceInputWebsocketUrl(url);
  return COHUB_ENVIRONMENTS[resolveCohubEnvironment(options.env)].voiceInputWebsocketUrl;
};
