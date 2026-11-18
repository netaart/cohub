/*
 * Session compaction from pi-agent-core 0.87.1, which pi-agent-core 1.0 removed. A bridge until Cohub
 * moves to the compaction pi supports: keep its behaviour as is until then.
 *
 * Source: earendil-works/pi v0.87.1 (f07218c4d4bbc12bef056a7058c3dd49dfe41abe), packages/agent/src/
 * harness: compaction/compaction.ts, compaction/utils.ts, messages.ts, session/context.ts,
 * session/types.ts (Entry), types.ts (Result, CompactionError) and utils/usage.ts. Only what Cohub
 * calls is kept (no branch summarization, compactWithRequest or entry projectors). The message roles
 * of messages.ts live in agent-messages.ts: session files and restore depend on them, not on this
 * algorithm.
 *
 * Local changes:
 * - An AbortSignal replaces the chord Context; Cohub set no telemetry context.
 * - No retry policy or callbacks: Cohub passed none, which made each summary one provider call, and
 *   retries per call itself (compaction-summary.ts).
 * - compact() and generateSummaryWithUsage() take an options object instead of trailing positionals.
 * - CompactionError records which request failed (`request`); compaction-summary.ts reads it.
 * - Summed usage sets `cost.totalFromProvider` as pi-ai 1.x does.
 * - EMPTY_HISTORY_TEXT, computeFileLists and formatFileOperations are exported for
 *   compaction-summary.ts, which finishes summaries this module did not.
 *
 * Invariants:
 * - Persisted: compaction `details` stay `{ readFiles, modifiedFiles }`; the next compaction reads
 *   them back from the previous entry.
 * - A cut never lands on a tool result, which must follow its call in the kept history.
 * - compaction-summary.ts depends on EMPTY_HISTORY_TEXT, the file-list format and `request`;
 *   change them together.
 *
 * MIT License
 *
 * Copyright (c) 2025 Mario Zechner
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type Context as AiContext,
  type Api,
  type AssistantMessage,
  contentText,
  type JsonValue,
  type Message,
  type Model,
  type Models,
  type SimpleStreamOptions,
  type Usage,
  uuidv7,
} from "@earendil-works/pi-ai";
import {
  type BashExecutionMessage,
  type BranchSummaryMessage,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  type CompactionSummaryMessage,
} from "./agent-messages.js";

// ── Messages ───────────────────────────────────────────────────────────────

const BRANCH_SUMMARY_PREFIX = `The following is a summary of a branch that this conversation came back from:

<summary>
`;
const BRANCH_SUMMARY_SUFFIX = `</summary>`;

function bashExecutionToText(msg: BashExecutionMessage): string {
  let text = `Ran \`${msg.command}\`\n`;
  if (msg.output) {
    text += `\`\`\`\n${msg.output}\n\`\`\``;
  } else {
    text += "(no output)";
  }
  if (msg.cancelled) {
    text += "\n\n(command cancelled)";
  } else if (msg.exitCode !== null && msg.exitCode !== undefined && msg.exitCode !== 0) {
    text += `\n\nCommand exited with code ${msg.exitCode}`;
  }
  if (msg.truncated && msg.fullOutputPath) {
    text += `\n\n[Output truncated. Full output: ${msg.fullOutputPath}]`;
  }
  return text;
}

const toMillis = (timestamp: string | number) => (typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime());

function createBranchSummaryMessage(summary: string, fromId: string | null, timestamp: string | number): BranchSummaryMessage {
  return { role: "branchSummary", summary, fromId, timestamp: toMillis(timestamp) };
}

function createCompactionSummaryMessage(summary: string, tokensBefore: number, timestamp: string | number): CompactionSummaryMessage {
  return { role: "compactionSummary", summary, tokensBefore, timestamp: toMillis(timestamp) };
}

/** Project agent messages, including Cohub's custom roles, to the messages providers accept. */
export function convertToLlm(messages: AgentMessage[]): Message[] {
  return messages
    .map((m): Message | undefined => {
      switch (m.role) {
        case "bashExecution":
          if (m.excludeFromContext) return undefined;
          return { role: "user", content: [{ type: "text", text: bashExecutionToText(m) }], timestamp: m.timestamp };
        case "custom": {
          const content = typeof m.content === "string" ? [{ type: "text" as const, text: m.content }] : m.content;
          return { role: "user", content, timestamp: m.timestamp };
        }
        case "branchSummary":
          return {
            role: "user",
            content: [{ type: "text" as const, text: BRANCH_SUMMARY_PREFIX + m.summary + BRANCH_SUMMARY_SUFFIX }],
            timestamp: m.timestamp,
          };
        case "compactionSummary":
          return {
            role: "user",
            content: [{ type: "text" as const, text: COMPACTION_SUMMARY_PREFIX + m.summary + COMPACTION_SUMMARY_SUFFIX }],
            timestamp: m.timestamp,
          };
        case "system":
        case "user":
        case "assistant":
        case "toolResult":
          return m as Message;
        default:
          return undefined;
      }
    })
    .filter((m): m is Message => m !== undefined);
}

