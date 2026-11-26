import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { IMAGE_URL_MIME_TYPE, imageUrlContent } from "@cohub/protocol/core";
import { logger } from "../logger.js";
import { OMITTED_IMAGE_TEXT } from "./compaction-policy.js";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "./agent-messages.js";

const LLM_REQUEST_MAX_BYTES = 30 * 1024 * 1024;

function extractTextFromToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "text"
      ? String((block as Record<string, unknown>).text ?? "")
      : "")
    .join("");
}

function shellCommandResultToText(message: Record<string, unknown>) {
  const meta = message.meta && typeof message.meta === "object" && !Array.isArray(message.meta)
    ? message.meta as Record<string, unknown>
    : {};
  if (typeof meta.llmContextText === "string") return meta.llmContextText;

  const content = Array.isArray(message.content) ? message.content : [];
  const toolUse = content.find((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_use") as Record<string, unknown> | undefined;
  const toolResult = content.find((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "tool_result") as Record<string, unknown> | undefined;
  const input = toolUse?.input && typeof toolUse.input === "object" ? toolUse.input as Record<string, unknown> : {};
  const command = typeof meta.command === "string" ? meta.command : typeof input.command === "string" ? input.command : "";
  const output = extractTextFromToolResultContent(toolResult?.content);
  const resultMeta = toolResult?._meta && typeof toolResult._meta === "object" ? toolResult._meta as Record<string, unknown> : {};
  const exitCode = typeof meta.exitCode === "number" ? meta.exitCode : typeof resultMeta.exitCode === "number" ? resultMeta.exitCode : null;
  const cancelled = meta.cancelled === true || resultMeta.cancelled === true;

  let text = `Ran \`${command}\``;
  text += output ? `\n\`\`\`\n${output}\n\`\`\`` : "\n(no output)";
  if (cancelled) {
    text += "\n\n(command cancelled)";
  } else if (exitCode != null && exitCode !== 0) {
    text += `\n\nCommand exited with code ${exitCode}`;
  }
  return text;
}

const SUPPORTED_LLM_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function isSupportedLlmImageMimeType(mimeType: string | null | undefined): boolean {
  return mimeType != null && SUPPORTED_LLM_IMAGE_MIME_TYPES.has(mimeType);
}

function estimateLlmPayloadBytes(value: unknown): number {
  if (value == null) return 4;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8") + 2;
  if (typeof value === "number" || typeof value === "boolean") return 8;
  if (Array.isArray(value)) return 2 + value.reduce((sum, item) => sum + estimateLlmPayloadBytes(item) + 1, 0);
  if (typeof value !== "object") return 0;
  let bytes = 2;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    bytes += Buffer.byteLength(key, "utf8") + estimateLlmPayloadBytes(item) + 4;
  }
  return bytes;
}

function isLlmImageBlock(value: unknown): value is { type: "image"; data: string; mimeType: string; text?: string } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).type === "image"
    && typeof (value as Record<string, unknown>).data === "string"
    && typeof (value as Record<string, unknown>).mimeType === "string");
}

function collectOmittableHistoryImageBlocks(messages: unknown[]) {
  const images: Array<{ block: { type: "image"; data: string; mimeType: string; text?: string }; bytes: number }> = [];
  let currentUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && typeof message === "object" && !Array.isArray(message) && (message as Record<string, unknown>).role === "user") {
      currentUserIndex = index;
      break;
    }
  }
  const historyEnd = currentUserIndex < 0 ? messages.length : currentUserIndex;
  for (let index = 0; index < historyEnd; index += 1) {
    const message = messages[index];
    const content = message && typeof message === "object" && !Array.isArray(message)
      ? (message as Record<string, unknown>).content
      : null;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isLlmImageBlock(block) || block.mimeType === IMAGE_URL_MIME_TYPE) continue;
      images.push({ block, bytes: block.data.length + Buffer.byteLength(block.mimeType, "utf8") });
    }
  }
  return images;
}

export function applyLlmRequestSizeGuard(messages: unknown[]) {
  let estimatedBytes = estimateLlmPayloadBytes(messages);
  if (estimatedBytes <= LLM_REQUEST_MAX_BYTES) return messages;

  let omittedImages = 0;
  let omittedBytes = 0;
  for (const image of collectOmittableHistoryImageBlocks(messages)) {
    omittedImages += 1;
    omittedBytes += image.bytes;
    image.block.type = "text" as never;
    image.block.text = OMITTED_IMAGE_TEXT;
    delete (image.block as Partial<typeof image.block>).data;
    delete (image.block as Partial<typeof image.block>).mimeType;
    estimatedBytes = estimateLlmPayloadBytes(messages);
    if (estimatedBytes <= LLM_REQUEST_MAX_BYTES) break;
  }

  if (omittedImages > 0) {
    logger.info(`[Agent] omitted ${omittedImages} history image(s) from LLM request to fit request size estimatedBytes=${estimatedBytes} omittedImageBytes=${omittedBytes}`);
  }
  if (estimatedBytes > LLM_REQUEST_MAX_BYTES) {
    logger.warn(`[Agent] LLM request still exceeds size guard after image omission estimatedBytes=${estimatedBytes} maxBytes=${LLM_REQUEST_MAX_BYTES}`);
  }
  return messages;
}

