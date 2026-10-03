import type { ContentBlock } from "../core/content.js";
import type { RuntimeContextMessage } from "./index.js";

const createEmptyUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

export type ContextProjectionOptions = {
  /** Provider recorded on projected assistant messages whose row has none. */
  fallbackProvider?: string | null;
  /** Resolve the wire api of a historical row from its own provider/model. */
  resolveApi?: (input: { provider: string | null; model: string | null }) => string | null;
  /** Let the runtime provide its image transport without coupling the protocol to a provider SDK. */
  projectImage?: (block: Extract<ContentBlock, { type: "image" }>) => { type: "image"; data: string; mimeType: string } | null;
};

/**
 * Project one block as itself, or drop it. Nothing is ever rewritten into prompt text.
 * Without a runtime image projector, URL images have no native representation here. The
 * durable copy stays in the database and is not faked into the model's input.
 */
function projectBlock(block: ContentBlock, options: ContextProjectionOptions): Record<string, unknown> | null {
  if (block.type === "text") return { type: "text", text: block.text };
  if (block.type === "image") {
    if (options.projectImage) return options.projectImage(block);
    return block.source.type === "base64"
      ? { type: "image", data: block.source.data, mimeType: block.source.media_type }
      : null;
  }
  if (block.type === "thinking") {
    return { type: "thinking", thinking: block.thinking, ...(block.signature ? { thinkingSignature: block.signature } : {}) };
  }
  return null;
}

const projectContent = (content: ContentBlock[], options: ContextProjectionOptions) =>
  content.map((block) => projectBlock(block, options)).filter((block): block is Record<string, unknown> => block !== null);

const isCompaction = (message: RuntimeContextMessage) =>
  message.role === "system" && message.content.some((block) => block.type === "system_note" && block.note_type === "compacted");

/** A generation placeholder must never be projected as if it were a finished result. */
const isPendingGenerationResult = (message: RuntimeContextMessage) =>
  message.role === "assistant"
  && message.meta?.messageKind === "generation_result"
  && message.meta?.generationStatus !== "completed"
  && message.meta?.generationStatus !== "failed";

export function selectRuntimeContextMessages(messages: RuntimeContextMessage[]): RuntimeContextMessage[] {
  let boundary = -1;
  let latest = -1;
  messages.forEach((message, index) => {
    if (!isCompaction(message)) return;
    const compaction = message.meta?.compaction as { compactedAt?: string } | undefined;
    const timestamp = Date.parse(compaction?.compactedAt ?? String(message.meta?.createdAt ?? ""));
    const order = Number.isFinite(timestamp) ? timestamp : index;
    if (order >= latest) { latest = order; boundary = index; }
  });
  const compaction = messages[boundary];
  if (!compaction) return messages;
  // Compression entries are inserted at their retained-tail boundary, not in creation order.
  return [compaction, ...messages.slice(boundary + 1).filter((message) => !isCompaction(message))];
}

/**
 * Compile durable, normalized messages into Pi-compatible context without replaying tools.
 * Representable blocks and tool pairing are preserved verbatim; anything without a native
 * representation is dropped rather than described in prompt text.
 */
export function contextToPiMessages(messages: RuntimeContextMessage[], options: ContextProjectionOptions = {}): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const message of selectRuntimeContextMessages(messages)) {
    if (isPendingGenerationResult(message)) continue;
    const meta = { ...message.meta, messageId: message.id, turnId: message.turnId };
    const recordedAt = Date.parse(String(message.meta?.createdAt ?? ""));
    const timestamp = Number.isFinite(recordedAt) ? recordedAt : 0;
    if (message.role === "system") {
      // Compaction is materialized by the caller as a native boundary; other system rows drop.
      continue;
    }
    if (message.role !== "assistant") {
      const projected = projectContent(message.content, options);
      if (projected.length) result.push({ role: "user", content: projected, timestamp, meta });
      continue;
    }
    const calls = new Map(message.content.flatMap((block) => block.type === "tool_use" ? [[block.id, block.name] as const] : []));
    const content = message.content.flatMap((block): Record<string, unknown>[] => {
      if (block.type === "tool_result") return [];
      if (block.type === "tool_use") return [{ type: "toolCall", id: block.id, name: block.name, arguments: block.input }];
      const projected = projectBlock(block, options);
      return projected ? [projected] : [];
    });
    if (content.length) result.push({
      role: "assistant", content,
      api: typeof message.meta?.nativeApi === "string" ? message.meta.nativeApi : options.resolveApi?.({ provider: message.provider ?? null, model: message.model ?? null }) ?? "history",
      provider: message.provider ?? options.fallbackProvider ?? "history",
      model: message.model ?? "history", usage: { ...createEmptyUsage(), ...message.usage },
      stopReason: message.stopReason === "tool_use" ? "toolUse" : message.stopReason ?? (calls.size ? "toolUse" : "stop"),
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      timestamp, meta,
    });
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      if (!calls.has(block.tool_use_id)) continue;
      result.push({
        role: "toolResult", toolCallId: block.tool_use_id, toolName: calls.get(block.tool_use_id) ?? "tool",
        content: typeof block.content === "string" ? [{ type: "text", text: block.content }] : projectContent(block.content, options),
        isError: block.is_error ?? false, timestamp, meta,
      });
      calls.delete(block.tool_use_id);
    }
    // Calls without a recorded result are left to the harness; no result is invented here.
  }
  return result;
}
