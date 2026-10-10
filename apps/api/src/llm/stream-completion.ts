import { imageBlockToPi, type ContentBlock } from "@cohub/protocol/core";
import type {
  CompletionAssistantMessage,
  CompletionMessage,
  CompletionThinkingLevel,
  CompletionUsage,
  SpaceCompletionStreamEvent,
} from "@cohub/protocol";
import {
  clampThinkingLevel,
  type AssistantMessage,
  type ImageContent,
  type Message,
  type ThinkingLevel,
  type Usage as PiUsage,
} from "@earendil-works/pi-ai";
import type { ImageToTextConfig } from "@cohub/infra/config-runtime/model-tasks";
import type { CompletionModelRegistry, RuntimeLlmModel } from "./completion-registry.js";
import { prepareCompletionImagesForModel, type ImageToTextCall } from "./image-to-text.js";
import { createModelsFromRegistry, streamSimpleWithModels } from "./pi-models-adapter.js";

const THINKING_LEVELS = new Set<CompletionThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function normalizeThinkingLevel(level: string | null | undefined): CompletionThinkingLevel | undefined {
  return level && THINKING_LEVELS.has(level as CompletionThinkingLevel)
    ? level as CompletionThinkingLevel
    : undefined;
}

function resolveThinkingLevelForModel(model: RuntimeLlmModel, requested?: string | null): ThinkingLevel | undefined {
  const fallback = normalizeThinkingLevel(model.defaultThinkingLevel) ?? (model.reasoning ? "high" : "off");
  const level = normalizeThinkingLevel(requested) ?? fallback;
  if (!model.reasoning || level === "off") return undefined;
  return clampThinkingLevel(model, level) as ThinkingLevel;
}

function contentBlocksToPiContent(blocks: ContentBlock[]): string | Array<{ type: "text"; text: string } | ImageContent> {
  const parts: Array<{ type: "text"; text: string } | ImageContent> = [];
  for (const block of blocks) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
      continue;
    }
    if (block.type === "image") {
      const image = imageBlockToPi(block);
      if (image) parts.push(image);
      continue;
    }
    if (block.type === "thinking") {
      parts.push({ type: "text", text: block.thinking });
    }
  }
  if (parts.length === 0) return "";
  if (parts.length === 1 && parts[0]?.type === "text") return parts[0].text;
  return parts;
}

function toPiMessages(messages: CompletionMessage[]): Message[] {
  const result: Message[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      // System role is folded into systemPrompt by the caller; keep as user text if present.
      const text = contentBlocksToPiContent(message.content);
      result.push({
        role: "user",
        content: typeof text === "string" ? text : text,
        timestamp: Date.now(),
      });
      continue;
    }
    if (message.role === "user") {
      result.push({
        role: "user",
        content: contentBlocksToPiContent(message.content),
        timestamp: Date.now(),
      });
      continue;
    }
    if (message.role === "assistant") {
      const textParts = message.content
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("");
      result.push({
        role: "assistant",
        content: textParts ? [{ type: "text", text: textParts }] : [],
        api: "openai-completions",
        provider: "unknown",
        model: "unknown",
        usage: emptyPiUsage(),
        stopReason: "stop",
        timestamp: Date.now(),
      });
    }
  }
  return result;
}

function emptyPiUsage(): PiUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function toCompletionUsage(usage: PiUsage | null | undefined): CompletionUsage | null {
  if (!usage) return null;
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: usage.cost
      ? {
          input: usage.cost.input,
          output: usage.cost.output,
          cacheRead: usage.cost.cacheRead,
          cacheWrite: usage.cost.cacheWrite,
          total: usage.cost.total,
        }
      : null,
  };
}

