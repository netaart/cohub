import {
  BACKGROUND_CONTEXT,
  compact,
  convertToLlm,
  generateSummaryWithUsage,
  serializeConversation,
  withAbortSignal,
  type AgentMessage,
} from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model, Models, ToolCall, Usage } from "@earendil-works/pi-ai";
import { IMAGE_URL_MIME_TYPE } from "@cohub/protocol/core";
import { isContextOverflowFailure, isRetryableProviderError } from "./provider-errors.js";
import { getTokenRatio, observeTokenRatio, parseOverflowTokens } from "./token-calibration.js";

type CompactionPreparation = Parameters<typeof compact>[0];
type CompactResultValue = Extract<Awaited<ReturnType<typeof compact>>, { ok: true }>["value"];

type ProviderCallStats = { total: number; succeeded: number; failed: number };

export type SummaryStats = {
  requests: number;
  chunks: number;
  shrinks: number;
  omittedMessages: number;
  ratio: number;
};

export type SummaryOutcome = {
  result: { ok: true; value: CompactResultValue } | { ok: false; error: Error };
  attemptCount: number;
  providerCalls: ProviderCallStats;
  stats: SummaryStats;
};

const TOOL_RESULT_MAX_CHARS = 2_000;
const TOOL_ARGUMENT_MAX_CHARS = 2_000;
const MESSAGE_TEXT_MAX_CHARS = 20_000;
// System prompt, instructions and XML wrappers around the serialized transcript.
const PROMPT_OVERHEAD_CHARS = 4_000;
const MIN_CHUNK_CHARS = 2_000;
// Serialized transcripts tokenize denser than chars/4 on most providers; used
// only until a real sample for the model exists.
const DEFAULT_SUMMARY_RATIO = 1.5;
const MAX_SHRINKS = 3;
const MAX_OVERFLOW_SCALE = 0.9;
const UNKNOWN_OVERFLOW_SCALE = 0.6;
const MAX_TRANSIENT_RETRIES = 1;
const TRANSIENT_RETRY_DELAY_MS = 1_000;
const MAX_FOLD_CHUNKS = 8;
const MAX_REQUESTS = 32;
const OMITTED_OUTLINE_MAX_CHARS = 8_000;
// pi's split-turn summary starts with this when it was given no history messages.
const PI_EMPTY_HISTORY_TEXT = "No prior history.";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const marker = `\n[... ${text.length - maxChars} characters omitted ...]\n`;
  const keep = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}${marker}${text.slice(text.length - (keep - head))}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "[unserializable]";
  }
}

function blockText(block: unknown): string | null {
  if (!block || typeof block !== "object") return null;
  const record = block as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") return record.text;
  if (record.type === "image") {
    return record.mimeType === IMAGE_URL_MIME_TYPE && typeof record.data === "string"
      ? `[image: ${record.data}]`
      : "[image]";
  }
  return null;
}

function contentToText(content: unknown, maxChars: number): string {
  if (typeof content === "string") return truncateMiddle(content, maxChars);
  if (!Array.isArray(content)) return "";
  return truncateMiddle(content.map(blockText).filter((text) => text !== null).join("\n"), maxChars);
}

function projectArguments(args: unknown): ToolCall["arguments"] {
  if (!args || typeof args !== "object" || Array.isArray(args)) return {};
  return Object.fromEntries(Object.entries(args).map(([key, value]) => {
    if (typeof value === "string") return [key, truncateMiddle(value, TOOL_ARGUMENT_MAX_CHARS)];
    const json = safeJson(value);
    return [key, json.length > TOOL_ARGUMENT_MAX_CHARS ? truncateMiddle(json, TOOL_ARGUMENT_MAX_CHARS) : value];
  })) as ToolCall["arguments"];
}