function toLlmImageContent(block: Record<string, unknown>): ImageContent | null {
  const directData = typeof block.data === "string" && block.data.trim() ? block.data : null;
  if (directData) {
    const mimeType = typeof block.mimeType === "string" && block.mimeType.trim()
      ? block.mimeType.trim()
      : typeof block.media_type === "string" && block.media_type.trim()
        ? block.media_type.trim()
        : "application/octet-stream";
    if (mimeType === IMAGE_URL_MIME_TYPE) return imageUrlContent(directData);
    if (!isSupportedLlmImageMimeType(mimeType)) return null;
    return {
      type: "image",
      data: directData.replace(/^data:[^;,]+;base64,/, ""),
      mimeType,
    };
  }

  const source = block.source && typeof block.source === "object" && !Array.isArray(block.source)
    ? block.source as Record<string, unknown>
    : null;
  if (source?.type === "url" && typeof source.url === "string" && source.url.trim()) return imageUrlContent(source.url.trim());
  if (source?.type !== "base64" || typeof source.data !== "string" || !source.data.trim()) {
    return null;
  }

  const mimeType = typeof source.media_type === "string" && source.media_type.trim()
    ? source.media_type.trim()
    : "application/octet-stream";
  if (!isSupportedLlmImageMimeType(mimeType)) return null;
  return {
    type: "image",
    data: source.data.replace(/^data:[^;,]+;base64,/, ""),
    mimeType,
  };
}

function toLlmTextContent(block: Record<string, unknown>) {
  return {
    type: "text",
    text: typeof block.text === "string" ? block.text : "",
  };
}

function toLlmUserMessage(message: AgentMessage): AgentMessage | null {
  const record = message as unknown as Record<string, unknown>;
  if (!Array.isArray(record.content)) return message;

  const content = record.content
    .map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return null;
      const item = block as Record<string, unknown>;
      if (item.type === "text") return toLlmTextContent(item);
      if (item.type === "image") return toLlmImageContent(item);
      return null;
    })
    .filter((block): block is ImageContent | { type: "text"; text: string } => Boolean(block));

  if (content.length === 0) return null;
  return {
    ...record,
    content,
  } as unknown as AgentMessage;
}

function toLlmToolResultMessage(message: AgentMessage): AgentMessage {
  const record = message as unknown as Record<string, unknown>;
  if (!Array.isArray(record.content)) return message;

  const content = record.content
    .map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return null;
      const item = block as Record<string, unknown>;
      if (item.type === "text") return toLlmTextContent(item);
      if (item.type === "image") return toLlmImageContent(item) ?? null;
      return null;
    })
    .filter((block): block is ImageContent | { type: "text"; text: string } => Boolean(block && (block.type !== "text" || block.text.trim())));

  // Providers reject empty tool results (Anthropic: "content cannot be empty if is_error is true").
  return {
    ...record,
    content: content.length > 0 ? content : [{ type: "text", text: "(no output)" }],
  } as unknown as AgentMessage;
}

export function toLlmMessages(messages: AgentMessage[]) {
  const result: unknown[] = [];
  for (const message of messages) {
    const record = message as unknown as Record<string, unknown>;
    const role = record.role;
    const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
      ? record.meta as Record<string, unknown>
      : {};

    if (role === "user" && Array.isArray(record.content) && record.content.some((block) => Boolean(block && typeof block === "object" && (block as Record<string, unknown>).type === "shell_command"))) {
      continue;
    }

    if (role === "assistant" && meta.messageKind === "shell_command_result") {
      result.push({
        role: "user",
        content: [{ type: "text", text: shellCommandResultToText(record) }],
        timestamp: typeof record.timestamp === "number" ? record.timestamp : Date.now(),
      });
      continue;
    }

    if (role === "user") {
      const userMessage = toLlmUserMessage(message);
      if (userMessage) result.push(userMessage);
      continue;
    }

    if (role === "assistant") {
      result.push(message);
      continue;
    }

    if (role === "toolResult") {
      result.push(toLlmToolResultMessage(message));
      continue;
    }

    if (role === "compactionSummary") {
      const summary = typeof record.summary === "string" ? record.summary : "";
      result.push({
        role: "user",
        content: [{ type: "text", text: COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX }],
        timestamp: typeof record.timestamp === "number" ? record.timestamp : Date.now(),
      });
    }
  }
  return result as never;
}
