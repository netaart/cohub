import type { ContentBlock } from "../core/content.js";
import type { Usage } from "../core/usage.js";

export type CanonicalProjectionMessage = {
  id: string;
  turnId: string;
  role: "user" | "assistant" | "system";
  content: ContentBlock[];
  provider?: string | null;
  model?: string | null;
  usage?: Usage | null;
  stopReason?: string | null;
  errorMessage?: string | null;
  meta?: Record<string, unknown> | null;
  sourceSessionId: string;
  sequence: number;
  createdAt: string;
};

export type ProjectionTarget = "pi" | "codex";

export type CanonicalProjectionTurn = {
  id: string;
  sourceSessionId: string;
  sourceTurnId: string;
  sequence: number;
  status: string;
  intent: string;
  provider: string | null;
  model: string | null;
  userContent: ContentBlock[];
  assistantContent: ContentBlock[] | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  durationMs: number | null;
  messages: CanonicalProjectionMessage[];
};

export type ProjectionInput = {
  spaceId: string;
  sessionId: string;
  nativeSessionId: string;
  cwd: string;
  provider?: string | null;
  timestamp?: string;
  turns: CanonicalProjectionTurn[];
};

export type ProjectionCursor = {
  sourceSequence: number | null;
  sourceTurnId: string | null;
  sourceFingerprint: string;
};

export type ProjectionWarning = {
  sourceMessageId: string;
  sourceTurnId: string;
  reason: string;
};

export type ProjectionRecord = {
  key: string;
  sourceTurnId: string | null;
  sourceMessageId: string | null;
  record: Record<string, unknown>;
};

export type NativeProjection = {
  target: ProjectionTarget;
  records: ProjectionRecord[];
  cursor: ProjectionCursor;
  warnings: ProjectionWarning[];
};

const DEFAULT_TIMESTAMP = "1970-01-01T00:00:00.000Z";
const asMeta = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const safeId = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_");
const entryId = (messageId: string, ordinal: number) => `cohub_${safeId(messageId)}_${ordinal}`;
export const isProjectionCompaction = (message: CanonicalProjectionMessage) => message.role === "system" && message.content.some((block) => block.type === "system_note" && block.note_type === "compacted");
const isPendingGeneration = (message: CanonicalProjectionMessage) => message.role === "assistant" && message.meta?.messageKind === "generation_result" && !["completed", "failed"].includes(String(message.meta.generationStatus));
const messageMeta = (message: CanonicalProjectionMessage) => asMeta(message.meta);
const timestampOf = (message: CanonicalProjectionMessage, fallback: string) => message.createdAt || fallback;

