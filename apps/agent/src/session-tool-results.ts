import type { ContentBlock } from "@cohub/protocol/core";
import { normalizeContentBlocksSafe } from "@cohub/core/content/normalize";
import { logger } from "./logger.js";

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function warnInvalidToolResultBlock(issue: { message: string; block: unknown }) {
  logger.warn(`[Normalize] tool result content: ${issue.message}`, { block: issue.block });
}

type NormalizedToolResultContent = {
  content: string | ContentBlock[];
  isError: boolean;
  errorMessage?: string;
};

function normalizeToolResultBlocks(blocks: unknown[]): NormalizedToolResultContent {
  const issues: Array<{ message: string; block: unknown }> = [];
  const content = normalizeContentBlocksSafe(blocks, {
    onInvalid: (issue) => {
      issues.push(issue);
      warnInvalidToolResultBlock(issue);
    },
  });
  if (issues.length === 0) return { content, isError: false };
  const message = `Tool result content error: ${issues.map((issue) => issue.message).join("; ")}`;
  return { content: message, isError: true, errorMessage: message };
}

export function extractToolResultContent(result: unknown): NormalizedToolResultContent {
  if (typeof result === "string") return { content: result, isError: false };
  if (!result || typeof result !== "object") return { content: "", isError: false };
  const record = result as Record<string, unknown>;
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : null;
  if (typeof details?.rawOutput === "string") return { content: details.rawOutput, isError: false };
  if (typeof record.content === "string") return { content: record.content, isError: false };
  if (Array.isArray(record.content)) return normalizeToolResultBlocks(record.content);
  if (typeof record.text === "string") return { content: record.text, isError: false };
  return { content: safeStringify(result), isError: false };
}

export function extractTextFromToolResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  // Handle structured content array: [{type: "text", text: "..."}, ...]
  if (Array.isArray(record.content)) {
    const texts: string[] = [];
    for (const item of record.content) {
      if (item && typeof item === "object" && "type" in item) {
        const block = item as Record<string, unknown>;
        if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
      }
    }
    if (texts.length > 0) return texts.join("");
  }
  return "";
}
