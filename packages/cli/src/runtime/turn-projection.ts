import { projectNativeSession, type CanonicalProjectionTurn, type ContentBlock, type MessageToolCallsFile, type ProjectionInput, type ProjectionTarget, type SessionTurnRecord, type StoredIntermediateMessage, type StoredToolCall, type TurnIntermediateMessagesFile } from "@neta-art/cohub";

export type SessionTurnProjectionClient = {
  session(sessionId: string): {
    turns: {
      listPaginated(options?: { cursor?: number; limit?: number; direction?: "older" | "newer" }, request?: { signal?: AbortSignal }): Promise<{
        turns: SessionTurnRecord[];
        hasMore: boolean;
        nextCursor: number | undefined;
      }>;
      get(turnId: string, request?: { signal?: AbortSignal }): Promise<{ turn: SessionTurnRecord }>;
      intermediate: {
        get(turnId: string, messagesObjectKey?: string | null, options?: { signal?: AbortSignal }): Promise<TurnIntermediateMessagesFile | null>;
        getToolCalls(turnId: string, message: StoredIntermediateMessage, options?: { signal?: AbortSignal }): Promise<MessageToolCallsFile | null>;
      };
    };
  };
};

export type ProjectionSourceTurn = CanonicalProjectionTurn;

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const iso = (value: string | null | undefined) => value ?? new Date(0).toISOString();
const sourceSessionId = (turn: SessionTurnRecord) => turn.sourceSessionId ?? turn.sessionId;
const sourceTurnId = (turn: SessionTurnRecord) => turn.sourceTurnId ?? turn.id;
const userMessageId = (turn: SessionTurnRecord) => {
  const value = record(turn.meta).userMessageId;
  return typeof value === "string" && value ? value : `${turn.id}:user`;
};

function hydrateToolDetails(content: ContentBlock[], calls: StoredToolCall[]): ContentBlock[] {
  const byId = new Map(calls.map((call) => [call.id, call]));
  return content.map((block) => {
    if (block.type === "tool_use") {
      const call = byId.get(block.id);
      return call ? { ...block, input: call.input } : block;
    }
    if (block.type === "tool_result") {
      const call = byId.get(block.tool_use_id);
      return call?.result ? { ...block, content: call.result.content ?? block.content, is_error: call.result.isError } : block;
    }
    return block;
  });
}

async function hydrateIntermediateMessage(
  turn: SessionTurnRecord,
  message: StoredIntermediateMessage,
  client: ReturnType<SessionTurnProjectionClient["session"]>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const toolCalls = await client.turns.intermediate.getToolCalls(turn.id, message, { signal });
  return {
    id: message.id,
    turnId: turn.id,
    role: message.role,
    content: hydrateToolDetails(message.content, toolCalls?.toolCalls ?? []),
    provider: message.provider,
    model: message.model,
    usage: message.usage,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
    meta: message.meta,
    sourceSessionId: message.sessionId,
    sequence: message.sequence ?? 0,
    createdAt: iso(message.createdAt),
  };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, mapper: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await mapper(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function hydrateSessionTurn(
  turn: SessionTurnRecord,
  client: ReturnType<SessionTurnProjectionClient["session"]>,
  signal?: AbortSignal,
): Promise<CanonicalProjectionTurn> {
  const sourceId = sourceSessionId(turn);
  const messages: CanonicalProjectionTurn["messages"] = [];
  if (turn.userContent.length) {
    messages.push({
      id: userMessageId(turn), turnId: turn.id, role: "user", content: turn.userContent,
      meta: { userMessageId: userMessageId(turn), turnId: turn.id }, sourceSessionId: sourceId,
      sequence: turn.sequence * 1_000_000, createdAt: iso(turn.createdAt),
    });
  }
  const objectKey = turn.intermediateIndex?.messagesObjectKey;
  if (!objectKey && (turn.intermediateSummary?.messageCount ?? 0) > 0) throw new Error(`Intermediate message index is unavailable for Turn ${turn.id}`);
  if (objectKey) {
    const archive = await client.turns.intermediate.get(turn.id, objectKey, { signal });
    if (!archive) throw new Error(`Intermediate messages are unavailable for Turn ${turn.id}`);
    const intermediate = await mapWithConcurrency(archive.messages, 8, (message) => hydrateIntermediateMessage(turn, message, client, signal));
    messages.push(...intermediate.map((message) => ({ ...message, sequence: turn.sequence * 1_000_000 + 100_000 + message.sequence })));
  }
  const hasFinalGenerationResult = messages.some((message) => message.role === "assistant" && message.meta?.messageKind === "generation_result" && ["completed", "failed"].includes(String(message.meta.generationStatus)));
  if (turn.assistantContent?.length && !hasFinalGenerationResult) {
    messages.push({
      id: `${turn.id}:assistant`, turnId: turn.id, role: turn.intent === "compact" ? "system" : "assistant", content: turn.assistantContent,
      provider: turn.provider, model: turn.model, usage: turn.finalUsage, stopReason: turn.stopReason, errorMessage: turn.errorMessage,
      meta: { ...(turn.meta ?? {}), turnId: turn.id, createdAt: turn.createdAt }, sourceSessionId: sourceId,
      sequence: turn.sequence * 1_000_000 + 900_000, createdAt: iso(turn.createdAt),
    });
  }
  messages.sort((left, right) => left.sequence - right.sequence || left.id.localeCompare(right.id));
  return {
    id: turn.id, sourceSessionId: sourceId, sourceTurnId: sourceTurnId(turn), sequence: turn.sequence,
    status: turn.status, intent: turn.intent, provider: turn.provider, model: turn.model,
    userContent: turn.userContent, assistantContent: turn.assistantContent, meta: turn.meta,
    createdAt: iso(turn.createdAt), startedAt: turn.startedAt, completedAt: turn.completedAt, durationMs: turn.durationMs,
    messages,
  };
}

export async function listSessionProjectionTurns(
  source: SessionTurnProjectionClient,
  sessionId: string,
  options: { afterSequence?: number | null; throughSequence?: number | null; excludeTurnId?: string | null; signal?: AbortSignal } = {},
): Promise<ProjectionSourceTurn[]> {
  const client = source.session(sessionId);
  const turns: SessionTurnRecord[] = [];
  const throughSequence = options.throughSequence ?? null;
  let cursor = options.afterSequence && options.afterSequence > 0 ? options.afterSequence : undefined;
  for (;;) {
    options.signal?.throwIfAborted();
    const page = await client.turns.listPaginated({ cursor, limit: 100, direction: "newer" }, { signal: options.signal });
    const visible = page.turns.filter((turn) => (throughSequence == null || turn.sequence <= throughSequence) && turn.id !== options.excludeTurnId && !["queued", "running", "abort_requested"].includes(turn.status));
    turns.push(...visible);
    if (throughSequence != null && page.turns.some((turn) => turn.sequence >= throughSequence)) break;
    if (!page.hasMore) break;
    if (page.nextCursor === undefined || page.nextCursor === cursor) throw new Error("Session Turn pagination did not advance");
    cursor = page.nextCursor;
  }
  return mapWithConcurrency(turns, 4, (turn) => hydrateSessionTurn(turn, client, options.signal));
}

export function projectTurnBatch(input: Omit<ProjectionInput, "turns"> & { turns: ProjectionSourceTurn[] }, target: ProjectionTarget) {
  return projectNativeSession(input, target);
}