// ── Session entries ────────────────────────────────────────────────────────

interface EntryBase {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: number;
  customType?: string;
}

export interface MessageEntry extends EntryBase {
  type: "message";
  message: AgentMessage;
  terminate?: true;
}

export interface CompactionEntry extends EntryBase {
  type: "compaction";
  summary: string;
  retainedTail: AgentMessage[];
  tokensBefore: number;
  details?: JsonValue;
  usage?: Usage;
  fromHook: boolean;
}

export interface BranchSummaryEntry extends EntryBase {
  type: "branch_summary";
  fromId: string | null;
  summary: string;
  details?: JsonValue;
  usage?: Usage;
  fromHook: boolean;
}

export interface CustomEntry extends EntryBase {
  type: "custom";
  customType: string;
  data?: JsonValue;
}

export type Entry = MessageEntry | CompactionEntry | BranchSummaryEntry | CustomEntry;

function buildContextEntries(pathEntries: readonly Entry[]): Entry[] {
  for (let index = pathEntries.length - 1; index >= 0; index--) {
    const entry = pathEntries[index];
    if (entry?.type === "compaction") return [entry, ...pathEntries.slice(index + 1)];
  }
  return [...pathEntries];
}

function isContextMessage(message: AgentMessage): boolean {
  return message.role !== "assistant" || (message.stopReason !== "error" && message.stopReason !== "aborted" && message.stopReason !== "deferred");
}

function sessionEntryToContextMessages(entry: Entry): AgentMessage[] {
  switch (entry.type) {
    case "message":
      return isContextMessage(entry.message) ? [entry.message] : [];
    case "compaction":
      return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp), ...entry.retainedTail.filter(isContextMessage)];
    case "branch_summary":
      return entry.summary ? [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)] : [];
    case "custom":
      return [];
  }
}

// ── Results and usage ──────────────────────────────────────────────────────

export type Result<TValue, TError> = { ok: true; value: TValue } | { ok: false; error: TError };
const ok = <TValue, TError>(value: TValue): Result<TValue, TError> => ({ ok: true, value });
const err = <TValue, TError>(error: TError): Result<TValue, TError> => ({ ok: false, error });

export type CompactionErrorCode = "aborted" | "summarization_failed";
/** Which summary request failed: the history, or the prefix of a split turn. */
export type SummaryRequestKind = "history" | "prefix";

export class CompactionError extends Error {
  code: CompactionErrorCode;
  request: SummaryRequestKind;
  constructor(code: CompactionErrorCode, message: string, request: SummaryRequestKind) {
    super(message);
    this.name = "CompactionError";
    this.code = code;
    this.request = request;
  }
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    ...(left.cacheWrite1h === undefined && right.cacheWrite1h === undefined ? {} : { cacheWrite1h: (left.cacheWrite1h ?? 0) + (right.cacheWrite1h ?? 0) }),
    ...(left.reasoning === undefined && right.reasoning === undefined ? {} : { reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0) }),
    totalTokens: left.totalTokens + right.totalTokens,
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
      // A sum is provider-reported only when every part is.
      totalFromProvider: left.cost.totalFromProvider === true && right.cost.totalFromProvider === true,
    },
  };
}