function stableJson(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function fingerprint(value: unknown): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of stableJson(value)) {
    hash ^= BigInt(character.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function sourceFingerprint(turns: CanonicalProjectionTurn[]) {
  return `${turns.length}:${fingerprint(turns)}`;
}

export function projectNativeMessageMeta(message: CanonicalProjectionMessage) {
  const source = messageMeta(message);
  const safe: Record<string, unknown> = {
    sourceSessionId: message.sourceSessionId,
    sequence: message.sequence,
    createdAt: message.createdAt,
  };
  for (const key of ["agentSessionEntryId", "messageKind", "nativeApi", "generationStatus"]) {
    if (source[key] !== undefined) safe[key] = source[key];
  }
  const compaction = asMeta(source.compaction);
  if (Object.keys(compaction).length) {
    safe.compaction = Object.fromEntries(["compactionId", "compactedAt", "tokensBefore", "firstKeptEntryId"].filter((key) => compaction[key] !== undefined).map((key) => [key, compaction[key]]));
  }
  return { ...safe, messageId: message.id, turnId: message.turnId };
}

function projectPiBlock(block: ContentBlock): Record<string, unknown> | null {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "thinking") return { type: "thinking", thinking: block.thinking, ...(block.signature ? { thinkingSignature: block.signature } : {}) };
  if (block.type === "image" && block.source.type === "base64") return { type: "image", data: block.source.data, mimeType: block.source.media_type };
  if (block.type === "tool_use") return { type: "toolCall", id: block.id, name: block.name, arguments: block.input };
  return null;
}

function containsExternalImage(content: ContentBlock[]): boolean {
  return content.some((block) => block.type === "image" && block.source.type === "url" || block.type === "tool_result" && Array.isArray(block.content) && containsExternalImage(block.content));
}

function projectPiMessage(message: CanonicalProjectionMessage, warnings: ProjectionWarning[], toolNames: Map<string, string>): Record<string, unknown>[] {
  const meta = projectNativeMessageMeta(message);
  if (containsExternalImage(message.content)) warnings.push({ sourceMessageId: message.id, sourceTurnId: message.turnId, reason: "external image URL omitted from native projection" });
  if (message.role === "system") return [];
  if (message.role === "user") {
    const content = message.content.map(projectPiBlock).filter((block): block is Record<string, unknown> => block !== null);
    return content.length ? [{ role: "user", content, timestamp: Date.parse(message.createdAt) || 0, meta }] : [];
  }
  const calls = new Map(message.content.flatMap((block) => block.type === "tool_use" ? [[block.id, block.name] as const] : []));
  for (const [id, name] of calls) toolNames.set(id, name);
  const result: Record<string, unknown>[] = [];
  const content = message.content.map(projectPiBlock).filter((block): block is Record<string, unknown> => block !== null);
  if (content.length) {
    result.push({ role: "assistant", content, api: typeof messageMeta(message).nativeApi === "string" ? messageMeta(message).nativeApi : "history", provider: message.provider ?? "history", model: message.model ?? "history", usage: message.usage ?? emptyUsage(), stopReason: message.stopReason === "tool_use" ? "toolUse" : message.stopReason ?? (calls.size ? "toolUse" : "stop"), ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}), timestamp: Date.parse(message.createdAt) || 0, meta });
  }
  for (const block of message.content) {
    if (block.type !== "tool_result") continue;
    const toolName = calls.get(block.tool_use_id) ?? toolNames.get(block.tool_use_id);
    if (!toolName) continue;
    result.push({ role: "toolResult", toolCallId: block.tool_use_id, toolName, content: typeof block.content === "string" ? [{ type: "text", text: block.content }] : block.content.map(projectPiBlock).filter((item): item is Record<string, unknown> => item !== null), isError: block.is_error ?? false, timestamp: Date.parse(message.createdAt) || 0, meta });
  }
  return result;
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: null };
}

function projectionMetadata(input: ProjectionInput) {
  return { schema: "cohub.projection.v2", spaceId: input.spaceId, sessionId: input.sessionId };
}

export function trimProjectionTurnsToCompaction(turns: CanonicalProjectionTurn[]): CanonicalProjectionTurn[] {
  let boundaryTurn = -1;
  let boundaryMessage = -1;
  let boundaryOrder = Number.NEGATIVE_INFINITY;
  turns.forEach((turn, turnIndex) => {
    turn.messages.forEach((message, messageIndex) => {
      if (!isProjectionCompaction(message)) return;
      const compactedAt = asMeta(messageMeta(message).compaction).compactedAt;
      const parsed = typeof compactedAt === "string" ? Date.parse(compactedAt) : Number.NaN;
      const order = Number.isFinite(parsed) ? parsed : turnIndex * 1_000_000 + messageIndex;
      if (order >= boundaryOrder) {
        boundaryTurn = turnIndex;
        boundaryMessage = messageIndex;
        boundaryOrder = order;
      }
    });
  });
  if (boundaryTurn < 0) return turns;
  return turns.slice(boundaryTurn).flatMap((turn, index) => {
    const messages = index === 0
      ? turn.messages.slice(boundaryMessage).filter((message, messageIndex) => messageIndex === 0 || !isProjectionCompaction(message))
      : turn.messages.filter((message) => !isProjectionCompaction(message));
    return messages.length ? [{ ...turn, messages }] : [];
  });
}