function projectMessage(message: Message): Message {
  if (message.role === "user") {
    return { ...message, content: [{ type: "text", text: contentToText(message.content, MESSAGE_TEXT_MAX_CHARS) }] };
  }
  if (message.role === "toolResult") {
    return { ...message, content: [{ type: "text", text: contentToText(message.content, TOOL_RESULT_MAX_CHARS) }] };
  }
  if (message.role === "assistant") {
    const text = message.content
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n");
    const toolCalls = message.content.flatMap((block) =>
      block.type === "toolCall" ? [{ ...block, arguments: projectArguments(block.arguments) }] : [],
    );
    return {
      ...message,
      content: [...(text ? [{ type: "text" as const, text: truncateMiddle(text, MESSAGE_TEXT_MAX_CHARS) }] : []), ...toolCalls],
    };
  }
  return message;
}

/**
 * Summarizer view of the transcript: what happened, not how the model reasoned.
 * Thinking is dropped (providers do not replay it either), images become URL
 * references, and every text field is bounded. The session file is untouched.
 */
export function projectForSummary(messages: readonly AgentMessage[]): Message[] {
  return convertToLlm([...messages]).filter((message) => message.role !== "system").map(projectMessage);
}

const serializedChars = (message: Message) => serializeConversation([message]).length + 2;

function shrinkMessage(message: Message, maxChars: number): Message {
  const text = truncateMiddle(serializeConversation([message]), Math.max(0, maxChars - 16));
  return { role: "user", content: [{ type: "text", text }], timestamp: message.timestamp };
}

function oneLine(text: string, maxChars: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/** Turn headlines and tool usage of messages that could not be summarized. */
function outlineOmittedMessages(messages: readonly Message[]): string {
  const lines: string[] = [];
  let tools = new Map<string, number>();
  const flushTools = () => {
    if (tools.size === 0) return;
    lines.push(`  - Tools: ${[...tools].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ")}`);
    tools = new Map();
  };
  for (const message of messages) {
    if (message.role === "user") {
      flushTools();
      const text = contentToText(message.content, 2_000);
      if (text) lines.push(`- User: ${oneLine(text, 300)}`);
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") tools.set(block.name, (tools.get(block.name) ?? 0) + 1);
      }
    }
  }
  flushTools();
  const body = truncateMiddle(lines.join("\n"), OMITTED_OUTLINE_MAX_CHARS);
  return [
    "## Omitted History",
    `${messages.length} older messages were too large to summarize and are only outlined here. The full transcript remains in the session archive.`,
    body,
  ].filter(Boolean).join("\n");
}

function addUsage(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a || !b) return a ?? b;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    totalTokens: a.totalTokens + b.totalTokens,
    cost: {
      input: a.cost.input + b.cost.input,
      output: a.cost.output + b.cost.output,
      cacheRead: a.cost.cacheRead + b.cost.cacheRead,
      cacheWrite: a.cost.cacheWrite + b.cost.cacheWrite,
      total: a.cost.total + b.cost.total,
    },
  };
}