// ── File operations ────────────────────────────────────────────────────────

interface FileOperations {
  read: Set<string>;
  written: Set<string>;
  edited: Set<string>;
}

const createFileOps = (): FileOperations => ({ read: new Set(), written: new Set(), edited: new Set() });

function extractFileOpsFromMessage(message: AgentMessage, fileOps: FileOperations): void {
  if (message.role !== "assistant") return;
  if (!("content" in message) || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (typeof block !== "object" || block === null) continue;
    if (!("type" in block) || block.type !== "toolCall") continue;
    if (!("arguments" in block) || !("name" in block)) continue;
    const args = block.arguments as Record<string, unknown> | undefined;
    if (!args) continue;
    const path = typeof args.path === "string" ? args.path : undefined;
    if (!path) continue;
    switch (block.name) {
      case "read":
        fileOps.read.add(path);
        break;
      case "write":
        fileOps.written.add(path);
        break;
      case "edit":
        fileOps.edited.add(path);
        break;
    }
  }
}

export function computeFileLists(fileOps: FileOperations): { readFiles: string[]; modifiedFiles: string[] } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readOnly = [...fileOps.read].filter((f) => !modified.has(f)).sort();
  return { readFiles: readOnly, modifiedFiles: [...modified].sort() };
}

/** The file lists appended to every summary; Cohub's own summaries append the same. */
export function formatFileOperations(readFiles: string[], modifiedFiles: string[]): string {
  const sections: string[] = [];
  if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
  if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
  if (sections.length === 0) return "";
  return `\n\n${sections.join("\n\n")}`;
}

function extractFileOperations(messages: AgentMessage[], entries: Entry[], prevCompactionIndex: number): FileOperations {
  const fileOps = createFileOps();
  if (prevCompactionIndex >= 0) {
    const prevCompaction = entries[prevCompactionIndex] as CompactionEntry;
    const details = prevCompaction.details;
    if (typeof details === "object" && details !== null && !Array.isArray(details)) {
      const { readFiles, modifiedFiles } = details as { readFiles?: unknown; modifiedFiles?: unknown };
      if (Array.isArray(readFiles)) for (const path of readFiles) if (typeof path === "string") fileOps.read.add(path);
      if (Array.isArray(modifiedFiles)) for (const path of modifiedFiles) if (typeof path === "string") fileOps.edited.add(path);
    }
  }
  for (const msg of messages) extractFileOpsFromMessage(msg, fileOps);
  return fileOps;
}

// ── Serialization ──────────────────────────────────────────────────────────

const TOOL_RESULT_MAX_CHARS = 2000;

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined";
  } catch {
    return "[unserializable]";
  }
}