function piProjection(input: ProjectionInput): NativeProjection {
  const sourceTurns = trimProjectionTurnsToCompaction(input.turns);
  const fallbackTimestamp = input.timestamp ?? DEFAULT_TIMESTAMP;
  const records: ProjectionRecord[] = [{ key: `header:${input.nativeSessionId}`, sourceTurnId: null, sourceMessageId: null, record: { type: "session", version: 3, id: input.nativeSessionId, timestamp: fallbackTimestamp, cwd: input.cwd, affinity: { sessionId: input.sessionId, threadId: input.nativeSessionId }, cohub: projectionMetadata(input) } }];
  const warnings: ProjectionWarning[] = [];
  const nativeIds = new Map<string, string>();
  const toolNames = new Map<string, string>();
  const compactions: Array<{ record: ProjectionRecord; firstKeptEntryId: string | null }> = [];
  let parentId: string | null = null;

  for (const turn of sourceTurns) {
    for (const message of turn.messages) {
      if (isPendingGeneration(message)) continue;
      if (isProjectionCompaction(message)) {
        const id = `cohub_${safeId(message.id)}_compaction`;
        const record = { type: "compaction", id, parentId, timestamp: timestampOf(message, fallbackTimestamp), summary: message.content.flatMap((block) => block.type === "system_note" ? [block.text] : []).join("\n"), firstKeptEntryId: "", tokensBefore: Number(asMeta(messageMeta(message).compaction).tokensBefore) || 0 };
        const projectionRecord = { key: `${message.id}:${message.turnId}:compaction`, sourceTurnId: message.turnId, sourceMessageId: message.id, record };
        records.push(projectionRecord);
        compactions.push({ record: projectionRecord, firstKeptEntryId: typeof asMeta(messageMeta(message).compaction).firstKeptEntryId === "string" ? String(asMeta(messageMeta(message).compaction).firstKeptEntryId) : null });
        parentId = id;
        continue;
      }
      const projected = projectPiMessage(message, warnings, toolNames);
      projected.forEach((nativeMessage, ordinal) => {
        const id = entryId(message.id, ordinal);
        const record = { type: "message", id, parentId, timestamp: timestampOf(message, fallbackTimestamp), message: nativeMessage };
        records.push({ key: `${message.id}:${message.turnId}:${ordinal}`, sourceTurnId: message.turnId, sourceMessageId: message.id, record });
        if (!nativeIds.has(message.id)) nativeIds.set(message.id, id);
        const sourceEntry = messageMeta(message).agentSessionEntryId;
        if (typeof sourceEntry === "string" && !nativeIds.has(sourceEntry)) nativeIds.set(sourceEntry, id);
        parentId = id;
      });
      if (projected.length === 0 && message.content.length) warnings.push({ sourceMessageId: message.id, sourceTurnId: message.turnId, reason: "message has no native Pi representation" });
    }
  }

  for (const compaction of compactions) {
    compaction.record.record.firstKeptEntryId = compaction.firstKeptEntryId ? nativeIds.get(compaction.firstKeptEntryId) ?? "" : "";
  }
  return { target: "pi", records, cursor: { sourceSequence: input.turns.at(-1)?.sequence ?? null, sourceTurnId: input.turns.at(-1)?.sourceTurnId ?? null, sourceFingerprint: sourceFingerprint(input.turns) }, warnings };
}

function codexInputContent(block: ContentBlock): Record<string, unknown>[] {
  if (block.type === "text") return [{ type: "input_text", text: block.text }];
  if (block.type === "image" && block.source.type === "base64") return [{ type: "input_image", image_url: `data:${block.source.media_type};base64,${block.source.data}` }];
  return [];
}

function codexOutput(block: ContentBlock): Record<string, unknown>[] {
  return block.type === "text" ? [{ type: "output_text", text: block.text }] : [];
}

// OpenAI Responses rejects call_id longer than 64 chars; other providers (e.g. Pi via Cursor) emit longer ids.
// Hashing keeps the call/output pair linked without per-session state.
const CODEX_CALL_ID_MAX = 64;
const codexCallId = (id: string) => id.length <= CODEX_CALL_ID_MAX ? id : `call_${fingerprint(id)}`;