function addCompletionUsage(a: CompletionUsage | null, b: CompletionUsage | null): CompletionUsage | null {
  if (!a && !b) return null;
  return {
    input: (a?.input ?? 0) + (b?.input ?? 0),
    output: (a?.output ?? 0) + (b?.output ?? 0),
    cacheRead: (a?.cacheRead ?? 0) + (b?.cacheRead ?? 0),
    cacheWrite: (a?.cacheWrite ?? 0) + (b?.cacheWrite ?? 0),
    totalTokens: (a?.totalTokens ?? 0) + (b?.totalTokens ?? 0),
    cost: a?.cost || b?.cost
      ? {
          input: (a?.cost?.input ?? 0) + (b?.cost?.input ?? 0),
          output: (a?.cost?.output ?? 0) + (b?.cost?.output ?? 0),
          cacheRead: (a?.cost?.cacheRead ?? 0) + (b?.cost?.cacheRead ?? 0),
          cacheWrite: (a?.cost?.cacheWrite ?? 0) + (b?.cost?.cacheWrite ?? 0),
          total: (a?.cost?.total ?? 0) + (b?.cost?.total ?? 0),
        }
      : null,
  };
}

function assistantContentBlocks(message: AssistantMessage): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of message.content ?? []) {
    if (part.type === "text" && part.text) {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "thinking" && part.thinking) {
      blocks.push({ type: "thinking", thinking: part.thinking, ...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}) });
    }
  }
  if (blocks.length === 0) blocks.push({ type: "text", text: "" });
  return blocks;
}

export function toCompletionAssistantMessage(message: AssistantMessage): CompletionAssistantMessage {
  const stopReason =
    message.stopReason === "length" || message.stopReason === "error" || message.stopReason === "aborted"
      ? message.stopReason
      : "stop";
  return {
    role: "assistant",
    content: assistantContentBlocks(message),
    stopReason,
    ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
  };
}

export function extractSystemMessagesPrompt(messages: CompletionMessage[]): {
  systemFromMessages: string;
  remaining: CompletionMessage[];
} {
  const systemParts: string[] = [];
  const remaining: CompletionMessage[] = [];
  for (const message of messages) {
    if (message.role !== "system") {
      remaining.push(message);
      continue;
    }
    const text = message.content
      .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (text.trim()) systemParts.push(text);
  }
  return {
    systemFromMessages: systemParts.join("\n\n"),
    remaining,
  };
}

export type RunCompletionInput = {
  completionId: string;
  registry: CompletionModelRegistry;
  model: RuntimeLlmModel;
  systemPrompt: string;
  messages: CompletionMessage[];
  temperature?: number | null;
  maxTokens?: number | null;
  thinkingLevel?: string | null;
  userId: string;
  spaceId: string;
  imageToTextConfig?: ImageToTextConfig | null;
  signal?: AbortSignal;
};

export type RunCompletionOutcome = {
  message: CompletionAssistantMessage;
  usage: CompletionUsage | null;
  totalUsage: CompletionUsage | null;
  imageToTextCalls: ImageToTextCall[];
  archivedMessages: CompletionMessage[];
  raw: AssistantMessage | null;
  aborted: boolean;
  error: { code: string; message: string } | null;
};