function truncateForSummary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} more characters truncated]`;
}

/** Serialize LLM messages to plain text for summarization prompts. */
export function serializeConversation(messages: Message[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const content = contentText(msg.content, "");
      if (content) parts.push(`[User]: ${content}`);
    } else if (msg.role === "assistant") {
      const thinkingParts: string[] = [];
      const toolCalls: string[] = [];
      for (const block of msg.content) {
        if (block.type === "thinking") {
          thinkingParts.push(block.thinking);
        } else if (block.type === "toolCall") {
          const args = block.arguments as Record<string, unknown>;
          const argsStr = Object.entries(args)
            .map(([k, v]) => `${k}=${safeJsonStringify(v)}`)
            .join(", ");
          toolCalls.push(`${block.name}(${argsStr})`);
        }
      }
      if (thinkingParts.length > 0) parts.push(`[Assistant thinking]: ${thinkingParts.join("\n")}`);
      if (msg.content.some((block) => block.type === "text")) parts.push(`[Assistant]: ${contentText(msg.content)}`);
      if (toolCalls.length > 0) parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
    } else if (msg.role === "toolResult") {
      const content = contentText(msg.content, "");
      if (content) parts.push(`[Tool result]: ${truncateForSummary(content, TOOL_RESULT_MAX_CHARS)}`);
    }
  }
  return parts.join("\n\n");
}

// ── Token accounting ───────────────────────────────────────────────────────

export interface CompactionSettings {
  /** Enable automatic compaction decisions. */
  enabled: boolean;
  /** Tokens reserved for summary prompt and output. */
  reserveTokens: number;
  /** Approximate recent-context tokens to keep after compaction. */
  keepRecentTokens: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

/** Calculate total context tokens from provider usage. */
export function calculateContextTokens(usage: Usage): number {
  return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function getAssistantUsage(msg: AgentMessage): Usage | undefined {
  if (msg.role === "assistant" && "usage" in msg) {
    if (msg.stopReason !== "aborted" && msg.stopReason !== "error" && msg.usage && calculateContextTokens(msg.usage) > 0) return msg.usage;
  }
  return undefined;
}

export interface ContextUsageEstimate {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
}

/** Estimate context tokens for messages using provider usage when available. */
export function estimateContextTokens(messages: AgentMessage[]): ContextUsageEstimate {
  let usageInfo: { usage: Usage; index: number } | undefined;
  for (let i = messages.length - 1; i >= 0 && !usageInfo; i--) {
    const message = messages[i];
    const usage = message && getAssistantUsage(message);
    if (usage) usageInfo = { usage, index: i };
  }
  if (!usageInfo) {
    let estimated = 0;
    for (const message of messages) estimated += estimateTokens(message);
    return { tokens: estimated, usageTokens: 0, trailingTokens: estimated, lastUsageIndex: null };
  }
  const usageTokens = calculateContextTokens(usageInfo.usage);
  let trailingTokens = 0;
  for (const message of messages.slice(usageInfo.index + 1)) trailingTokens += estimateTokens(message);
  return { tokens: usageTokens + trailingTokens, usageTokens, trailingTokens, lastUsageIndex: usageInfo.index };
}

/** Return whether context usage exceeds the configured compaction threshold. */
export function shouldCompact(contextTokens: number, contextWindow: number, settings: CompactionSettings): boolean {
  if (!settings.enabled) return false;
  return contextTokens > contextWindow - settings.reserveTokens;
}

const ESTIMATED_IMAGE_CHARS = 4800;

function estimateTextAndImageContentChars(content: string | ReadonlyArray<{ type: string; text?: string }>): number {
  if (typeof content === "string") return content.length;
  let chars = 0;
  for (const block of content) {
    if (block.type === "text" && block.text) chars += block.text.length;
    else if (block.type === "image") chars += ESTIMATED_IMAGE_CHARS;
  }
  return chars;
}

/** Estimate token count for one message using a conservative character heuristic. */
function estimateTokens(message: AgentMessage): number {
  let chars = 0;
  switch (message.role) {
    case "user":
      return Math.ceil(estimateTextAndImageContentChars(message.content) / 4);
    case "assistant": {
      for (const block of message.content) {
        if (block.type === "text") chars += block.text.length;
        else if (block.type === "thinking") chars += block.thinking.length;
        else if (block.type === "toolCall") chars += block.name.length + safeJsonStringify(block.arguments).length;
      }
      return Math.ceil(chars / 4);
    }
    case "custom":
    case "toolResult":
      return Math.ceil(estimateTextAndImageContentChars(message.content) / 4);
    case "bashExecution":
      return Math.ceil((message.command.length + message.output.length) / 4);
    case "branchSummary":
    case "compactionSummary":
      return Math.ceil(message.summary.length / 4);
  }
  return 0;
}

// ── Cut points ─────────────────────────────────────────────────────────────

/** A turn may be cut before these; never before a tool result, which must follow its call. */
const CUT_POINT_ROLES = new Set(["bashExecution", "custom", "branchSummary", "compactionSummary", "user", "assistant"]);

function findValidCutPoints(entries: Entry[], startIndex: number, endIndex: number): number[] {
  const cutPoints: number[] = [];
  for (let i = startIndex; i < endIndex; i++) {
    const entry = entries[i];
    if (entry?.type === "message" && CUT_POINT_ROLES.has(entry.message.role)) cutPoints.push(i);
    if (entry?.type === "branch_summary") cutPoints.push(i);
  }
  return cutPoints;
}

function findTurnStartIndex(entries: Entry[], entryIndex: number, startIndex: number): number {
  for (let i = entryIndex; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry?.type === "branch_summary") return i;
    if (entry?.type === "message" && (entry.message.role === "user" || entry.message.role === "bashExecution")) return i;
  }
  return -1;
}

interface CutPointResult {
  firstKeptEntryIndex: number;
  turnStartIndex: number;
  isSplitTurn: boolean;
}

function findCutPoint(entries: Entry[], startIndex: number, endIndex: number, keepRecentTokens: number): CutPointResult {
  const cutPoints = findValidCutPoints(entries, startIndex, endIndex);
  const firstCutPoint = cutPoints[0];
  if (firstCutPoint === undefined) return { firstKeptEntryIndex: startIndex, turnStartIndex: -1, isSplitTurn: false };
  let accumulatedTokens = 0;
  let cutIndex = firstCutPoint;
  for (let i = endIndex - 1; i >= startIndex; i--) {
    const entry = entries[i];
    if (entry?.type !== "message") continue;
    accumulatedTokens += estimateTokens(entry.message);
    if (accumulatedTokens >= keepRecentTokens) {
      for (const cutPoint of cutPoints) {
        if (cutPoint >= i) {
          cutIndex = cutPoint;
          break;
        }
      }
      break;
    }
  }
  while (cutIndex > startIndex) {
    const prevEntry = entries[cutIndex - 1];
    if (prevEntry?.type === "compaction" || prevEntry?.type === "message") break;
    cutIndex--;
  }
  const cutEntry = entries[cutIndex];
  const isUserMessage = cutEntry?.type === "message" && cutEntry.message.role === "user";
  const turnStartIndex = isUserMessage ? -1 : findTurnStartIndex(entries, cutIndex, startIndex);
  return { firstKeptEntryIndex: cutIndex, turnStartIndex, isSplitTurn: !isUserMessage && turnStartIndex !== -1 };
}

// ── Summaries ──────────────────────────────────────────────────────────────

const SUMMARIZATION_SYSTEM_PROMPT = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

const SUMMARIZATION_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const UPDATE_SUMMARIZATION_PROMPT = `The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous-summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the Progress section: move items from "In Progress" to "Done" when completed
- UPDATE "Next Steps" based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

