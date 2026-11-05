/**
 * Whitelist of message-meta keys that are safe/necessary to broadcast on
 * `session.message.persisted` realtime events.
 *
 * `messageOrdinal` MUST stay in this list: the web client dedupes intermediate
 * messages by `ordinal:N` (see packages/sdk session-generation-stream
 * `getIntermediateMessageKey`). The REST stream-snapshot path also keys by
 * ordinal. If persisted realtime events drop the ordinal, the same logical
 * message lands under two incompatible dedupe keys (`ordinal:N` from snapshot
 * recovery vs `id:<uuid>` from the persisted event), producing duplicate
 * entries that crash Svelte's `{#each ... (id)}` in ProcessCard with
 * `each_key_duplicate` — the streaming UI freezes and only recovers once the
 * turn finalizes and reloads from the single-source messages.json.
 */
const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const COMPACTION_META_KEYS = [
  "version",
  "compactionId",
  "scope",
  "ownerTurnId",
  "ordinalInTurn",
  "llmRound",
  "triggerReason",
  "contextWindow",
  "tokensBefore",
  "estimatedTokensAfter",
  "provider",
  "model",
  "keepRecentTokens",
  "summarizedMessageCount",
  "attemptCount",
  "providerCalls",
  "providerCallCount",
  "isSplitTurn",
  "compactedAt",
] as const;

const pickRealtimeCompactionMeta = (value: unknown) => {
  const compaction = asRecord(value);
  if (!compaction) return undefined;
  const picked: Record<string, unknown> = {};
  for (const key of COMPACTION_META_KEYS) {
    if (key === "providerCalls") continue;
    if (compaction[key] !== undefined) picked[key] = compaction[key];
  }
  const providerCalls = asRecord(compaction.providerCalls);
  if (
    providerCalls &&
    typeof providerCalls.total === "number" &&
    typeof providerCalls.succeeded === "number" &&
    typeof providerCalls.failed === "number"
  ) {
    picked.providerCalls = {
      total: providerCalls.total,
      succeeded: providerCalls.succeeded,
      failed: providerCalls.failed,
    };
  }
  const placement = asRecord(compaction.placement);
  if (placement && (typeof placement.beforeMessageId === "string" || placement.beforeMessageId === null)) {
    picked.placement = { beforeMessageId: placement.beforeMessageId };
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
};

export const REALTIME_MESSAGE_META_KEYS = [
  "messageKind",
  "clientMessageId",
  "anchorUserMessageId",
  "userId",
  "contentDetail",
  "contentPlaceholder",
  "historySummary",
  "turnId",
  "messageId",
  "messageOrdinal",
  "contextWindow",
  "compaction",
] as const;

export const pickRealtimeMessageMeta = (
  meta: Record<string, unknown> | null | undefined,
) => {
  if (!meta) return null;
  const picked: Record<string, unknown> = {};
  for (const key of REALTIME_MESSAGE_META_KEYS) {
    const value = key === "compaction" ? pickRealtimeCompactionMeta(meta[key]) : meta[key];
    if (value !== undefined) picked[key] = value;
  }
  return Object.keys(picked).length > 0 ? picked : null;
};
