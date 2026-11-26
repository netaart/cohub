import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { createAssistantMessageEventStream, type Api, type AssistantMessageEvent, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type TranscriptContext, toToolDeclaration, type AssistantMessage } from "@earendil-works/pi-ai";
import { context } from "@opentelemetry/api";
import { sumStatsUsage } from "@cohub/protocol/model";
import type { Usage } from "@cohub/protocol/core";
import { createRequestMetric, persistRequestMetric } from "../metrics.js";
import { logger } from "../logger.js";
import { sendOutput } from "../redis.js";
import type { SessionManager } from "./local-session-manager.js";
import type { CohubModelRegistry } from "./model-registry.js";
import { createModelsFromRegistry, streamSimpleWithModels } from "./pi-models-adapter.js";
import { recordLlmUsage, startLlmRoundSpan, getAgentTracer } from "@cohub/infra/tracing/agent";
import { getCurrentToolExecutionContext } from "../tool-context.js";
import { mergeHeaders } from "@cohub/infra/config-runtime/models";
import type { ImageToTextConfig } from "@cohub/infra/config-runtime/model-tasks";
import { prepareAgentImagesForModel } from "./image-to-text.js";
import { isContextOverflowFailure } from "./provider-errors.js";
import { observeContextOverflow } from "./token-calibration.js";
import { applyLlmRequestSizeGuard } from "./llm-messages.js";

export type ToolLike = AgentTool;

type WrapAssistantMessageStreamOptions = {
  model: Model<Api>;
  signal?: AbortSignal;
  onEvent?: (event: AssistantMessageEvent) => void | Promise<void>;
  onFailure?: (error: unknown) => void;
};

/**
 * A stopped Turn ends as aborted whatever surfaced the stop. Pi still starts the
 * next round after a tool returns on an aborted signal, and its setup rejects
 * with the abort reason but reports `error`.
 */
function settleAbortedFailure(event: AssistantMessageEvent, signal: AbortSignal | undefined): AssistantMessageEvent {
  if (event.type !== "error" || event.reason === "aborted" || !signal?.aborted) return event;
  return { type: "error", reason: "aborted", error: { ...event.error, stopReason: "aborted" } };
}

function emptyAssistantMessage(model: Model<Api>, stopReason: "aborted" | "error"): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function abortedAssistantStream(model: Model<Api>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  stream.push({ type: "error", reason: "aborted", error: emptyAssistantMessage(model, "aborted") });
  return stream;
}

