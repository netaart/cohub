import type { Agent, AgentEvent, AgentMessage, AgentTool, StreamFn, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Agent as PiAgent } from "@earendil-works/pi-agent-core";
import { clampThinkingLevel, createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type AssistantMessageEventStream, type Context, type ImageContent, type Model, type SimpleStreamOptions, isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { context, trace, type Span } from "@opentelemetry/api";
import { logger } from "../logger.js";
import { sendOutput } from "../redis.js";
import type { SessionManager } from "./local-session-manager.js";
import type { CohubModel, CohubModelRegistry } from "./model-registry.js";
import { createModelsFromRegistry, streamSimpleWithModels } from "./pi-models-adapter.js";
import { buildCohubSystemPrompt } from "./system-prompt-builder.js";
import { recordLlmUsage, startLlmRoundSpan, getAgentTracer } from "@cohub/infra/tracing/agent";
import { getCurrentToolExecutionContext, runWithToolExecutionContext, type ToolExecutionContext } from "../tool-context.js";
import { isToolFailureDetails } from "./tools/index.js";
import { applyRequestProfile } from "./request-profile.js";
import { mergeHeaders } from "@cohub/infra/config-runtime/models";
import type { ImageToTextConfig } from "@cohub/infra/config-runtime/model-tasks";
import { ModelUnavailableError } from "@cohub/core/sessions";
import { prepareAgentImagesForModel } from "./image-to-text.js";
import { OMITTED_IMAGE_TEXT } from "./compaction-policy.js";
import type { SpaceModListItem } from "@cohub/core/space-mods";
import {
  EMPTY_TOOL_CALL_LOOP_GUARD_STATE,
  observeToolCallBatch,
  TOOL_CALL_LOOP_GUARD_PROMPT,
  TOOL_CALL_LOOP_GUARD_THRESHOLD,
} from "./tool-call-loop-guard.js";

export type CohubAgentSessionEvent = AgentEvent;

export type CohubAgentSession = {
  agent: Agent;
  modelRegistry: CohubModelRegistry;
  sessionManager: SessionManager;
  isStreaming: boolean;
  isRetrying: boolean;
  shouldDeferErrorPersistence(message: Record<string, unknown>): boolean;
  /** Consume one-shot force-compact flag set after a context-overflow failure. */
  consumePendingForcedCompaction(): boolean;
  prompt(text: string, options?: { images?: ImageContent[] }): Promise<void>;
  promptMessages(messages: AgentMessage[]): Promise<void>;
  steer(text: string, images?: ImageContent[]): Promise<void>;
  enqueueSteer(text: string, images?: ImageContent[]): void;
  waitForIdle(): Promise<void>;
  setModel(model: Model<Api>): Promise<void>;
  configureRuntimeIdentity(input: { userId?: string | null; spaceOwnerUserId?: string | null; modelRegistry: CohubModelRegistry; imageToTextConfig?: ImageToTextConfig | null; requestedModel?: { provider: string; id: string }; requestedThinkingLevel?: string | null }): Promise<void>;
  configureTools(tools: ToolLike[]): Promise<void>;
  reload(): Promise<void>;
  abort(): Promise<void>;
  dispose(): void;
  subscribe(listener: (event: CohubAgentSessionEvent) => void | Promise<void>): () => void;
};

type ToolLike = AgentTool;

const AGENT_RETRY_MAX_RETRIES = 2;
const AGENT_RETRY_BASE_DELAY_MS = 1000;
const LLM_REQUEST_MAX_BYTES = 30 * 1024 * 1024;

const COMPACTION_SUMMARY_PREFIX = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function normalizeThinkingLevel(level: string | null | undefined): ThinkingLevel | undefined {
  return level && THINKING_LEVELS.has(level as ThinkingLevel) ? level as ThinkingLevel : undefined;
}

function resolveThinkingLevelForModel(model: CohubModel, requested?: string | null): ThinkingLevel {
  const fallback = normalizeThinkingLevel(model.defaultThinkingLevel) ?? (model.reasoning ? "high" : "off");
  const level = normalizeThinkingLevel(requested) ?? fallback;
  if (!model.reasoning) return "off";
  return clampThinkingLevel(model, level) as ThinkingLevel;
}

const COHUB_RETRYABLE_ERROR_OVERRIDE_PATTERN = /\b400\b.*(?:upstream(?:_error)?:?\s*upstream request failed|upstream response failed.*(?:bad_response_status_code|stage["']?\s*[:=]\s*["']?upstream_response))/i;
const COHUB_NON_RETRYABLE_ERROR_PATTERN = /insufficient[_ ](?:user[_ ])?quota|quota exceeded|out of budget|billing|余额不足|额度不足|invalid (?:request|url)|content[_ ]filter|request (?:is )?too large|payload too large/i;
const COHUB_MODEL_UNAVAILABLE_PATTERN = /model (?:is )?(?:(?:not )?available|unavailable)|requested model is not available/i;
const COHUB_RETRYABLE_ERROR_PATTERN = /responses_missing_terminal|anthropic_missing_message_stop|upstream_temporarily_unavailable|stream_read_error|stream ended before a terminal response event|upstream service temporarily unavailable|upstream request failed/i;

function getHttpErrorStatus(errorMessage: string): number | null {
  const status = errorMessage.match(/\b([45]\d{2})\b/)?.[1];
  return status ? Number(status) : null;
}

/**
 * Classify a raw provider error string. `null` means the string alone is
 * inconclusive and the caller should consult pi's own classification.
 */
function classifyProviderErrorMessage(errorMessage: string): boolean | null {
  if (COHUB_RETRYABLE_ERROR_OVERRIDE_PATTERN.test(errorMessage)) return true;
  if (COHUB_NON_RETRYABLE_ERROR_PATTERN.test(errorMessage)) return false;

  const status = getHttpErrorStatus(errorMessage);
  if (status != null) return status === 408 || status === 413 || status === 429 || status >= 500;
  if (COHUB_MODEL_UNAVAILABLE_PATTERN.test(errorMessage)) return false;
  if (COHUB_RETRYABLE_ERROR_PATTERN.test(errorMessage)) return true;

  return null;
}

/**
 * Whether a raw provider error string is worth retrying. Shares the rules used
 * for assistant retries so callers holding only an error message (compaction's
 * summarize step) don't invent their own classification.
 */
export function isRetryableProviderErrorMessage(errorMessage: string): boolean {
  if (!errorMessage) return false;
  return classifyProviderErrorMessage(errorMessage) === true;
}

function isRetryableProviderError(message: AssistantMessage | undefined): boolean {
  if (message?.stopReason !== "error" || !message.errorMessage) return false;
  return classifyProviderErrorMessage(message.errorMessage) ?? isRetryableAssistantError(message);
}

function hasAssistantContent(message: AssistantMessage): boolean {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.length > 0;
}

function isEmptySuccessfulAssistantMessage(message: AssistantMessage | undefined): boolean {
  if (!message) return false;
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  return !hasAssistantContent(message);
}

/**
 * Supplementary overflow patterns not yet covered by upstream pi-ai.
 * The cohub provider proxy returns Chinese error messages on context overflow.
 */
const LOCAL_OVERFLOW_PATTERNS = [
  /超过系统限制/, // Cohub proxy: "输入Tokens数量(N)超过系统限制(M)"
];

/**
 * Explicit context-window overflow (provider error). Silent / length-stop overflow
 * is intentionally excluded so we never discard a successful-looking response.
 */
export function isContextOverflowFailure(message: AssistantMessage | undefined): boolean {
  if (message?.stopReason !== "error" || !message.errorMessage) return false;
  if (isContextOverflow(message)) return true;
  const errorMessage = message.errorMessage;
  return LOCAL_OVERFLOW_PATTERNS.some((p) => p.test(errorMessage));
}

export function isRetryableAssistantFailure(message: AssistantMessage | undefined): boolean {
  return isRetryableProviderError(message)
    || isEmptySuccessfulAssistantMessage(message)
    || isContextOverflowFailure(message);
}

type AssistantRetryOutcome = {
  shouldRetry: boolean;
  retryAttempt: number;
  retryDelayMs?: number;
  retryReason?: string;
  forceCompaction?: boolean;
};

function getAssistantRetryOutcome(message: AssistantMessage | undefined, retryAttempt: number): AssistantRetryOutcome {
  if (!isRetryableAssistantFailure(message)) {
    return { shouldRetry: false, retryAttempt, retryReason: "not_retryable" };
  }
  if (retryAttempt >= AGENT_RETRY_MAX_RETRIES) {
    return { shouldRetry: false, retryAttempt, retryReason: "retry_exhausted" };
  }

  const overflow = isContextOverflowFailure(message);
  return {
    shouldRetry: true,
    retryAttempt: retryAttempt + 1,
    // Overflow recovery starts with force-compact; no backoff needed.
    retryDelayMs: overflow ? 0 : AGENT_RETRY_BASE_DELAY_MS * 2 ** retryAttempt,
    retryReason: overflow
      ? "context_overflow"
      : message?.stopReason === "error"
        ? (message?.errorMessage ?? "assistant_error")
        : "empty_assistant_message",
    forceCompaction: overflow,
  };
}

function recordAssistantRetrySpanAttributes(span: Span | undefined, outcome: AssistantRetryOutcome) {
  if (!span) return;
  span.setAttribute("agent.retry.should_retry", outcome.shouldRetry);
  span.setAttribute("agent.retry.attempt", outcome.retryAttempt);
  if (outcome.retryDelayMs != null) span.setAttribute("agent.retry.delay_ms", outcome.retryDelayMs);
  if (outcome.retryReason) span.setAttribute("agent.retry.reason", outcome.retryReason);
  if (outcome.forceCompaction) span.setAttribute("agent.retry.force_compaction", true);
}

function logAssistantRetry(sessionId: string, turnId: string | undefined, outcome: AssistantRetryOutcome) {
  const contextInfo = `sessionId=${sessionId}${turnId ? ` turnId=${turnId}` : ""}`;
  const reason = outcome.retryReason ?? "not_retryable";
  if (outcome.shouldRetry) {
    logger.info(
      `[Agent] assistant retry scheduled ${contextInfo} attempt=${outcome.retryAttempt} delayMs=${outcome.retryDelayMs} reason=${reason}`,
    );
  } else if (outcome.retryReason === "retry_exhausted") {
    logger.warn(`[Agent] assistant retry exhausted ${contextInfo} attempt=${outcome.retryAttempt}`);
  } else {
    logger.debug(`[Agent] assistant retry not scheduled ${contextInfo} attempt=${outcome.retryAttempt} reason=${reason}`);
  }
}


export function shouldResetAssistantRetryState(message: AssistantMessage | undefined): boolean {
  return !isRetryableAssistantFailure(message);
}

export type CreateCohubAgentSessionOptions = {
  cwd: string;
  userId?: string | null;
  spaceOwnerUserId?: string | null;
  sessionManager: SessionManager;
  modelRegistry: CohubModelRegistry;
  tools: ToolLike[];
  spaceMods?: SpaceModListItem[];
  imageToTextConfig?: ImageToTextConfig | null;
  model?: Model<Api>;
};

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
      if (!isLlmImageBlock(block)) continue;
      images.push({ block, bytes: block.data.length + Buffer.byteLength(block.mimeType, "utf8") });
    }
  }
  return images;
}

function applyLlmRequestSizeGuard(messages: unknown[]) {
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
    .filter((block): block is ImageContent | { type: "text"; text: string } => Boolean(block));

  return {
    ...record,
    content,
  } as unknown as AgentMessage;
}

function toLlmMessages(messages: AgentMessage[]) {
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

function normalizeUserId(userId?: string | null) {
  return userId?.trim() || null;
}

function toolsStateKey(tools: ToolLike[]) {
  return tools.map((tool) => tool.name).join("\0");
}

function shouldIncludeUserSkills(userId: string | null, spaceOwnerUserId: string | null) {
  return Boolean(userId && spaceOwnerUserId && userId === spaceOwnerUserId);
}

type WrapAssistantMessageStreamOptions = {
  model: Model<Api>;
  signal?: AbortSignal;
  onEvent?: (event: AssistantMessageEvent) => void;
  onFailure?: (error: unknown) => void;
};

export function wrapAssistantMessageStream(
  stream: AsyncIterable<AssistantMessageEvent>,
  options: WrapAssistantMessageStreamOptions,
): AssistantMessageEventStream {
  const wrapped = createAssistantMessageEventStream();
  let latestPartial: AssistantMessage | undefined;

  const pushFailure = (error: unknown) => {
    options.onFailure?.(error);
    const reason: "aborted" | "error" = options.signal?.aborted ? "aborted" : "error";
    const fallback: AssistantMessage = {
      role: "assistant",
      content: [],
      api: options.model.api,
      provider: options.model.provider,
      model: options.model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: reason,
      timestamp: Date.now(),
    };
    const failure: AssistantMessage = {
      ...(latestPartial ?? fallback),
      stopReason: reason,
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    wrapped.push({ type: "error", reason, error: failure });
  };

  void (async () => {
    try {
      for await (const event of stream) {
        if ("partial" in event) latestPartial = event.partial;
        options.onEvent?.(event);
        wrapped.push(event);
      }
    } catch (error) {
      pushFailure(error);
    }
  })().catch(pushFailure);

  return wrapped;
}

function attachImageToTextCalls(message: AssistantMessage, calls: Awaited<ReturnType<typeof prepareAgentImagesForModel>>["calls"]) {
  if (calls.length === 0) return;
  const record = message as unknown as Record<string, unknown>;
  const meta = record.meta && typeof record.meta === "object" && !Array.isArray(record.meta)
    ? record.meta as Record<string, unknown>
    : {};
  record.meta = { ...meta, imageToText: { schemaVersion: 1, calls } };
}

function createStreamFn(getRuntime: () => { modelRegistry: CohubModelRegistry; imageToTextConfig: ImageToTextConfig | null; sessionManager: SessionManager; userId: string | null; threadId: string }): StreamFn {
  const tracer = getAgentTracer();

  return async (model: Model<Api>, ctx: Context, options?: SimpleStreamOptions) => {
    const runtime = getRuntime();
    const toolCtx = getCurrentToolExecutionContext();
    const round = (toolCtx?.llmRound ?? 0) + 1;
    if (toolCtx) {
      toolCtx.llmRound = round;
      toolCtx.model = { provider: model.provider, id: model.id };
    }
    const metrics = toolCtx?.metrics;
    if (metrics) {
      metrics.llmRoundCount = Math.max(metrics.llmRoundCount, round);
    }

    const llmRound = startLlmRoundSpan(tracer, {
      provider: model.provider,
      model: model.id,
      messageCount: ctx.messages.length,
      spaceId: toolCtx?.spaceId,
      sessionId: toolCtx?.sessionId,
      turnId: toolCtx?.turnId,
      turnSeq: toolCtx?.turnSeq,
      requestId: toolCtx?.requestId ?? undefined,
      llmRound: round,
    });

    return context.with(llmRound.context, async () => {
      try {
        if (toolCtx?.assistantMessageTiming && !toolCtx.assistantMessageTiming.startedAt) {
          toolCtx.assistantMessageTiming.startedAt = new Date().toISOString();
        }
        const prepared = await prepareAgentImagesForModel({
          context: ctx,
          targetModel: model,
          config: runtime.imageToTextConfig,
          sessionManager: runtime.sessionManager,
          sessionId: toolCtx?.sessionId ?? runtime.threadId,
          executionTurnId: toolCtx?.turnId,
          signal: options?.signal,
        }).catch((error) => {
          logger.warn("[ImageToText] context preparation failed; continuing with original images", error);
          return { context: ctx, calls: [] };
        });
        const requestContext: Context = {
          ...prepared.context,
          messages: applyLlmRequestSizeGuard(structuredClone(prepared.context.messages)) as Context["messages"],
        };
        const streamHeaders = mergeHeaders(
          runtime.modelRegistry.getHeaders(model.provider, model.id),
          options?.headers as Record<string, string> | undefined,
        );
        if (toolCtx?.spaceId && toolCtx.sessionId) {
          const at = new Date().toISOString();
          await sendOutput({
            type: "turn_lifecycle",
            spaceId: toolCtx.spaceId,
            sessionId: toolCtx.sessionId,
            turnId: toolCtx.turnId ?? null,
            anchorUserMessageId: toolCtx.anchorUserMessageId ?? null,
            phase: "llm_call_started",
            llmRound: round,
            provider: model.provider,
            model: model.id,
            at,
            timestamp: Date.now(),
          }).catch((error) => {
            logger.warn(`[Agent] failed to publish llm_call_started lifecycle sessionId=${toolCtx.sessionId} turnId=${toolCtx.turnId ?? "unknown"}:`, error);
          });
        }
        const models = createModelsFromRegistry(runtime.modelRegistry, model);
        const requestOptions = applyRequestProfile(model as CohubModel, {
          ...options,
          threadId: runtime.threadId,
          headers: model.provider === "cohub"
            ? mergeHeaders(streamHeaders, {
                "x-litellm-track-extra": JSON.stringify({
                  user_uuid: runtime.userId,
                  cohub_space_uuid: toolCtx?.spaceId ?? null,
                  cohub_session_uuid: toolCtx?.sessionId ?? null,
                  cohub_turn_uuid: toolCtx?.turnId ?? null,
                  cohub_llm_round: round,
                }),
              })
            : streamHeaders,
        });
        const stream = streamSimpleWithModels(models, model, requestContext, requestOptions);

        return wrapAssistantMessageStream(stream, {
          model,
          signal: options?.signal,
          onFailure: (error) => llmRound.fail(error),
          onEvent: (event) => {
            if (event.type !== "start") {
              llmRound.markFirstToken();
            }
            if (event.type === "done") {
              attachImageToTextCalls(event.message, prepared.calls);
              recordLlmUsage(llmRound.span, {
                inputTokens: event.message.usage?.input,
                outputTokens: event.message.usage?.output,
                totalTokens: event.message.usage?.totalTokens,
                cacheReadTokens: event.message.usage?.cacheRead,
                cacheWriteTokens: event.message.usage?.cacheWrite,
                cost: event.message.usage?.cost?.total,
              });
              llmRound.finish({ finishReason: event.reason, outcome: "ok" });
            } else if (event.type === "error") {
              attachImageToTextCalls(event.error, prepared.calls);
              recordLlmUsage(llmRound.span, {
                inputTokens: event.error.usage?.input,
                outputTokens: event.error.usage?.output,
                totalTokens: event.error.usage?.totalTokens,
                cacheReadTokens: event.error.usage?.cacheRead,
                cacheWriteTokens: event.error.usage?.cacheWrite,
                cost: event.error.usage?.cost?.total,
              });
              llmRound.finish({ finishReason: event.reason, outcome: event.reason === "aborted" ? "aborted" : "error" });
            }
          },
        });
      } catch (error) {
        llmRound.fail(error);
        throw error;
      }
    });
  };
}

function createUserMessage(text: string, images?: ImageContent[], meta?: Record<string, unknown>): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }, ...(images ?? [])],
    timestamp: Date.now(),
    ...(meta ? { meta } : {}),
  } as AgentMessage;
}

