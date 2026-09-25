import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contextToPiMessages, type ContextProjectionOptions, type RuntimeContext, type RuntimeContextMessage } from "@cohub/protocol";
import type { SessionManager } from "./local-session-manager.js";
import { projectGenerationSessionMessage } from "../generation-message-projection.js";

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const isCompaction = (message: RuntimeContextMessage) =>
  message.role === "system" && message.content.some((block) => block.type === "system_note" && block.note_type === "compacted");

const compactionMetaOf = (message: RuntimeContextMessage) => asRecord(asRecord(message.meta).compaction);

/** Stable identity of a durable compaction; used so a native boundary is never anchored twice. */
const compactionKeyOf = (message: RuntimeContextMessage): string | null => {
  const compaction = compactionMetaOf(message);
  for (const value of [compaction.compactionId, compaction.compactedAt]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
};

const compactionSummaryOf = (message: RuntimeContextMessage): string =>
  message.content.map((block) => block.type === "system_note" ? block.text : "").join("\n");

const compactionTokensBeforeOf = (message: RuntimeContextMessage): number => {
  const tokensBefore = compactionMetaOf(message).tokensBefore;
  return typeof tokensBefore === "number" && Number.isFinite(tokensBefore) ? Math.max(0, Math.floor(tokensBefore)) : 0;
};

const projectRow = (row: RuntimeContextMessage, options: ContextProjectionOptions): AgentMessage[] => {
  if (row.meta?.messageKind === "generation_result" && !["completed", "failed"].includes(String(row.meta.generationStatus))) {
    // Do not advance the resume marker over a mutable placeholder.
    throw new Error("Generation result is not settled");
  }
  return row.meta?.generationTaskId
    ? [projectGenerationSessionMessage({ ...row, meta: row.meta ?? {}, provider: row.provider ?? null, model: row.model ?? null, createdAt: new Date(String(row.meta?.createdAt ?? 0)) })]
    : contextToPiMessages([row], options) as unknown as AgentMessage[];
};

/**
 * Append only the missing durable tail; compacted history must never re-enter context.
 * A durable compaction always becomes a native compaction boundary, never a message.
 */
export function syncCloudContext(manager: SessionManager, context: RuntimeContext, options: ContextProjectionOptions = {}): boolean {
  const marker = manager.getCustomEntries("cohub.context").at(-1)?.data as
    { revision?: string; throughTurnId?: string | null; compactionKey?: string | null } | undefined;
  if (marker?.revision === context.revision) return false;

  // The durable reader already trimmed history to `[newest compaction, ...retained]`.
  let compactionIndex = -1;
  context.messages.forEach((message, index) => { if (isCompaction(message)) compactionIndex = index; });
  const compaction = compactionIndex >= 0 ? context.messages[compactionIndex] : undefined;
  const region = compaction ? context.messages.slice(compactionIndex + 1) : context.messages;

  // Match durable rows against what the native file already holds so a resume never
  // re-appends history the harness has already seen.
  const entries = manager.getEntries();
  const entryIds = new Set(entries.map((entry) => entry.id));
  const messageIds = new Set<string>();
  const entryIdByMessageId = new Map<string, string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as unknown as { meta?: { messageId?: string }; id?: string };
    for (const id of [message.meta?.messageId, message.id]) {
      if (typeof id !== "string" || !id) continue;
      messageIds.add(id);
      if (!entryIdByMessageId.has(id)) entryIdByMessageId.set(id, entry.id);
    }
  }
  let after = -1;
  region.forEach((message, index) => {
    const agentSessionEntryId = typeof message.meta?.agentSessionEntryId === "string" ? message.meta.agentSessionEntryId : null;
    const knownEntryId = agentSessionEntryId && entryIds.has(agentSessionEntryId) ? agentSessionEntryId : null;
    if (knownEntryId && !entryIdByMessageId.has(message.id)) entryIdByMessageId.set(message.id, knownEntryId);
    if (marker?.throughTurnId && message.turnId === marker.throughTurnId) after = index;
    if (knownEntryId || messageIds.has(message.id)) after = Math.max(after, index);
  });

  // Project and validate the whole missing tail before touching the live projection.
  const pending = region.slice(after + 1).map((row) => ({ row, messages: projectRow(row, options) }));
  // Anchor the boundary at the first kept row that has (or will have) a native entry. A first row
  // without one (dropped URL image, system note) simply does not become the anchor, so a boundary can
  // never be missing, fail late, or leave a half-written tail behind.
  let anchor = region.slice(0, after + 1).map((row) => entryIdByMessageId.get(row.id)).find((id): id is string => Boolean(id)) ?? null;
  let changed = false;
  for (const { row, messages } of pending) {
    for (const agentMessage of messages) {
      const meta = asRecord((agentMessage as unknown as Record<string, unknown>).meta);
      const id = typeof meta.messageId === "string" ? meta.messageId : undefined;
      const appendedId = manager.appendMessage(agentMessage, { id });
      if (!entryIdByMessageId.has(row.id)) entryIdByMessageId.set(row.id, appendedId);
      anchor ??= appendedId;
      changed = true;
    }
  }

  const compactionKey = compaction ? compactionKeyOf(compaction) : null;
  if (compaction && (compactionKey === null || marker?.compactionKey !== compactionKey)) {
    // Without a kept entry the boundary anchors at a marker: the summary replaces the history.
    manager.appendCompaction(compactionSummaryOf(compaction), anchor ?? manager.appendCustomEntry("cohub.sync", { compactionKey }), compactionTokensBeforeOf(compaction));
    changed = true;
  }

  manager.appendCustomEntry("cohub.context", { revision: context.revision, throughTurnId: context.throughTurnId, compactionKey });
  return changed;
}