## Goal
[Preserve existing goals, add new ones if the task expanded]

## Constraints & Preferences
- [Preserve existing, add new ones discovered]

## Progress
### Done
- [x] [Include previously done items AND newly completed items]

### In Progress
- [ ] [Current work - update based on progress]

### Blocked
- [Current blockers - remove if resolved]

## Key Decisions
- **[Decision]**: [Brief rationale] (preserve all previous, add new)

## Next Steps
1. [Update based on current state]

## Critical Context
- [Preserve important context, add new if needed]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

const TURN_PREFIX_SUMMARIZATION_PROMPT = `This is the PREFIX of a turn that was too large to keep. The SUFFIX (recent work) is retained.

Summarize the prefix to provide context for the retained suffix:

## Original Request
[What did the user ask for in this turn?]

## Early Progress
- [Key decisions and work done in the prefix]

## Context for Suffix
- [Information needed to understand the retained recent work]

Be concise. Focus on what's needed to understand the kept suffix.`;

export interface SummaryOptions {
  customInstructions?: string;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
}

/** One standalone summary request: no prompt cache writes, its own routing session. */
async function requestSummary(
  models: Models,
  model: Model<Api>,
  promptText: string,
  maxTokens: number,
  options: SummaryOptions,
): Promise<AssistantMessage> {
  const { thinkingLevel, signal } = options;
  const aiContext: AiContext = {
    systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: promptText }], timestamp: Date.now() }],
  };
  const requestOptions: SimpleStreamOptions = {
    ...(model.reasoning && thinkingLevel && thinkingLevel !== "off" ? { maxTokens, reasoning: thinkingLevel } : { maxTokens }),
    signal,
    cacheRetention: "none",
    sessionId: uuidv7(),
  };
  return await models.completeSimple(model, aiContext, requestOptions);
}

