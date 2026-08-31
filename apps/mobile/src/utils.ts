import type { ContentBlock, MessageRecord, SessionRecord, SpaceRecord } from "@neta-art/cohub";
import * as Crypto from "expo-crypto";

export function newId() {
  return Crypto.randomUUID();
}

export function displaySpaceName(space: Pick<SpaceRecord, "name" | "title"> | null | undefined) {
  return space?.name?.trim() || space?.title?.trim() || "Space";
}

export function displaySessionTitle(session: Pick<SessionRecord, "title" | "latestMessageText">) {
  return session.title?.trim() || session.latestMessageText?.trim().split("\n")[0]?.slice(0, 64) || "Untitled conversation";
}

export function initials(value: string) {
  const words = value.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "C";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return `${words[0]![0]}${words[words.length - 1]![0]}`.toUpperCase();
}

export function formatRelativeTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const delta = Date.now() - date.getTime();
  if (delta < 60_000) return "now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d`;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function formatNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function isRunningStatus(value: string | null | undefined) {
  return value === "running" || value === "in_progress" || value === "pending" || value === "abort_requested";
}

export function isNeedsAttentionStatus(value: string | null | undefined) {
  return value === "failed" || value === "error" || value === "needs_input" || value === "waiting";
}

export function contentBlockText(block: ContentBlock | Record<string, unknown>) {
  if (block.type === "text" && typeof (block as { text?: unknown }).text === "string") {
    return (block as { text: string }).text;
  }
  if (block.type === "thinking" && typeof (block as { thinking?: unknown }).thinking === "string") {
    return (block as { thinking: string }).thinking;
  }
  if (block.type === "tool_use") {
    const name = (block as { name?: unknown }).name;
    return typeof name === "string" ? `Using ${name}` : "Using a tool";
  }
  if (block.type === "tool_result") {
    return "Tool result";
  }
  return "";
}

export function contentText(content: ContentBlock[] | null | undefined) {
  return (content ?? []).map((block) => contentBlockText(block)).filter(Boolean).join("\n\n");
}

export function hasRenderableContent(content: ContentBlock[] | null | undefined) {
  return (content ?? []).some((block) => {
    if (block.type === "text") return typeof block.text === "string" && block.text.trim().length > 0;
    if (block.type === "thinking") return typeof block.thinking === "string" && block.thinking.trim().length > 0;
    if (block.type === "image") return block.source?.type === "url" && Boolean(block.source.url);
    if (block.type === "tool_use") return true;
    if (block.type === "tool_result") return true;
    return false;
  });
}

export function hasRenderableMessage(message: Pick<MessageRecord, "text" | "content" | "errorMessage">) {
  return Boolean(message.errorMessage?.trim() || message.text?.trim() || hasRenderableContent(message.content));
}

export function messageText(message: Pick<MessageRecord, "text" | "content">) {
  return message.text?.trim() || contentText(message.content).trim();
}

export function shortPreview(value: string | null | undefined, limit = 110) {
  const normalized = value?.replace(/\s+/g, " ").trim() || "No messages yet";
  return normalized.length > limit ? `${normalized.slice(0, limit - 1)}…` : normalized;
}

export function messageKind(message: Pick<MessageRecord, "role" | "meta">) {
  const kind = message.meta?.messageKind;
  return typeof kind === "string" ? kind : message.role;
}

export function isAssistantIntermediate(message: Pick<MessageRecord, "role" | "meta">) {
  return message.role === "assistant" && message.meta?.messageKind === "assistant_intermediate";
}

export function normalizeSpacePath(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .split("/")
    .filter(Boolean)
    .join("/");
}

export function parentSpacePath(value: string) {
  const path = normalizeSpacePath(value);
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

export function spacePathName(value: string, fallback = "Files") {
  const path = normalizeSpacePath(value);
  return path.split("/").pop() || fallback;
}

export function sortByRecent<T extends { updatedAt?: string | null; lastMessageAt?: string | null }>(items: T[]) {
  return [...items].sort((a, b) => {
    const aTime = new Date(a.lastMessageAt ?? a.updatedAt ?? 0).getTime();
    const bTime = new Date(b.lastMessageAt ?? b.updatedAt ?? 0).getTime();
    return bTime - aTime;
  });
}
