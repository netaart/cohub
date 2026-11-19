import { normalizeRequestSource } from "./provenance.js";
import { normalizeSessionTurnOrigin } from "./turn-origin.js";

export const SESSION_SOURCE_KEYS = [
  "web",
  "desktop",
  "mobile",
  "cli",
  "websocket",
  "feishu",
  "wechat",
  "discord",
  "qq",
  "scheduled_task",
  "space_hook",
  "public_api",
  "other",
] as const;

export type SessionSourceKey = (typeof SESSION_SOURCE_KEYS)[number];

export const SESSION_SOURCE_NAMES: Record<SessionSourceKey, string> = {
  web: "Web",
  desktop: "Desktop",
  mobile: "Mobile",
  cli: "CLI",
  websocket: "Websocket",
  feishu: "Feishu",
  wechat: "WeChat",
  discord: "Discord",
  qq: "QQ",
  scheduled_task: "Scheduled Task",
  space_hook: "Hook",
  public_api: "Public API",
  other: "Other",
};

export const APP_SESSION_SOURCES: ReadonlySet<SessionSourceKey> = new Set(["web", "desktop", "mobile"]);

const SOURCE_ALIASES: Readonly<Record<string, SessionSourceKey>> = { web_app: "web" };

const normalizeSourceValue = (value: unknown) =>
  typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") || null : null;

export const isSessionSourceKey = (value: unknown): value is SessionSourceKey =>
  (SESSION_SOURCE_KEYS as readonly unknown[]).includes(value);

const knownSourceKey = (value: string | null | undefined) => {
  const key = value ? (SOURCE_ALIASES[value] ?? value) : null;
  return isSessionSourceKey(key) ? key : null;
};

export function resolveSessionSourceKey(source: unknown): SessionSourceKey {
  const raw = normalizeSourceValue(source) ?? "web";
  const direct = knownSourceKey(raw);
  if (direct) return direct;
  const channel = raw.match(/^channel[:_](.+)$/)?.[1] ?? (raw.includes(":") ? raw.split(":")[0] : null);
  return knownSourceKey(channel) ?? "other";
}

export function sessionSourceForHostPlatform(platform: string | null | undefined): "web" | "desktop" | "mobile" {
  if (platform === "macos" || platform === "windows" || platform === "linux") return "desktop";
  if (platform === "ios" || platform === "android") return "mobile";
  return "web";
}

export const SESSION_INITIATORS = ["human", "agent", "automation"] as const;

export type SessionInitiator = (typeof SESSION_INITIATORS)[number];

export const isSessionInitiator = (value: unknown): value is SessionInitiator =>
  (SESSION_INITIATORS as readonly unknown[]).includes(value);

const AUTOMATION_SOURCES = new Set(["scheduled_task", "space_hook", "public_api", "websocket", "app"]);
const AUTOMATION_CONTEXTS = new Set(["scheduled_task", "space_hook", "background_bash_task"]);
const AUTOMATION_ORIGINS = new Set(["scheduled_prompt", "background_task", "hook"]);

export const SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX = "session-source:";
export const SESSION_INITIATOR_LABEL_SYSTEM_KEY_PREFIX = "session-initiator:";

export const getSessionSourceLabelSystemKey = (key: string) => `${SESSION_SOURCE_LABEL_SYSTEM_KEY_PREFIX}${key}`;
export const getSessionInitiatorLabelSystemKey = (initiator: string) => `${SESSION_INITIATOR_LABEL_SYSTEM_KEY_PREFIX}${initiator}`;

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

function resolveInitiator(source: unknown, meta: Record<string, unknown> | null): SessionInitiator {
  if (isSessionInitiator(meta?.initiator)) return meta.initiator;
  if (meta?.fork) return "human";
  if (meta?.createdBy === "cronjob" || AUTOMATION_CONTEXTS.has(String(record(meta?.context)?.kind))) return "automation";
  const origin = normalizeSessionTurnOrigin(meta?.origin);
  if (origin) return AUTOMATION_ORIGINS.has(origin.kind) ? "automation" : "agent";
  const requestSource = normalizeRequestSource(meta?.requestSource);
  if (requestSource?.turnId || requestSource?.toolCallId) return "agent";
  return AUTOMATION_SOURCES.has(normalizeSourceValue(source) ?? "") ? "automation" : "human";
}

export function readSessionInitiator(session: {
  source?: unknown;
  meta?: unknown;
  initiator?: unknown;
}): SessionInitiator | null {
  if (isSessionInitiator(session.initiator)) return session.initiator;
  return session.meta === undefined ? null : resolveInitiator(session.source, record(session.meta));
}

export function readRecordedTurnInitiator(meta: unknown): SessionInitiator | null {
  const initiator = record(meta)?.initiator;
  return isSessionInitiator(initiator) ? initiator : null;
}

export function readTurnInitiator(meta: unknown): SessionInitiator {
  const input = record(meta);
  return resolveInitiator(input?.source, input);
}
