import type { UserSessionSourceKey } from "@neta-art/cohub";

/**
 * Chats source filter. Mirrors the Space panel taxonomy: first-party app sessions
 * are submitted with source `web`, so every other server source key groups as `other`.
 */
export type SessionSourceFilter = "all" | "web" | "other";

/** Every `GET /api/me/sessions` source key except `web`. */
const OTHER_SESSION_SOURCE_KEYS = [
  "public_api",
  "scheduled_task",
  "space_hook",
  "websocket",
  "cli",
  "feishu",
  "wechat",
  "discord",
  "qq",
  "other",
] as const satisfies readonly UserSessionSourceKey[];

/** `null` selects the unfiltered Chats list (no `source` query). */
export function sessionSourceFilterKeys(filter: SessionSourceFilter): readonly UserSessionSourceKey[] | null {
  if (filter === "all") return null;
  return filter === "web" ? ["web"] : OTHER_SESSION_SOURCE_KEYS;
}
