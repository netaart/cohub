import type { ContentBlock, MessageRecord, SessionRecord, SpaceRecord } from "@neta-art/cohub";
import * as Crypto from "expo-crypto";
import { translate, getActiveLocale } from "@/src/i18n/core";

export function newId() {
  return Crypto.randomUUID();
}

export function displaySpaceName(space: Partial<Pick<SpaceRecord, "name" | "title">> | null | undefined) {
  return space?.name?.trim() || space?.title?.trim() || translate("space.fallbackName");
}

export function displaySessionTitle(session: Pick<SessionRecord, "title" | "latestMessageText">) {
  return session.title?.trim() || session.latestMessageText?.trim().split("\n")[0]?.slice(0, 64) || translate("session.untitled");
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
  return date.toLocaleDateString(getActiveLocale(), { month: "short", day: "numeric" });
}

export function formatNumber(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "0";
  return new Intl.NumberFormat(getActiveLocale(), { notation: "compact", maximumFractionDigits: 1 }).format(value);
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
    return typeof name === "string" ? translate("message.tool.using", { name }) : translate("message.tool.usingGeneric");
  }
  if (block.type === "tool_result") {
    return translate("message.tool.result");
  }
  if (block.type === "system_note" && typeof (block as { text?: unknown }).text === "string") {
    return (block as { text: string }).text;
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
    if (block.type === "image") {
      if (block.source?.type === "url") return Boolean(block.source.url);
      if (block.source?.type === "base64") return Boolean(block.source.data);
      return false;
    }
    if (block.type === "tool_use") return true;
    if (block.type === "tool_result") return true;
    if (block.type === "system_note") return typeof block.text === "string" && block.text.trim().length > 0;
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
  const normalized = value?.replace(/\s+/g, " ").trim() || translate("session.noMessages");
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

export function spacePathName(value: string, fallback = translate("files.title")) {
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
