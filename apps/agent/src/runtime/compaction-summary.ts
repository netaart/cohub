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

type RequestKind = "history" | "prefix";

export type SummaryStats = {
  requests: number;
  chunks: number;
  shrinks: number;
  overflows: number;
  omittedMessages: number;
  previousSummary: "none" | "kept" | "folded";
  /** Furthest degradation reached: none → chunked → recalibrated → omitted. */
  degradation: "none" | "chunked" | "recalibrated" | "omitted";
  ratio: number;
  lastOverflow?: { kind: RequestKind; estimatedTokens: number; actualTokens?: number; limitTokens?: number; error: string };
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
const OMITTED_OUTLINE_MAX_CHARS = 8_000;
// A fold summary may use at most half of the next request, so history always
// keeps room; output is bounded via maxTokens at a conservative chars/token.
const OUTPUT_CHARS_PER_TOKEN = 5;
const MIN_FOLD_RESERVE_TOKENS = 512;
// Unfolding repeats only after an overflow tightened the budget.
const MAX_SUMMARY_UNFOLDS = MAX_SHRINKS + 1;
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

function splitSummary(summary: string, maxChars: number): Message[] {
  const pieces: string[] = [];
  let current = "";
  for (const line of summary.split("\n")) {
    for (let start = 0; start < Math.max(1, line.length); start += maxChars) {
      const part = line.slice(start, start + maxChars);
      if (current && current.length + part.length + 1 > maxChars) {
        pieces.push(current);
        current = "";
      }
      current = current ? `${current}\n${part}` : part;
    }
  }
  if (current) pieces.push(current);
  return pieces.map((text, index) => ({
    role: "user",
    content: [{ type: "text", text: `[Earlier context summary, part ${index + 1}/${pieces.length}]\n${text}` }],
    timestamp: 0,
  }));
}

const serializedChars = (message: Message) => serializeConversation([message]).length + 2;

/** Bound one message to `maxChars` serialized, keeping its role so the summarizer knows who acted. */
function shrinkMessage(message: Message, maxChars: number): Message {
  const limit = Math.max(0, maxChars - 64);
  if (message.role !== "assistant") {
    return { ...message, content: [{ type: "text", text: contentToText(message.content, limit) }] } as Message;
  }
  const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
  const toolCalls = message.content.filter((block) => block.type === "toolCall");
  const argCount = toolCalls.reduce((count, call) => count + Math.max(1, Object.keys(call.arguments ?? {}).length), 0);
  const perArgument = Math.max(64, Math.floor(limit / (2 * Math.max(1, argCount))));
  const bounded: Message = {
    ...message,
    content: [
      ...(text ? [{ type: "text" as const, text: truncateMiddle(text, Math.floor(limit / 2)) }] : []),
      ...toolCalls.map((call) => ({
        ...call,
        arguments: Object.fromEntries(
          Object.entries(call.arguments ?? {}).map(([key, value]) => [key, truncateMiddle(typeof value === "string" ? value : safeJson(value), perArgument)]),
        ),
      })),
    ],
  };
  if (serializedChars(bounded) <= maxChars) return bounded;
  // Too many tool calls to list: keep the text and a tally of the calls.
  const tally = new Map<string, number>();
  for (const call of toolCalls) tally.set(call.name, (tally.get(call.name) ?? 0) + 1);
  const toolLine = `[${toolCalls.length} tool calls: ${formatTools(tally)}]`;
  return { ...message, content: [{ type: "text", text: truncateMiddle(text ? `${text}\n${toolLine}` : toolLine, limit) }] };
}

function oneLine(text: string, maxChars: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

type OmittedTurn = { headline: string; tools: Map<string, number> };

function omittedTurns(messages: readonly Message[]): OmittedTurn[] {
  const turns: OmittedTurn[] = [];
  for (const message of messages) {
    if (message.role === "user" || turns.length === 0) {
      const text = message.role === "user" ? contentToText(message.content, 2_000) : "";
      turns.push({ headline: oneLine(text, 300), tools: new Map() });
    }
    const turn = turns[turns.length - 1];
    if (turn && message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") turn.tools.set(block.name, (turn.tools.get(block.name) ?? 0) + 1);
      }
    }
  }
  return turns;
}

const formatTools = (tools: Map<string, number>) =>
  [...tools].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(", ");

/**
 * Every omitted turn with its tool usage. Past the size cap, consecutive turns
 * are grouped into ranges (tool counts aggregated) rather than cut off.
 */
export function outlineOmittedMessages(messages: readonly Message[]): string {
  const turns = omittedTurns(messages);
  const render = (headlineChars: number, groupSize: number) => {
    const lines: string[] = [];
    for (let start = 0; start < turns.length; start += groupSize) {
      const group = turns.slice(start, start + groupSize);
      const tools = new Map<string, number>();
      for (const turn of group) for (const [name, count] of turn.tools) tools.set(name, (tools.get(name) ?? 0) + count);
      const label = group.length > 1 ? `Turns ${start + 1}–${start + group.length}` : `Turn ${start + 1}`;
      const headline = oneLine(group.find((turn) => turn.headline)?.headline ?? "", headlineChars);
      lines.push(`- ${label}${headline ? `: ${headline}` : ""}${tools.size ? ` (tools: ${formatTools(tools)})` : ""}`);
    }
    return lines.join("\n");
  };
  let body = render(300, 1);
  if (body.length > OMITTED_OUTLINE_MAX_CHARS) body = render(80, 1);
  for (let groupSize = 2; body.length > OMITTED_OUTLINE_MAX_CHARS && groupSize < turns.length; groupSize *= 2) {
    body = render(80, groupSize);
  }
  return [
    "## Omitted History",
    `${messages.length} older messages could not be summarized and are only outlined here. The full transcript remains in the session archive.`,
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

/** Same tags pi's `compact()` appends, for summaries finished without it. */
function formatFileLists({ readFiles, modifiedFiles }: ReturnType<typeof fileLists>) {
  const sections = [
    ...(readFiles.length ? [`<read-files>\n${readFiles.join("\n")}\n</read-files>`] : []),
    ...(modifiedFiles.length ? [`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`] : []),
  ];
  return sections.length ? `\n\n${sections.join("\n\n")}` : "";
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
 * - A running summary that leaves no room for the next message is split back into
 *   history pieces and folded like any other history.
 * - Overflow anyway: recalibrate from the provider's reported size; the rejected
 *   request's next attempt is always strictly smaller.
 * - Still overflowing after MAX_SHRINKS, or no room left for any history: omit the
 *   oldest history (outlined in the summary), or move the split-turn prefix into
 *   history. Every failed attempt removes input from the failed request, so the
 *   loop always terminates.
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
  // Transient provider errors are retried per call, so a split turn never replays
  // its already successful history request. Overflow is never retried here.
  const models = new Proxy(input.models, {
    get(target, property, receiver) {
      if (property !== "completeSimple") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<typeof target.completeSimple>) => {
        for (let attempt = 0; ; attempt++) {
          providerCalls.total += 1;
          lastResponse = undefined;
          let response: AssistantMessage;
          try {
            response = await target.completeSimple(...args);
          } catch (error) {
            providerCalls.failed += 1;
            throw error;
          }
          lastResponse = response;
          if (response.stopReason !== "error" && response.stopReason !== "aborted") {
            providerCalls.succeeded += 1;
            return response;
          }
          providerCalls.failed += 1;
          const retryable = response.stopReason === "error"
            && !isContextOverflowFailure(response)
            && isRetryableProviderError(response);
          if (!retryable || attempt >= MAX_TRANSIENT_RETRIES || abortSignal?.aborted) return response;
          await sleep(TRANSIENT_RETRY_DELAY_MS);
        }
      };
    },
  });

  const reserveTokens = preparation.settings.reserveTokens;
  const maxOutputTokens = Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
  let contextWindow = model.contextWindow;
  let ratio = getTokenRatio("summary", model) ?? DEFAULT_SUMMARY_RATIO;
  // Total-request ceilings set by rejected requests, per request kind: a retry of
  // the rejected request is strictly smaller even when the configured window
  // overstates what the provider accepts.
  const ceilingChars: Record<RequestKind, number> = { history: Number.POSITIVE_INFINITY, prefix: Number.POSITIVE_INFINITY };

  const history = projectForSummary(preparation.messagesToSummarize);
  const prefix = preparation.isSplitTurn ? projectForSummary(preparation.turnPrefixMessages) : [];
  const originals = [...history, ...prefix];
  const sequence = [...originals];
  let prefixStart = history.length;
  const sizes = sequence.map(serializedChars);
  const size = (index: number) => sizes[index] ?? 0;

  let cursor = 0;
  let running = preparation.previousSummary;
  let unfolds = 0;
  let usage: Usage | undefined;
  let omittedCount = 0;
  const omitted: Message[] = [];
  const stats: SummaryStats = {
    requests: 0,
    chunks: 0,
    shrinks: 0,
    overflows: 0,
    omittedMessages: 0,
    previousSummary: running ? "kept" : "none",
    degradation: "none",
    ratio,
  };
  let attemptCount = 0;

  const done = (result: SummaryOutcome["result"]): SummaryOutcome => {
    stats.omittedMessages = omittedCount;
    stats.ratio = ratio;
    stats.degradation = omittedCount > 0
      ? "omitted"
      : stats.shrinks > 0
        ? "recalibrated"
        : stats.chunks > 0
          ? "chunked"
          : "none";
    return { result, attemptCount, providerCalls, stats };
  };
  const fail = (message: string) => done({ ok: false, error: new Error(message) });
  const omit = (start: number, end: number) => {
    omitted.push(...originals.slice(start, end));
    omittedCount += end - start;
  };
  const withOmitted = (summary: string) => (omitted.length ? `${summary}\n\n${outlineOmittedMessages(omitted)}` : summary);
  const requestBudgetChars = (kind: RequestKind) =>
    Math.min(Math.floor(((contextWindow - maxOutputTokens) * 4) / ratio), ceilingChars[kind]) - PROMPT_OVERHEAD_CHARS;
  const estimateTokens = (chars: number) => Math.ceil((chars + PROMPT_OVERHEAD_CHARS) / 4);

  for (;;) {
    if (cursor >= sequence.length) {
      return done({
        ok: true,
        value: {
          summary: withOmitted(running ?? PI_EMPTY_HISTORY_TEXT) + formatFileLists(fileLists(preparation.fileOps)),
          tokensBefore: preparation.tokensBefore,
          usage,
          retainedTail: preparation.retainedTail,
          details: fileLists(preparation.fileOps),
        },
      });
    }
    // Every request either makes progress or is one of a bounded number of retries.
    if (stats.requests >= 2 * sequence.length + MAX_SHRINKS + MAX_SUMMARY_UNFOLDS + 8) {
      return fail("Summarization failed: request limit reached");
    }

    const fullBudget = requestBudgetChars("history");
    // A running summary (e.g. from a larger-window model, or a budget tightened by
    // overflow) that crowds out history is folded back in as history, not cut.
    if (running && running.length > fullBudget / 2 && unfolds < MAX_SUMMARY_UNFOLDS) {
      unfolds += 1;
      const pieces = splitSummary(running, Math.max(MIN_CHUNK_CHARS, Math.floor(fullBudget / 2)));
      sequence.splice(cursor, 0, ...pieces);
      originals.splice(cursor, 0, ...pieces);
      sizes.splice(cursor, 0, ...pieces.map(serializedChars));
      prefixStart = Math.max(prefixStart, cursor) + pieces.length;
      running = undefined;
      stats.previousSummary = "folded";
      continue;
    }

    const historyBudget = fullBudget - (running?.length ?? 0);
    if (historyBudget < MIN_CHUNK_CHARS) {
      // In practice only after overflows tightened the budget: keep what is summarized, outline the rest.
      omit(cursor, sequence.length);
      cursor = sequence.length;
      continue;
    }
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
      const prefixBudget = requestBudgetChars("prefix");
      let used = 0;
      while (tailStart > Math.max(prefixStart, cursor) && used + size(tailStart - 1) <= prefixBudget) {
        tailStart -= 1;
        used += size(tailStart);
      }
    }
    const isFinal = sum(sizes, cursor, tailStart) <= historyBudget;
    let end = tailStart;
    if (!isFinal) {
      end = cursor;
      let used = 0;
      while (end < tailStart && used + size(end) <= historyBudget) {
        used += size(end);
        end += 1;
      }
      end = Math.max(end, cursor + 1);
    }

    const chunk = sequence.slice(cursor, end) as AgentMessage[];
    const requestChars: Record<RequestKind, number> = {
      history: sum(sizes, cursor, end) + (running?.length ?? 0) + PROMPT_OVERHEAD_CHARS,
      prefix: sum(sizes, tailStart, sequence.length) + PROMPT_OVERHEAD_CHARS,
    };
    stats.requests += 1;
    attemptCount += 1;

    let failure: string;
    let failedKind: RequestKind = "history";
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
          ratio = observeTokenRatio("summary", model, estimateTokens(requestChars.history - PROMPT_OVERHEAD_CHARS), inputTokensOf(result.value.usage)) ?? ratio;
        }
        return done({
          ok: true,
          value: { ...result.value, summary: withOmitted(summary), usage: addUsage(usage, result.value.usage) },
        });
      }
      failure = result.error.message;
      if (failure.startsWith("Turn prefix")) failedKind = "prefix";
    } else {
      const result = await generateSummaryWithUsage(
        chunk,
        models,
        model,
        Math.max(MIN_FOLD_RESERVE_TOKENS, Math.min(reserveTokens, Math.floor(fullBudget / 2 / OUTPUT_CHARS_PER_TOKEN / 0.8))),
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
        const learned = observeTokenRatio("summary", model, estimateTokens(requestChars.history - PROMPT_OVERHEAD_CHARS), inputTokensOf(result.value.usage));
        if (learned !== undefined && stats.shrinks === 0) ratio = learned;
        continue;
      }
      failure = result.error.message;
    }

    if (abortSignal?.aborted || lastResponse?.stopReason === "aborted") return fail(failure);
    if (!lastResponse || !isContextOverflowFailure(lastResponse)) return fail(failure);

    const failedChars = requestChars[failedKind];
    const failedEstimate = estimateTokens(failedChars - PROMPT_OVERHEAD_CHARS);
    const parsed = parseOverflowTokens(lastResponse.errorMessage);
    stats.overflows += 1;
    stats.lastOverflow = {
      kind: failedKind,
      estimatedTokens: failedEstimate,
      actualTokens: parsed?.actual,
      limitTokens: parsed?.limit,
      error: failure.slice(0, 500),
    };

    if (stats.shrinks < MAX_SHRINKS) {
      stats.shrinks += 1;
      if (parsed?.limit && parsed.limit < contextWindow) contextWindow = parsed.limit;
      if (parsed) {
        observeTokenRatio("summary", model, failedEstimate, parsed.actual, { overflow: true });
        ratio = Math.max(ratio, parsed.actual / failedEstimate);
      }
      const scale = parsed ? ((parsed.limit ?? contextWindow) - maxOutputTokens) / parsed.actual : UNKNOWN_OVERFLOW_SCALE;
      ceilingChars[failedKind] = Math.min(ceilingChars[failedKind], Math.floor(failedChars * Math.min(MAX_OVERFLOW_SCALE, scale * 0.95)));
      continue;
    }
    if (failedKind === "prefix") {
      // Halving the prefix request moves its oldest messages into history.
      ceilingChars.prefix = Math.floor(failedChars / 2);
      continue;
    }
    const dropEnd = isFinal ? cursor + Math.max(1, Math.ceil((tailStart - cursor) / 2)) : end;
    omit(cursor, dropEnd);
    cursor = dropEnd;
  }
}
