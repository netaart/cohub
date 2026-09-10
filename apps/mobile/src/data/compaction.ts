import type { ContentBlock, MessageRecord } from "@neta-art/cohub";

export type CompactionInfo = {
  /** Summary the runtime stored for the compacted context; empty when absent. */
  summary: string;
  /** Server compaction metadata (message counts, token counts) when present. */
  meta: Record<string, unknown>;
};

export type CompactionStats = {
  summarizedMessageCount: number | null;
  tokensBefore: number | null;
  tokensAfter: number | null;
};

type SystemNoteBlock = Extract<ContentBlock, { type: "system_note" }>;

function isCompactedSystemNote(block: ContentBlock): block is SystemNoteBlock {
  return block.type === "system_note" && block.note_type === "compacted";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Compaction ("context") turns and messages are identified by a `compacted`
 * system note, a `compacted` messageKind, or turn metadata. Regular messages
 * return null so callers can render them untouched.
 */
export function compactionFromMessage(
  message: Pick<MessageRecord, "content" | "meta">,
): CompactionInfo | null {
  const note = (message.content ?? []).find(isCompactedSystemNote);
  const meta = record(message.meta?.compaction);
  const kind = message.meta?.messageKind;
  if (!note && !meta && kind !== "compacted") return null;
  return { summary: note?.text?.trim() ?? "", meta: meta ?? {} };
}

export function compactionStats(meta: Record<string, unknown>): CompactionStats {
  return {
    summarizedMessageCount: finiteNumber(meta.summarizedMessageCount),
    tokensBefore: finiteNumber(meta.tokensBefore),
    tokensAfter:
      finiteNumber(meta.estimatedTokensAfter) ?? finiteNumber(meta.tokensAfter),
  };
}
