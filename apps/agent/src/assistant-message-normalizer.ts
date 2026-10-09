import type { ContentBlock } from "@cohub/protocol/core";
import { normalizeContentBlockSafe, normalizeContentBlocksSafe } from "@cohub/core/content/normalize";
import { logger } from "./logger.js";

const extractThinkingFromContent = (content: unknown): string => {
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; thinking?: string } =>
      !!item && typeof item === "object" && "type" in item && item.type === "thinking" && typeof item.thinking === "string")
    .map((item) => item.thinking ?? "")
    .join("\n")
    .trim();
};

const summarizeThinking = (thinking: string): string => {
  const trimmed = thinking.trim();
  if (!trimmed) return "";
  const lines = trimmed.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(0, 3).join("\n").slice(0, 600);
};

const summarizeToolArgs = (toolName: string, args: unknown): string => {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  if (toolName === "bash" && typeof record.command === "string") return record.command.trim().slice(0, 120);
  if (typeof record.path === "string") return record.path;
  if (typeof record.pattern === "string" && typeof record.path === "string") return `${record.pattern} in ${record.path}`;
  if (typeof record.query === "string") return record.query;
  const first = Object.entries(record)
    .filter(([, value]) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    .slice(0, 2)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return first.slice(0, 120);
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const warnInvalidContentBlock = (context: string) => (issue: { message: string; block: unknown }) => {
  logger.warn(`[Normalize] ${context}: ${issue.message}`, { block: issue.block });
};

type NormalizedToolResultContent = {
  content: string | ContentBlock[];
  isError: boolean;
  errorMessage?: string;
};

const textFromBlocks = (blocks: ContentBlock[]) => {
  const text = blocks
    .flatMap((block) => block.type === "text" ? [block.text] : [])
    .join("\n")
    .trim();
  return text || null;
};

const normalizeToolResultBlocks = (blocks: unknown[], context: string): NormalizedToolResultContent => {
  const issues: Array<{ message: string; block: unknown }> = [];
  const content = normalizeContentBlocksSafe(blocks, {
    onInvalid: (issue) => {
      issues.push(issue);
      warnInvalidContentBlock(context)(issue);
    },
  });
  if (issues.length === 0) {
    const hosted = content.filter((block) => block.type !== "image" || block.source.type === "url");
    return { content: hosted.some((block) => block.type === "image") ? hosted : textFromBlocks(content) ?? content, isError: false };
  }
  const message = `Tool result content error: ${issues.map((issue) => issue.message).join("; ")}`;
  return { content: message, isError: true, errorMessage: message };
};

const extractToolResultContent = (result: unknown): NormalizedToolResultContent => {
  if (typeof result === "string") return { content: result, isError: false };
  if (!result || typeof result !== "object") return { content: "", isError: false };
  const record = result as Record<string, unknown>;
  if (typeof record.content === "string") return { content: record.content, isError: false };
  if (Array.isArray(record.content)) return normalizeToolResultBlocks(record.content, "tool result content");
  if (typeof record.text === "string") return { content: record.text, isError: false };
  return { content: safeStringify(result), isError: false };
};

type ToolExecution = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  resultContent?: string | ContentBlock[];
  isError: boolean;
  toolUseMeta?: Record<string, unknown>;
  toolResultMeta?: Record<string, unknown>;
};

type NormalizedAssistantTurn = {
  content: ContentBlock[];
  thinking: string;
  thinkingSummary: string;
  toolCallRenderStates: Array<{
    toolCallId: string;
    toolName: string;
    status: "running" | "done" | "failed";
    summary: string;
  }>;
};

const normalizeToolExecutions = (
  assistantMessage: Record<string, unknown>,
  toolResults: Array<Record<string, unknown>>,
): Map<string, ToolExecution> => {
  const executions = new Map<string, ToolExecution>();
  const content = Array.isArray(assistantMessage.content) ? assistantMessage.content : [];

  for (const raw of toolResults) {
    const id = typeof raw.toolCallId === "string" ? raw.toolCallId : "";
    const name = typeof raw.toolName === "string" ? raw.toolName : "";
    if (!id || !name) continue;
    const rawResultContent = "content" in raw ? extractToolResultContent(raw) : null;

    executions.set(id, {
      id,
      name,
      input: (raw.input as Record<string, unknown>) ?? {},
      resultContent: rawResultContent?.content,
      isError: Boolean(raw.isError) || Boolean(rawResultContent?.isError),
      toolResultMeta: {
        ...(((raw._meta as Record<string, unknown> | undefined) ?? (raw.meta as Record<string, unknown> | undefined)) ?? {}),
        ...(rawResultContent?.errorMessage ? { invalidContentBlock: true, errorMessage: rawResultContent.errorMessage } : {}),
      },
    });
  }

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;

    if ((block.type === "toolCall" || block.type === "tool_use") && typeof block.id === "string" && typeof block.name === "string") {
      const existing = executions.get(block.id);
      executions.set(block.id, {
        id: block.id,
        name: block.name,
        input: (block.type === "toolCall" ? block.arguments : block.input) as Record<string, unknown> ?? existing?.input ?? {},
        resultContent: existing?.resultContent,
        isError: existing?.isError ?? false,
        toolUseMeta: (block._meta as Record<string, unknown> | undefined) ?? existing?.toolUseMeta,
      });
      continue;
    }

    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const existing = executions.get(block.tool_use_id);
      if (!existing) continue;
      const normalizedBlockContent = Array.isArray(block.content)
        ? normalizeToolResultBlocks(block.content, "assistant tool_result content")
        : null;
      executions.set(block.tool_use_id, {
        ...existing,
        resultContent: typeof block.content === "string"
          ? block.content
          : normalizedBlockContent?.content ?? existing.resultContent,
        isError: Boolean(block.is_error) || existing.isError || Boolean(normalizedBlockContent?.isError),
        toolResultMeta: {
          ...(existing.toolResultMeta ?? {}),
          ...((block._meta as Record<string, unknown> | undefined) ?? {}),
          ...(normalizedBlockContent?.errorMessage ? { invalidContentBlock: true, errorMessage: normalizedBlockContent.errorMessage } : {}),
        },
      });
    }
  }

  return executions;
};