function summaryResult(response: AssistantMessage, request: SummaryRequestKind): Result<{ text: string; usage: Usage }, CompactionError> {
  const label = request === "prefix" ? "Turn prefix summarization" : "Summarization";
  if (response.stopReason === "aborted") return err(new CompactionError("aborted", response.errorMessage || `${label} aborted`, request));
  if (response.stopReason === "error") {
    return err(new CompactionError("summarization_failed", `${label} failed: ${response.errorMessage || "Unknown error"}`, request));
  }
  return ok({ text: contentText(response.content), usage: response.usage });
}

/** Generate or update a conversation summary and return its provider usage. */
export async function generateSummaryWithUsage(
  currentMessages: AgentMessage[],
  models: Models,
  model: Model<Api>,
  reserveTokens: number,
  options: SummaryOptions & { previousSummary?: string } = {},
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
  const { customInstructions, previousSummary } = options;
  const maxTokens = Math.min(Math.floor(0.8 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
  let basePrompt = previousSummary ? UPDATE_SUMMARIZATION_PROMPT : SUMMARIZATION_PROMPT;
  if (customInstructions) basePrompt = `${basePrompt}\n\nAdditional focus: ${customInstructions}`;
  let promptText = `<conversation>\n${serializeConversation(convertToLlm(currentMessages))}\n</conversation>\n\n`;
  if (previousSummary) promptText += `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n`;
  promptText += basePrompt;
  return summaryResult(await requestSummary(models, model, promptText, maxTokens, options), "history");
}

async function generateTurnPrefixSummary(
  messages: AgentMessage[],
  models: Models,
  model: Model<Api>,
  reserveTokens: number,
  options: SummaryOptions,
): Promise<Result<{ text: string; usage: Usage }, CompactionError>> {
  const maxTokens = Math.min(Math.floor(0.5 * reserveTokens), model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY);
  const promptText = `<conversation>\n${serializeConversation(convertToLlm(messages))}\n</conversation>\n\n${TURN_PREFIX_SUMMARIZATION_PROMPT}`;
  return summaryResult(await requestSummary(models, model, promptText, maxTokens, options), "prefix");
}

// ── Compaction ─────────────────────────────────────────────────────────────

/** How a split-turn summary begins when no history preceded the turn. */
export const EMPTY_HISTORY_TEXT = "No prior history.";

/** File-operation details stored on generated compaction entries. */
export interface CompactionDetails extends Record<string, JsonValue> {
  readFiles: string[];
  modifiedFiles: string[];
}

/** Prepared inputs for a compaction run. */
export interface CompactionPreparation {
  /** Messages summarized into the history summary. */
  messagesToSummarize: AgentMessage[];
  /** Prefix messages summarized separately when compaction splits a turn. */
  turnPrefixMessages: AgentMessage[];
  /** Recent messages retained after compaction. */
  retainedTail: AgentMessage[];
  isSplitTurn: boolean;
  /** Estimated context tokens before compaction. */
  tokensBefore: number;
  /** Previous compaction summary used for iterative updates. */
  previousSummary?: string;
  fileOps: FileOperations;
  settings: CompactionSettings;
}

/** Generated compaction data ready to be persisted. */
export interface CompactResult {
  summary: string;
  tokensBefore: number;
  usage?: Usage;
  retainedTail: AgentMessage[];
  details?: JsonValue;
}

function getMessageFromEntryForCompaction(entry: Entry): AgentMessage | undefined {
  if (entry.type === "message") return entry.message;
  if (entry.type === "branch_summary") return createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp);
  return undefined;
}

/** Prepare session entries for compaction, or return undefined when compaction is not applicable. */
export function prepareCompaction(pathEntries: Entry[], settings: CompactionSettings): Result<CompactionPreparation | undefined, CompactionError> {
  if (pathEntries.length === 0 || pathEntries.at(-1)?.type === "compaction") return ok(undefined);

  let prevCompactionIndex = -1;
  for (let i = pathEntries.length - 1; i >= 0; i--) {
    if (pathEntries[i]?.type === "compaction") {
      prevCompactionIndex = i;
      break;
    }
  }

  let previousSummary: string | undefined;
  let compactableEntries = pathEntries;
  if (prevCompactionIndex >= 0) {
    const prevCompaction = pathEntries[prevCompactionIndex] as CompactionEntry;
    previousSummary = prevCompaction.summary;
    const virtualRetainedEntries: Entry[] = prevCompaction.retainedTail.map((message, index) => ({
      type: "message",
      id: `${prevCompaction.id}:retained:${index}`,
      parentId: index === 0 ? prevCompaction.id : `${prevCompaction.id}:retained:${index - 1}`,
      seq: prevCompaction.seq,
      timestamp: message.timestamp,
      message,
    }));
    compactableEntries = [...virtualRetainedEntries, ...pathEntries.slice(prevCompactionIndex + 1)];
  }
  const boundaryEnd = compactableEntries.length;
  const tokensBefore = estimateContextTokens(buildContextEntries(pathEntries).flatMap(sessionEntryToContextMessages)).tokens;

  const cutPoint = findCutPoint(compactableEntries, 0, boundaryEnd, settings.keepRecentTokens);
  const historyEnd = cutPoint.isSplitTurn ? cutPoint.turnStartIndex : cutPoint.firstKeptEntryIndex;
  const collect = (start: number, end: number) => {
    const messages: AgentMessage[] = [];
    for (let i = start; i < end; i++) {
      const entry = compactableEntries[i];
      const msg = entry && getMessageFromEntryForCompaction(entry);
      if (msg) messages.push(msg);
    }
    return messages;
  };
  const messagesToSummarize = collect(0, historyEnd);
  const turnPrefixMessages = cutPoint.isSplitTurn ? collect(cutPoint.turnStartIndex, cutPoint.firstKeptEntryIndex) : [];
  const retainedTail = collect(cutPoint.firstKeptEntryIndex, boundaryEnd);
  const fileOps = extractFileOperations(messagesToSummarize, pathEntries, prevCompactionIndex);
  for (const msg of turnPrefixMessages) extractFileOpsFromMessage(msg, fileOps);

  return ok({ messagesToSummarize, turnPrefixMessages, retainedTail, isSplitTurn: cutPoint.isSplitTurn, tokensBefore, previousSummary, fileOps, settings });
}

/** Generate compaction summary data from prepared session history. */
export async function compact(
  preparation: CompactionPreparation,
  models: Models,
  model: Model<Api>,
  options: SummaryOptions = {},
): Promise<Result<CompactResult, CompactionError>> {
  const { messagesToSummarize, turnPrefixMessages, retainedTail, isSplitTurn, tokensBefore, previousSummary, fileOps, settings } = preparation;
  const { reserveTokens } = settings;

  let summary: string;
  let summaryUsage: Usage;
  if (isSplitTurn && turnPrefixMessages.length > 0) {
    let historyText = EMPTY_HISTORY_TEXT;
    let historyUsage: Usage | undefined;
    if (messagesToSummarize.length > 0) {
      const historyResult = await generateSummaryWithUsage(messagesToSummarize, models, model, reserveTokens, { ...options, previousSummary });
      if (!historyResult.ok) return err(historyResult.error);
      historyText = historyResult.value.text;
      historyUsage = historyResult.value.usage;
    }
    const turnPrefixResult = await generateTurnPrefixSummary(turnPrefixMessages, models, model, reserveTokens, options);
    if (!turnPrefixResult.ok) return err(turnPrefixResult.error);
    summary = `${historyText}\n\n---\n\n**Turn Context (split turn):**\n\n${turnPrefixResult.value.text}`;
    summaryUsage = historyUsage ? addUsage(historyUsage, turnPrefixResult.value.usage) : turnPrefixResult.value.usage;
  } else {
    const summaryResult = await generateSummaryWithUsage(messagesToSummarize, models, model, reserveTokens, { ...options, previousSummary });
    if (!summaryResult.ok) return err(summaryResult.error);
    summary = summaryResult.value.text;
    summaryUsage = summaryResult.value.usage;
  }

  const { readFiles, modifiedFiles } = computeFileLists(fileOps);
  summary += formatFileOperations(readFiles, modifiedFiles);
  const details: CompactionDetails = { readFiles, modifiedFiles };
  return ok({ summary, tokensBefore, usage: summaryUsage, retainedTail, details });
}