function fileLists(fileOps: CompactionPreparation["fileOps"]) {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  return {
    readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

const inputTokensOf = (usage: Usage | undefined) => (usage ? usage.input + usage.cacheRead + usage.cacheWrite : 0);

function sum(values: readonly number[], start: number, end: number) {
  let total = 0;
  for (let i = start; i < end; i++) total += values[i] ?? 0;
  return total;
}

/**
 * Summarize compaction history so that every provider request fits the
 * summarizer's own window, however long the session is.
 *
 * - Fits in one request: identical to pi's `compact()` (one call, or two for a split turn).
 * - Otherwise: oldest chunks are folded into a rolling summary via pi's update prompt.
 * - Overflow anyway: recalibrate from the provider's reported size and retry smaller.
 * - Still overflowing after MAX_SHRINKS, or more history than MAX_FOLD_CHUNKS can
 *   cover: omit the oldest messages (outlined in the summary). Every failed
 *   attempt removes input, so the loop always terminates.
 */
export async function summarizeForCompaction(input: {
  preparation: CompactionPreparation;
  models: Models;
  model: Model<Api>;
  abortSignal?: AbortSignal;
}): Promise<SummaryOutcome> {
  const { preparation, model, abortSignal } = input;
  const context = abortSignal ? withAbortSignal(abortSignal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
  const providerCalls: ProviderCallStats = { total: 0, succeeded: 0, failed: 0 };
  let lastResponse: AssistantMessage | undefined;
  const models = new Proxy(input.models, {
    get(target, property, receiver) {
      if (property !== "completeSimple") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<typeof target.completeSimple>) => {
        providerCalls.total += 1;
        lastResponse = undefined;
        try {
          const response = await target.completeSimple(...args);
          lastResponse = response;
          if (response.stopReason === "error" || response.stopReason === "aborted") providerCalls.failed += 1;
          else providerCalls.succeeded += 1;
          return response;
        } catch (error) {
          providerCalls.failed += 1;
          throw error;
        }
      };
    },
  });

  const reserveTokens = preparation.settings.reserveTokens;
  const maxOutputTokens = Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
  let contextWindow = model.contextWindow;
  let ratio = getTokenRatio("summary", model) ?? DEFAULT_SUMMARY_RATIO;

  const history = projectForSummary(preparation.messagesToSummarize);
  const prefix = preparation.isSplitTurn ? projectForSummary(preparation.turnPrefixMessages) : [];
  const sequence = [...history, ...prefix];
  const prefixStart = history.length;
  const sizes = sequence.map(serializedChars);
  const size = (index: number) => sizes[index] ?? 0;

  let cursor = 0;
  let running = preparation.previousSummary;
  let usage: Usage | undefined;
  const omitted: Message[] = [];
  const stats: SummaryStats = { requests: 0, chunks: 0, shrinks: 0, omittedMessages: 0, ratio };
  let attemptCount = 0;
  let transientRetries = 0;

  const done = (result: SummaryOutcome["result"]): SummaryOutcome => {
    stats.omittedMessages = omitted.length;
    stats.ratio = ratio;
    return { result, attemptCount, providerCalls, stats };
  };
  const fail = (message: string) => done({ ok: false, error: new Error(message) });
  const withOmitted = (summary: string) => (omitted.length ? `${summary}\n\n${outlineOmittedMessages(omitted)}` : summary);
  // Request-size ceiling set by rejected requests: every retry is strictly smaller,
  // even when the configured window overstates what the provider accepts.
  let ceilingChars = Number.POSITIVE_INFINITY;
  const budgetChars = (summaryChars: number) =>
    Math.min(Math.floor(((contextWindow - maxOutputTokens) * 4) / ratio), ceilingChars) - PROMPT_OVERHEAD_CHARS - summaryChars;
  const estimateTokens = (chars: number) => Math.ceil((chars + PROMPT_OVERHEAD_CHARS) / 4);

  for (;;) {
    if (cursor >= sequence.length) {
      return done({
        ok: true,
        value: {
          summary: withOmitted(running ?? PI_EMPTY_HISTORY_TEXT),
          tokensBefore: preparation.tokensBefore,
          usage,
          retainedTail: preparation.retainedTail,
          details: fileLists(preparation.fileOps),
        },
      });
    }
    if (stats.requests >= MAX_REQUESTS) return fail("Summarization failed: request limit reached");

    const historyBudget = budgetChars(running?.length ?? 0);
    if (historyBudget < MIN_CHUNK_CHARS) return fail("Summarization failed: summarizer context window too small");
    for (let i = cursor; i < sequence.length; i++) {
      const message = sequence[i];
      if (message && size(i) > historyBudget) {
        const shrunk = shrinkMessage(message, historyBudget);
        sequence[i] = shrunk;
        sizes[i] = serializedChars(shrunk);
      }
    }

    // The split-turn prefix is summarized by its own request; keep the longest tail that fits.
    let tailStart = sequence.length;
    if (prefix.length > 0) {
      const prefixBudget = budgetChars(0);
      let used = 0;
      while (tailStart > Math.max(prefixStart, cursor) && used + size(tailStart - 1) <= prefixBudget) {
        tailStart -= 1;
        used += size(tailStart);
      }
    }
    const remainingEnd = tailStart;
    let remainingChars = sum(sizes, cursor, remainingEnd);
    const capacity = historyBudget * (MAX_FOLD_CHUNKS - stats.chunks + 1);
    while (cursor < remainingEnd - 1 && remainingChars > capacity) {
      remainingChars -= size(cursor);
      omitted.push(...sequence.slice(cursor, cursor + 1));
      cursor += 1;
    }
    const isFinal = remainingChars <= historyBudget;
    let end = remainingEnd;
    if (!isFinal) {
      end = cursor;
      let used = 0;
      while (end < remainingEnd && used + size(end) <= historyBudget) {
        used += size(end);
        end += 1;
      }
      end = Math.max(end, cursor + 1);
    }

    const chunk = sequence.slice(cursor, end) as AgentMessage[];
    const historyEstimate = estimateTokens(sum(sizes, cursor, end) + (running?.length ?? 0));
    const prefixEstimate = estimateTokens(sum(sizes, tailStart, sequence.length));
    stats.requests += 1;
    attemptCount += 1;

    let failure: string | undefined;
    let failedEstimate = historyEstimate;
    if (isFinal) {
      const tail = sequence.slice(tailStart) as AgentMessage[];
      const result = await compact(
        {
          ...preparation,
          messagesToSummarize: chunk,
          turnPrefixMessages: tail,
          isSplitTurn: tail.length > 0,
          previousSummary: running,
        },
        models,
        model,
        undefined,
        undefined,
        undefined,
        undefined,
        context,
      );
      if (result.ok) {
        let summary = result.value.summary;
        // pi drops previousSummary when a split turn has no history messages left.
        if (chunk.length === 0 && tail.length > 0 && running && summary.startsWith(PI_EMPTY_HISTORY_TEXT)) {
          summary = running + summary.slice(PI_EMPTY_HISTORY_TEXT.length);
        }
        if (tail.length === 0 && stats.shrinks === 0) {
          ratio = observeTokenRatio("summary", model, historyEstimate, inputTokensOf(result.value.usage)) ?? ratio;
        }
        return done({
          ok: true,
          value: { ...result.value, summary: withOmitted(summary), usage: addUsage(usage, result.value.usage) },
        });
      }
      failure = result.error.message;
      if (failure.startsWith("Turn prefix")) failedEstimate = prefixEstimate;
    } else {
      const result = await generateSummaryWithUsage(
        chunk,
        models,
        model,
        reserveTokens,
        undefined,
        running,
        undefined,
        undefined,
        undefined,
        context,
      );
      if (result.ok) {
        running = result.value.text;
        usage = addUsage(usage, result.value.usage);
        cursor = end;
        stats.chunks += 1;
        transientRetries = 0;
        const learned = observeTokenRatio("summary", model, historyEstimate, inputTokensOf(result.value.usage));
        if (learned !== undefined && stats.shrinks === 0) ratio = learned;
        continue;
      }
      failure = result.error.message;
    }

    if (abortSignal?.aborted || lastResponse?.stopReason === "aborted") return fail(failure);

    if (lastResponse && isContextOverflowFailure(lastResponse)) {
      transientRetries = 0;
      if (stats.shrinks < MAX_SHRINKS) {
        stats.shrinks += 1;
        const parsed = parseOverflowTokens(lastResponse.errorMessage);
        if (parsed?.limit && parsed.limit < contextWindow) contextWindow = parsed.limit;
        if (parsed) {
          observeTokenRatio("summary", model, failedEstimate, parsed.actual, { overflow: true });
          ratio = Math.max(ratio, parsed.actual / failedEstimate);
        }
        const scale = parsed ? ((parsed.limit ?? contextWindow) - maxOutputTokens) / parsed.actual : UNKNOWN_OVERFLOW_SCALE;
        ceilingChars = Math.min(ceilingChars, Math.floor(failedEstimate * 4 * Math.min(MAX_OVERFLOW_SCALE, scale * 0.95)));
        continue;
      }
      const dropEnd = isFinal ? cursor + Math.max(1, Math.ceil((sequence.length - cursor) / 2)) : end;
      omitted.push(...sequence.slice(cursor, dropEnd));
      cursor = dropEnd;
      continue;
    }

    if (lastResponse && isRetryableProviderError(lastResponse) && transientRetries < MAX_TRANSIENT_RETRIES) {
      transientRetries += 1;
      await sleep(TRANSIENT_RETRY_DELAY_MS);
      continue;
    }
    return fail(failure);
  }
}