export async function* streamCompletionEvents(input: RunCompletionInput): AsyncGenerator<SpaceCompletionStreamEvent, RunCompletionOutcome> {
  const prepared = await prepareCompletionImagesForModel({
    messages: input.messages,
    targetModel: input.model,
    config: input.imageToTextConfig ?? null,
    signal: input.signal,
  });
  const { systemFromMessages, remaining } = extractSystemMessagesPrompt(prepared.projectedMessages);
  const systemPrompt = [input.systemPrompt, systemFromMessages].filter((part) => part.trim().length > 0).join("\n\n");
  const piMessages = toPiMessages(remaining);
  const apiKey = input.registry.getApiKey(input.model.provider);
  const headers = input.registry.getHeaders(input.model.provider, input.model.id);
  const reasoning = resolveThinkingLevelForModel(input.model, input.thinkingLevel);

  yield {
    type: "meta",
    completionId: input.completionId,
    provider: input.model.provider,
    model: input.model.id,
    systemPromptPath: null,
  };

  // Note: route layer may re-emit meta with systemPromptPath.

  let finalMessage: AssistantMessage | null = null;
  let aborted = Boolean(input.signal?.aborted);
  let error: { code: string; message: string } | null = null;

  try {
    if (aborted) throw new Error("aborted");
    const models = createModelsFromRegistry(input.registry, input.model);
    const stream = streamSimpleWithModels(models, input.model, {
      systemPrompt: systemPrompt || undefined,
      messages: piMessages,
    }, {
      apiKey,
      headers: input.model.provider === "cohub"
        ? {
            ...(headers ?? {}),
            "x-litellm-track-extra": JSON.stringify({
              user_uuid: input.userId,
              cohub_space_uuid: input.spaceId,
              cohub_completion_id: input.completionId,
            }),
          }
        : headers,
      temperature: typeof input.temperature === "number" && Number.isFinite(input.temperature) ? input.temperature : undefined,
      maxTokens: typeof input.maxTokens === "number" && Number.isFinite(input.maxTokens) ? Math.floor(input.maxTokens) : undefined,
      reasoning,
      signal: input.signal,
      originalImageUrls: true,
    });

    for await (const event of stream) {
      if (input.signal?.aborted) {
        aborted = true;
        break;
      }
      if (event.type === "text_delta" && event.delta) {
        yield { type: "delta", text: event.delta };
      } else if (event.type === "thinking_delta" && event.delta) {
        yield { type: "thinking_delta", text: event.delta };
      } else if (event.type === "done") {
        finalMessage = event.message;
      } else if (event.type === "error") {
        finalMessage = event.error;
        if (event.reason === "aborted") {
          aborted = true;
        } else {
          error = {
            code: "llm_error",
            message: event.error.errorMessage?.trim() || "LLM request failed",
          };
        }
      }
    }
  } catch (caught) {
    if (input.signal?.aborted || (caught instanceof Error && /abort/i.test(caught.message))) {
      aborted = true;
    } else {
      error = {
        code: "llm_error",
        message: caught instanceof Error ? caught.message : String(caught),
      };
    }
  }

  if (!finalMessage) {
    finalMessage = {
      role: "assistant",
      content: [],
      api: input.model.api,
      provider: input.model.provider,
      model: input.model.id,
      usage: emptyPiUsage(),
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error?.message ?? (aborted ? "aborted" : "LLM request failed"),
      timestamp: Date.now(),
    };
  }

  const message = toCompletionAssistantMessage(finalMessage);
  const usage = toCompletionUsage(finalMessage.usage);
  const totalUsage = prepared.calls.reduce(
    (total, call) => call.status === "succeeded" ? addCompletionUsage(total, call.usage) : total,
    usage,
  );
  if (usage) yield { type: "usage", usage };

  if (error && !aborted) {
    yield {
      type: "error",
      code: error.code,
      message: error.message,
      completionId: input.completionId,
    };
  } else {
    yield {
      type: "done",
      completionId: input.completionId,
      message,
      usage,
      ...(prepared.calls.length > 0 ? { contextFallbacks: prepared.calls } : {}),
    };
  }

  return {
    message,
    usage,
    totalUsage,
    imageToTextCalls: prepared.calls,
    archivedMessages: prepared.messages,
    raw: finalMessage,
    aborted,
    error: aborted ? { code: "aborted", message: "aborted" } : error,
  };
}

export async function runCompletion(input: RunCompletionInput): Promise<RunCompletionOutcome> {
  const iterator = streamCompletionEvents(input);
  let outcome: IteratorResult<SpaceCompletionStreamEvent, RunCompletionOutcome>;
  do {
    outcome = await iterator.next();
  } while (!outcome.done);
  return outcome.value;
}