const emitToolUseBlock = (
  blocks: ContentBlock[],
  execution: ToolExecution,
  emittedToolUses: Set<string>,
) => {
  if (emittedToolUses.has(execution.id)) return;
  blocks.push({
    type: "tool_use",
    id: execution.id,
    name: execution.name,
    input: execution.input,
    ...(execution.toolUseMeta ? { _meta: execution.toolUseMeta } : {}),
  });
  emittedToolUses.add(execution.id);
};

const emitToolResultBlock = (
  blocks: ContentBlock[],
  execution: ToolExecution,
  emittedToolResults: Set<string>,
) => {
  if (emittedToolResults.has(execution.id) || execution.resultContent === undefined) return;
  blocks.push({
    type: "tool_result",
    tool_use_id: execution.id,
    content: execution.resultContent,
    is_error: execution.isError,
    ...(execution.toolResultMeta ? { _meta: execution.toolResultMeta } : {}),
  });
  emittedToolResults.add(execution.id);
};

export function normalizeAssistantTurn(
  assistantMessage: Record<string, unknown>,
  toolResults: Array<Record<string, unknown>>,
): NormalizedAssistantTurn {
  const blocks: ContentBlock[] = [];
  const content = Array.isArray(assistantMessage.content) ? assistantMessage.content : [];
  const executions = normalizeToolExecutions(assistantMessage, toolResults);
  const emittedToolUses = new Set<string>();
  const emittedToolResults = new Set<string>();

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;

    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({
        type: "text",
        text: block.text,
        ...(block._meta && typeof block._meta === "object" ? { _meta: block._meta as Record<string, unknown> } : {}),
      });
      continue;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      blocks.push({
        type: "thinking",
        thinking: block.thinking,
        ...(typeof (block.thinkingSignature ?? block.signature) === "string" ? { signature: String(block.thinkingSignature ?? block.signature) } : {}),
        ...(block._meta && typeof block._meta === "object" ? { _meta: block._meta as Record<string, unknown> } : {}),
      });
      continue;
    }
    if (block.type === "image") {
      const normalizedImage = normalizeContentBlockSafe(block, { onInvalid: warnInvalidContentBlock("assistant image block") });
      if (normalizedImage?.type === "image") blocks.push(normalizedImage);
      continue;
    }
    if ((block.type === "toolCall" || block.type === "tool_use") && typeof block.id === "string") {
      const execution = executions.get(block.id);
      if (execution) {
        emitToolUseBlock(blocks, execution, emittedToolUses);
      } else if (typeof block.name === "string") {
        blocks.push({
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: (block.type === "toolCall" ? block.arguments : block.input) as Record<string, unknown> ?? {},
          ...(block._meta && typeof block._meta === "object" ? { _meta: block._meta as Record<string, unknown> } : {}),
        });
        emittedToolUses.add(block.id);
      } else {
        logger.warn("[Normalize] tool block has no matching execution", {
          blockType: block.type,
          toolCallId: block.id,
          hasName: typeof block.name === "string",
        });
      }
      continue;
    }
    if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
      const execution = executions.get(block.tool_use_id);
      if (execution) {
        emitToolUseBlock(blocks, execution, emittedToolUses);
        emitToolResultBlock(blocks, execution, emittedToolResults);
      } else {
        logger.warn("[Normalize] tool_result block has no matching execution", { toolCallId: block.tool_use_id });
        const normalizedContent = Array.isArray(block.content)
          ? normalizeToolResultBlocks(block.content, "unmatched tool_result content")
          : null;
        blocks.push({
          type: "tool_result",
          tool_use_id: block.tool_use_id,
          content: typeof block.content === "string" ? block.content : normalizedContent?.content ?? "",
          is_error: Boolean(block.is_error) || Boolean(normalizedContent?.isError),
          _meta: normalizedContent?.errorMessage
            ? { invalidContentBlock: true, errorMessage: normalizedContent.errorMessage }
            : undefined,
        });
        emittedToolResults.add(block.tool_use_id);
      }
    }
  }

  for (const execution of executions.values()) {
    emitToolUseBlock(blocks, execution, emittedToolUses);
    emitToolResultBlock(blocks, execution, emittedToolResults);
  }

  const thinking = extractThinkingFromContent(assistantMessage.content);
  const thinkingSummary = summarizeThinking(thinking);
  const toolCallRenderStates = [...executions.values()].map((execution) => {
    const status: "running" | "done" | "failed" = execution.resultContent === undefined
      ? "running"
      : execution.isError
        ? "failed"
        : "done";
    return {
      toolCallId: execution.id,
      toolName: execution.name,
      status,
      summary: summarizeToolArgs(execution.name, execution.input),
    };
  });

  return { content: blocks, thinking, thinkingSummary, toolCallRenderStates };
}