function toolSnippets(toolName: string): string | undefined {
  switch (toolName) {
    case "read": return "Read file contents";
    case "bash": return "Execute bash commands";
    case "edit": return "Read the target first, copy oldText verbatim, and use unique surrounding context for precise edits";
    case "write": return "Create or overwrite files";
    case "grep": return "Search file contents";
    case "find": return "Search files by glob pattern";
    case "ls": return "List directory contents";
    default: return undefined;
  }
}

export async function createCohubAgentSession(options: CreateCohubAgentSessionOptions): Promise<{ session: CohubAgentSession }> {
  const sessionContext = options.sessionManager.buildSessionContext();
  let runtimeUserId = normalizeUserId(options.userId);
  let runtimeSpaceOwnerUserId = normalizeUserId(options.spaceOwnerUserId);
  let runtimeModelRegistry = options.modelRegistry;
  let runtimeImageToTextConfig = options.imageToTextConfig ?? null;
  let runtimeTools = options.tools;
  let systemPromptStateKey: string | null = null;
  const sessionAffinity = options.sessionManager.getSessionAffinity();
  const getRuntime = () => ({
    modelRegistry: runtimeModelRegistry,
    imageToTextConfig: runtimeImageToTextConfig,
    sessionManager: options.sessionManager,
    userId: runtimeUserId,
    threadId: sessionAffinity.threadId,
  });
  const model = options.model ?? (sessionContext.model ? runtimeModelRegistry.find(sessionContext.model.provider, sessionContext.model.modelId) : undefined) ?? runtimeModelRegistry.getDefault();
  if (!model) {
    throw new Error("No model available. Check platform models.json");
  }

  const initialThinkingLevel = resolveThinkingLevelForModel(model, sessionContext.thinkingLevel);

  if (sessionContext.messages.length === 0) {
    options.sessionManager.appendModelChange(model.provider, model.id);
    options.sessionManager.appendThinkingLevelChange(initialThinkingLevel);
  } else if (sessionContext.thinkingLevel == null) {
    options.sessionManager.appendThinkingLevelChange(initialThinkingLevel);
  }

  const systemPromptStateKeyFor = (userId: string | null, spaceOwnerUserId: string | null, tools: ToolLike[]) => `${userId ?? ""}\0${shouldIncludeUserSkills(userId, spaceOwnerUserId) ? "user-skills" : "no-user-skills"}\0${toolsStateKey(tools)}`;

  const buildSystemPromptForTools = (tools: ToolLike[], input?: { userId?: string | null; spaceOwnerUserId?: string | null }) => {
    const userId = input && "userId" in input ? normalizeUserId(input.userId) : runtimeUserId;
    const spaceOwnerUserId = input && "spaceOwnerUserId" in input ? normalizeUserId(input.spaceOwnerUserId) : runtimeSpaceOwnerUserId;
    return buildCohubSystemPrompt({
      cwd: options.cwd,
      userId,
      selectedTools: tools.map((tool) => tool.name),
      toolSnippets: Object.fromEntries(tools.map((tool) => [tool.name, toolSnippets(tool.name)]).filter((entry): entry is [string, string] => Boolean(entry[1]))),
      spaceMods: options.spaceMods ?? [],
      includeUserSkills: shouldIncludeUserSkills(userId, spaceOwnerUserId),
    });
  };

  const systemPrompt = await buildSystemPromptForTools(runtimeTools);
  systemPromptStateKey = systemPromptStateKeyFor(runtimeUserId, runtimeSpaceOwnerUserId, runtimeTools);

  const agent = new PiAgent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: initialThinkingLevel,
      tools: runtimeTools as never,
      messages: sessionContext.messages,
    },
    steeringMode: "all",
    sessionId: sessionAffinity.sessionId,
    convertToLlm: toLlmMessages,
    streamFn: createStreamFn(getRuntime),
    getApiKey: (provider: string) => runtimeModelRegistry.getApiKey(provider),
    async afterToolCall({ result }) {
      if (isToolFailureDetails(result.details)) return { isError: true };
      const details = result.details as Record<string, unknown> | undefined;
      const termination = details?.termination as Record<string, unknown> | undefined;
      if (termination?.reason === "timed_out" || termination?.reason === "aborted" || details?.outputTruncated === true || termination?.outputTruncated === true) return { isError: true };
      return undefined;
    },
  });

  const configureToolsState = async (tools: ToolLike[], options?: { force?: boolean }) => {
    const nextKey = systemPromptStateKeyFor(runtimeUserId, runtimeSpaceOwnerUserId, tools);
    if (!options?.force && systemPromptStateKey === nextKey) {
      runtimeTools = tools;
      agent.state.tools = tools as never;
      return;
    }
    const nextSystemPrompt = await buildSystemPromptForTools(tools);
    runtimeTools = tools;
    agent.state.systemPrompt = nextSystemPrompt;
    systemPromptStateKey = nextKey;
    agent.state.tools = tools as never;
  };

  let lastAssistantMessage: AssistantMessage | undefined;
  let retryAttempt = 0;
  let retryCancelled = false;
  let retryPending = false;
  let retryInProgress = false;
  let retryRunPromise: Promise<void> | null = null;
  let retryContext: ToolExecutionContext | null = null;
  let retryDelayMs = AGENT_RETRY_BASE_DELAY_MS;
  let forcedCompactionPending = false;
  let toolCallLoopGuardState = EMPTY_TOOL_CALL_LOOP_GUARD_STATE;

  const clearRetryState = () => {
    retryAttempt = 0;
    retryPending = false;
    retryInProgress = false;
    retryRunPromise = null;
    retryCancelled = false;
    retryContext = null;
    retryDelayMs = AGENT_RETRY_BASE_DELAY_MS;
    forcedCompactionPending = false;
  };

  const getRecentMessageRoles = () => agent.state.messages.slice(-8).map((message) => message.role).join(",");

  const runPendingRetries = async () => {
    if (retryRunPromise) return retryRunPromise;
    if (!retryPending) return;

    retryRunPromise = (async () => {
      while (retryPending) {
        const attempt = retryAttempt;
        const contextSnapshot = retryContext ?? getCurrentToolExecutionContext();
        const delayMs = retryDelayMs;
        retryPending = false;
        retryInProgress = true;

        if (delayMs > 0) await sleep(delayMs);
        if (retryCancelled) {
          clearRetryState();
          return;
        }

        const run = async () => {
          logger.info(`[AgentRetry] continue:start sessionId=${getCurrentToolExecutionContext()?.sessionId ?? "unknown"} turnId=${getCurrentToolExecutionContext()?.turnId ?? "unknown"} attempt=${attempt} forceCompact=${forcedCompactionPending} roles=${getRecentMessageRoles()}`);
          await agent.continue();
          await agent.waitForIdle();
        };

        try {
          if (contextSnapshot) {
            await runWithToolExecutionContext(contextSnapshot, run);
          } else {
            await run();
          }
        } catch (error) {
          const normalized = error instanceof Error ? error : new Error(String(error));
          logger.error("[AgentRetry] continue:failed", {
            sessionId: contextSnapshot?.sessionId ?? getCurrentToolExecutionContext()?.sessionId ?? "unknown",
            turnId: contextSnapshot?.turnId ?? getCurrentToolExecutionContext()?.turnId ?? null,
            retryAttempt: attempt,
            retryCancelled,
            agentIsStreaming: agent.state.isStreaming,
            recentRoles: getRecentMessageRoles(),
            errorName: normalized.name,
            errorMessage: normalized.message,
            stack: normalized.stack,
          });
          clearRetryState();
          throw normalized;
        } finally {
          retryInProgress = false;
        }
      }
    })();

    try {
      await retryRunPromise;
    } finally {
      retryRunPromise = null;
    }
  };

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (event.type === "message_end") {
      const message = event.message as { role?: string };
      if (message.role === "assistant") {
        const assistantMessage = event.message as AssistantMessage;
        lastAssistantMessage = assistantMessage;
        const toolContext = getCurrentToolExecutionContext();
        const loopGuard = observeToolCallBatch(toolCallLoopGuardState, {
          turnId: toolContext?.turnId ?? null,
          message: assistantMessage,
        });
        toolCallLoopGuardState = loopGuard.state;
        if (loopGuard.shouldIntervene) {
          logger.warn("[ToolCallLoopGuard] repeated tool-call batch detected", {
            sessionId: toolContext?.sessionId ?? "unknown",
            turnId: toolContext?.turnId ?? null,
            threshold: TOOL_CALL_LOOP_GUARD_THRESHOLD,
          });
          agent.steer(createUserMessage(TOOL_CALL_LOOP_GUARD_PROMPT, undefined, {
            internal: true,
            source: "tool_call_loop_guard",
          }));
        }
        const retryOutcome = getAssistantRetryOutcome(assistantMessage, retryAttempt);
        const sessionId = getCurrentToolExecutionContext()?.sessionId ?? "unknown";
        const turnId = getCurrentToolExecutionContext()?.turnId ?? undefined;
        logAssistantRetry(sessionId, turnId, retryOutcome);
        recordAssistantRetrySpanAttributes(trace.getActiveSpan(), retryOutcome);
        if (!retryOutcome.shouldRetry) {
          const entryId = options.sessionManager.appendMessage(event.message as never);
          (event.message as unknown as Record<string, unknown>).sessionEntryId = entryId;
        }
        if (shouldResetAssistantRetryState(assistantMessage)) {
          clearRetryState();
        }
      } else if (message.role === "user" || message.role === "toolResult") {
        if (message.role === "user") {
          toolCallLoopGuardState = EMPTY_TOOL_CALL_LOOP_GUARD_STATE;
        }
        const entryId = options.sessionManager.appendMessage(event.message as never);
        (event.message as unknown as Record<string, unknown>).sessionEntryId = entryId;
      }
      return;
    }

    if (event.type === "agent_end" && lastAssistantMessage) {
      const assistantMessage = lastAssistantMessage;
      lastAssistantMessage = undefined;
      const retryOutcome = getAssistantRetryOutcome(assistantMessage, retryAttempt);
      if (retryOutcome.shouldRetry) {
        retryAttempt = retryOutcome.retryAttempt;
        retryDelayMs = retryOutcome.retryDelayMs ?? AGENT_RETRY_BASE_DELAY_MS;
        if (retryOutcome.forceCompaction) forcedCompactionPending = true;
        retryPending = true;
        const currentContext = getCurrentToolExecutionContext();
        retryContext = currentContext ? { ...currentContext } : retryContext;

        const messages = agent.state.messages;
        if (messages.length > 0 && messages[messages.length - 1]?.role === "assistant") {
          agent.state.messages = messages.slice(0, -1);
        }
        return;
      }

      clearRetryState();
    }
  });

  const session: CohubAgentSession = {
    agent,
    get modelRegistry() {
      return runtimeModelRegistry;
    },
    sessionManager: options.sessionManager,
    get isStreaming() {
      return agent.state.isStreaming;
    },
    get isRetrying() {
      return retryPending || retryInProgress || retryRunPromise !== null;
    },
    shouldDeferErrorPersistence(message) {
      const assistantMessage = message as unknown as AssistantMessage;
      return isRetryableAssistantFailure(assistantMessage)
        && retryAttempt < AGENT_RETRY_MAX_RETRIES;
    },
    consumePendingForcedCompaction() {
      if (!forcedCompactionPending) return false;
      forcedCompactionPending = false;
      return true;
    },
    async prompt(text, inputOptions) {
      await agent.prompt(text, inputOptions?.images);
      await agent.waitForIdle();
      await runPendingRetries();
      await agent.waitForIdle();
    },
    async promptMessages(messages) {
      await agent.prompt(messages);
      await agent.waitForIdle();
      await runPendingRetries();
      await agent.waitForIdle();
    },
    async steer(text, images) {
      agent.steer(createUserMessage(text, images));
      await agent.waitForIdle();
    },
    enqueueSteer(text, images) {
      agent.steer(createUserMessage(text, images));
    },
    async waitForIdle() {
      await agent.waitForIdle();
      await runPendingRetries();
      await agent.waitForIdle();
    },
    async setModel(nextModel) {
      const nextThinkingLevel = resolveThinkingLevelForModel(nextModel as CohubModel, agent.state.thinkingLevel);
      agent.state.model = nextModel;
      agent.state.thinkingLevel = nextThinkingLevel;
      options.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
      options.sessionManager.appendThinkingLevelChange(nextThinkingLevel);
    },
    async configureRuntimeIdentity(input) {
      const nextUserId = normalizeUserId(input.userId);
      const nextSpaceOwnerUserId = normalizeUserId(input.spaceOwnerUserId) ?? runtimeSpaceOwnerUserId;
      const currentModel = agent.state.model;
      const requested = input.requestedModel
        ? input.modelRegistry.find(input.requestedModel.provider, input.requestedModel.id)
        : undefined;
      if (input.requestedModel && !requested) {
        throw new ModelUnavailableError(input.requestedModel.provider, input.requestedModel.id);
      }
      const target = requested
        ?? input.modelRegistry.find(currentModel.provider, currentModel.id)
        ?? input.modelRegistry.getDefault();
      if (!target) throw new Error("No model available. Check platform models.json");

      const nextKey = systemPromptStateKeyFor(nextUserId, nextSpaceOwnerUserId, runtimeTools);
      const nextSystemPrompt = systemPromptStateKey === nextKey
        ? agent.state.systemPrompt
        : await buildSystemPromptForTools(runtimeTools, { userId: nextUserId, spaceOwnerUserId: nextSpaceOwnerUserId });
      const shouldChangeModel = target.provider !== currentModel.provider || target.id !== currentModel.id;
      const hasRequestedThinkingLevel = input.requestedThinkingLevel !== undefined && input.requestedThinkingLevel !== null;
      const nextThinkingLevel = hasRequestedThinkingLevel
        ? resolveThinkingLevelForModel(target as CohubModel, input.requestedThinkingLevel)
        : shouldChangeModel
          ? resolveThinkingLevelForModel(target as CohubModel, agent.state.thinkingLevel)
          : agent.state.thinkingLevel;

      runtimeUserId = nextUserId;
      runtimeSpaceOwnerUserId = nextSpaceOwnerUserId;
      runtimeModelRegistry = input.modelRegistry;
      runtimeImageToTextConfig = input.imageToTextConfig ?? null;
      agent.state.systemPrompt = nextSystemPrompt;
      systemPromptStateKey = nextKey;
      const shouldChangeThinkingLevel = nextThinkingLevel !== agent.state.thinkingLevel;
      if (shouldChangeModel) {
        agent.state.model = target;
        options.sessionManager.appendModelChange(target.provider, target.id);
      }
      if (shouldChangeModel || shouldChangeThinkingLevel) {
        agent.state.thinkingLevel = nextThinkingLevel;
        options.sessionManager.appendThinkingLevelChange(nextThinkingLevel);
      }
      agent.state.tools = runtimeTools as never;
    },
    async configureTools(tools) {
      await configureToolsState(tools);
    },
    async reload() {
      await configureToolsState(options.tools, { force: true });
    },
    async abort() {
      retryCancelled = true;
      retryPending = false;
      agent.abort();
      await agent.waitForIdle();
      clearRetryState();
    },
    dispose() {
      unsubscribe();
      retryCancelled = true;
      retryPending = false;
      retryContext = null;
      retryAttempt = 0;
      retryInProgress = false;
      agent.abort();
    },
    subscribe(listener) {
      return agent.subscribe((event: AgentEvent) => {
        return listener(event);
      });
    },
  };

  return { session };
}