function codexMessageRecords(input: ProjectionInput, message: CanonicalProjectionMessage, warnings: ProjectionWarning[]): ProjectionRecord[] {
  const timestamp = timestampOf(message, input.timestamp ?? DEFAULT_TIMESTAMP);
  const records: ProjectionRecord[] = [];
  const metadata = { cohub: { ...projectionMetadata(input), ...projectNativeMessageMeta(message), turnId: message.turnId, messageId: message.id } };
  if (containsExternalImage(message.content)) warnings.push({ sourceMessageId: message.id, sourceTurnId: message.turnId, reason: "external image URL omitted from native projection" });
  const push = (ordinal: number, payload: Record<string, unknown>) => records.push({ key: `${message.id}:${message.turnId}:${ordinal}`, sourceTurnId: message.turnId, sourceMessageId: message.id, record: { timestamp, type: "response_item", payload, metadata } });
  const plain = message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
  for (const block of message.content) {
    if (block.type === "image" && block.source.type === "url") continue;
    if (block.type === "text") push(records.length, { type: "message", role: message.role, content: message.role === "assistant" ? codexOutput(block) : codexInputContent(block) });
    else if (block.type === "image") {
      const content = codexInputContent(block);
      if (content.length) push(records.length, { type: "message", role: "user", content });
    } else if (block.type === "thinking") push(records.length, { type: "reasoning", summary: [{ type: "summary_text", text: block.thinking }], content: null, encrypted_content: null });
    else if (block.type === "tool_use") push(records.length, { type: "function_call", name: block.name, arguments: JSON.stringify(block.input), call_id: codexCallId(block.id) });
    else if (block.type === "tool_result") push(records.length, { type: "function_call_output", call_id: codexCallId(block.tool_use_id), output: typeof block.content === "string" ? block.content : block.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n") });
  }
  if (plain) records.push({ key: `${message.id}:${message.turnId}:event`, sourceTurnId: message.turnId, sourceMessageId: message.id, record: { timestamp, type: "event_msg", payload: { type: message.role === "user" ? "user_message" : "agent_message", message: plain, kind: "plain" } } });
  return records;
}

function codexTerminalPayload(turn: CanonicalProjectionTurn): Record<string, unknown> {
  const lastAgentMessage = turn.assistantContent?.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n") || null;
  if (turn.status === "completed") return { type: "turn_complete", turn_id: turn.id, last_agent_message: lastAgentMessage };
  return { type: "turn_aborted", turn_id: turn.id, reason: turn.status, last_agent_message: lastAgentMessage };
}

function codexProjection(input: ProjectionInput): NativeProjection {
  const sourceTurns = trimProjectionTurnsToCompaction(input.turns);
  const fallbackTimestamp = input.timestamp ?? DEFAULT_TIMESTAMP;
  const records: ProjectionRecord[] = [{ key: `header:${input.nativeSessionId}`, sourceTurnId: null, sourceMessageId: null, record: { timestamp: fallbackTimestamp, type: "session_meta", payload: { id: input.nativeSessionId, session_id: input.nativeSessionId, timestamp: fallbackTimestamp, cwd: input.cwd, originator: "cohub", cli_version: "cohub-runtime", source: "cli", model_provider: input.provider ?? null, history_mode: "legacy", cohub: projectionMetadata(input) } } }];
  const warnings: ProjectionWarning[] = [];
  for (const turn of sourceTurns) {
    const start = turn.startedAt ?? turn.createdAt;
    records.push({ key: `turn:${turn.id}:started`, sourceTurnId: turn.sourceTurnId, sourceMessageId: null, record: { timestamp: start, type: "event_msg", payload: { type: "turn_started", turn_id: turn.id, started_at: Math.floor(Date.parse(start) / 1000), model_context_window: null, collaboration_mode_kind: "default" } } });
    for (const message of turn.messages) if (!isPendingGeneration(message)) records.push(...codexMessageRecords(input, message, warnings));
    records.push({ key: `turn:${turn.id}:terminal`, sourceTurnId: turn.sourceTurnId, sourceMessageId: null, record: { timestamp: turn.completedAt ?? turn.createdAt, type: "event_msg", payload: codexTerminalPayload(turn) } });
  }
  return { target: "codex", records, cursor: { sourceSequence: input.turns.at(-1)?.sequence ?? null, sourceTurnId: input.turns.at(-1)?.sourceTurnId ?? null, sourceFingerprint: sourceFingerprint(input.turns) }, warnings };
}

export function projectNativeSession(input: ProjectionInput, target: ProjectionTarget): NativeProjection {
  return target === "pi" ? piProjection(input) : codexProjection(input);
}

export function serializeProjectionRecords(records: ProjectionRecord[]): string {
  return records.length ? `${records.map((record) => JSON.stringify(record.record)).join("\n")}\n` : "";
}

export function serializeProjection(projection: NativeProjection): string {
  return serializeProjectionRecords(projection.records);
}

export function fingerprintProjectionTurns(turns: CanonicalProjectionTurn[]): string {
  return `${turns.length}:${fingerprint(turns)}`;
}