export function wrapAssistantMessageStream(
  stream: AsyncIterable<AssistantMessageEvent>,
  options: WrapAssistantMessageStreamOptions,
): AssistantMessageEventStream {
  const wrapped = createAssistantMessageEventStream();
  let latestPartial: AssistantMessage | undefined;

  const pushFailure = async (error: unknown) => {
    options.onFailure?.(error);
    const reason: "aborted" | "error" = options.signal?.aborted ? "aborted" : "error";
    const failure: AssistantMessage = {
      ...(latestPartial ?? emptyAssistantMessage(options.model, reason)),
      stopReason: reason,
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    const event: AssistantMessageEvent = { type: "error", reason, error: failure };
    await options.onEvent?.(event);
    wrapped.push(event);
  };

  void (async () => {
    try {
      for await (const received of stream) {
        const event = settleAbortedFailure(received, options.signal);
        if ("partial" in event) latestPartial = event.partial;
        const observed = options.onEvent?.(event);
        if (observed) await observed;
        wrapped.push(event);
      }
    } catch (error) {
      await pushFailure(error);
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

export type StreamRuntime = {
  modelRegistry: CohubModelRegistry;
  imageToTextConfig: ImageToTextConfig | null;
  sessionManager: SessionManager;
  userId: string | null;
  threadId: string;
  systemPrompt: string;
  tools: ToolLike[];
};

/**
 * Pi (0.86+) carries the system prompt and tool declarations as transcript
 * system messages, while Cohub rebuilds the transcript from its session file
 * (no system messages) on every round and after compaction. The prompt and
 * tools are Cohub runtime state, so they are declared here, at the one exit
 * every agent request passes, instead of being kept alive in the transcript.
 * `toLlmMessages` already drops pi's transcript system messages; the filter
 * guarantees the declared prompt and tools are the only ones sent.
 */
function toRequestContext(ctx: TranscriptContext, runtime: StreamRuntime): Context {
  return {
    systemPrompt: runtime.systemPrompt,
    tools: runtime.tools.map(toToolDeclaration),
    messages: ctx.messages.filter((message) => message.role !== "system"),
  };
}

export function createStreamFn(getRuntime: () => StreamRuntime, shouldOmit: (message: AssistantMessage) => boolean): StreamFn {
  const tracer = getAgentTracer();

  return async (model: Model<Api>, transcript: TranscriptContext, options?: SimpleStreamOptions) => {
    const toolCtx = getCurrentToolExecutionContext();
    if (options?.signal?.aborted || toolCtx?.abortSignal?.aborted) return abortedAssistantStream(model);
    const runtime = getRuntime();
    const ctx = toRequestContext(transcript, runtime);
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
        const requestOptions = {
          ...options,
          threadId: runtime.threadId,
          imageInputCache: toolCtx?.imageInputCache,
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
        };
        const receipt = createRequestMetric(model.provider, model.id);
        if (prepared.calls.length) receipt.imageToText = {
          calls: prepared.calls.length,
          durationMs: prepared.calls.reduce((sum, call) => sum + call.durationMs, 0),
          usage: prepared.calls.reduce<Usage | null>((total, call) => sumStatsUsage(total, call.usage), null),
          unknownUsageCalls: prepared.calls.filter((call) => call.usage == null).length,
        };
        await persistRequestMetric(toolCtx?.turnId, receipt);
        receipt.startedAt = Date.now();
        const requestStarted = performance.now();
        let ended = false;
        const finishReceipt = async (message: AssistantMessage, status: "completed" | "failed" | "interrupted") => {
          if (ended) return;
          ended = true;
          receipt.completedAt = Date.now();
          receipt.durationMs = Math.max(0, performance.now() - requestStarted);
          receipt.status = status;
          // Error fallbacks often contain synthetic zero usage, not a provider report.
          receipt.usage = status === "completed" || (message.usage?.totalTokens ?? 0) > 0 ? message.usage : null;
          receipt.omitted = shouldOmit(message);
          if (receipt.firstTokenMs != null) receipt.outputDurationMs = Math.max(0, receipt.durationMs - receipt.firstTokenMs);
          const record = message as unknown as Record<string, unknown>;
          record.meta = { ...((record.meta as Record<string, unknown>) ?? {}), llmTiming: receipt };
          await persistRequestMetric(toolCtx?.turnId, receipt);
        };
        let stream: ReturnType<typeof streamSimpleWithModels>;
        try {
          stream = streamSimpleWithModels(models, model, requestContext, requestOptions);
        } catch (error) {
          receipt.completedAt = Date.now();
          receipt.durationMs = Math.max(0, performance.now() - requestStarted);
          receipt.status = options?.signal?.aborted ? "interrupted" : "failed";
          await persistRequestMetric(toolCtx?.turnId, receipt);
          throw error;
        }

        return wrapAssistantMessageStream(stream, {
          model,
          signal: options?.signal,
          onFailure: (error) => llmRound.fail(error),
          onEvent: (event) => {
            if ((event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") && event.delta.length > 0) {
              receipt.firstTokenMs ??= Math.max(0, performance.now() - requestStarted);
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
              return finishReceipt(event.message, "completed");
            } else if (event.type === "error") {
              attachImageToTextCalls(event.error, prepared.calls);
              if (isContextOverflowFailure(event.error)) {
                const overflow = observeContextOverflow(model, transcript.messages, event.error.errorMessage);
                llmRound.span.setAttribute("agent.context_overflow.estimated_tokens", overflow.estimatedTokens);
                if (overflow.actualTokens) llmRound.span.setAttribute("agent.context_overflow.actual_tokens", overflow.actualTokens);
                logger.warn(`[Agent] context overflow sessionId=${toolCtx?.sessionId ?? "unknown"} model=${model.provider}/${model.id} estimated=${overflow.estimatedTokens} actual=${overflow.actualTokens ?? "unknown"} limit=${overflow.limitTokens ?? "unknown"} ratio=${overflow.ratio?.toFixed(2) ?? "unknown"}`);
              }
              recordLlmUsage(llmRound.span, {
                inputTokens: event.error.usage?.input,
                outputTokens: event.error.usage?.output,
                totalTokens: event.error.usage?.totalTokens,
                cacheReadTokens: event.error.usage?.cacheRead,
                cacheWriteTokens: event.error.usage?.cacheWrite,
                cost: event.error.usage?.cost?.total,
              });
              llmRound.finish({ finishReason: event.reason, outcome: event.reason === "aborted" ? "aborted" : "error" });
              return finishReceipt(event.error, event.reason === "aborted" ? "interrupted" : "failed");
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
