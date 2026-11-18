import type { Usage } from "@cohub/protocol/core";
import type {
  ContextCompactionMeta,
  SessionTurnCompactionSummary,
} from "@cohub/protocol/model";

type CompactionMessageLike = {
  meta?: unknown;
  usage?: Usage | null;
  durationMs?: number | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  isFiniteNumber(value) && Number.isInteger(value) && value >= 0;

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isNullableNonNegativeInteger = (value: unknown): value is number | null =>
  value === null || isNonNegativeInteger(value);

export function getContextCompactionMeta(meta: unknown): ContextCompactionMeta | null {
  const messageMeta = asRecord(meta);
  const compaction = asRecord(messageMeta?.compaction);
  const placement = asRecord(compaction?.placement);
  const providerCalls = asRecord(compaction?.providerCalls);
  const hasProviderCalls = compaction?.providerCalls !== undefined;
  if (
    messageMeta?.messageKind !== "compacted" ||
    compaction?.version !== 1 ||
    typeof compaction.compactionId !== "string" ||
    !compaction.compactionId ||
    (compaction.scope !== "between_turns" && compaction.scope !== "within_turn") ||
    !isNullableString(compaction.ownerTurnId) ||
    !isNullableNonNegativeInteger(compaction.ordinalInTurn) ||
    !isNullableNonNegativeInteger(compaction.llmRound) ||
    (compaction.triggerReason !== "threshold" && compaction.triggerReason !== "overflow_recovery" && compaction.triggerReason !== "requested") ||
    !isNonNegativeInteger(compaction.contextWindow) ||
    !isNonNegativeInteger(compaction.tokensBefore) ||
    !isNullableNonNegativeInteger(compaction.estimatedTokensAfter) ||
    typeof compaction.provider !== "string" ||
    !compaction.provider ||
    typeof compaction.model !== "string" ||
    !compaction.model ||
    !isNonNegativeInteger(compaction.keepRecentTokens) ||
    !isNonNegativeInteger(compaction.summarizedMessageCount) ||
    !isNonNegativeInteger(compaction.attemptCount) ||
    (hasProviderCalls && (
      !providerCalls ||
      !isNonNegativeInteger(providerCalls.total) ||
      !isNonNegativeInteger(providerCalls.succeeded) ||
      !isNonNegativeInteger(providerCalls.failed) ||
      providerCalls.succeeded + providerCalls.failed !== providerCalls.total
    )) ||
    (compaction.providerCallCount !== undefined && !isNonNegativeInteger(compaction.providerCallCount)) ||
    typeof compaction.isSplitTurn !== "boolean" ||
    typeof compaction.firstKeptEntryId !== "string" ||
    !compaction.firstKeptEntryId ||
    !isNullableString(compaction.archivePath) ||
    typeof compaction.compactedAt !== "string" ||
    !compaction.compactedAt ||
    typeof placement?.beforeSessionEntryId !== "string" ||
    !placement.beforeSessionEntryId ||
    !isNullableString(placement.beforeMessageId)
  ) {
    return null;
  }
  return compaction as ContextCompactionMeta;
}

export function addUsage(
  first: Usage | null | undefined,
  second: Usage | null | undefined,
): Usage | null {
  if (!first && !second) return null;
  const hasCost = Boolean(first?.cost || second?.cost);
  return {
    input: (first?.input ?? 0) + (second?.input ?? 0),
    output: (first?.output ?? 0) + (second?.output ?? 0),
    cacheRead: (first?.cacheRead ?? 0) + (second?.cacheRead ?? 0),
    cacheWrite: (first?.cacheWrite ?? 0) + (second?.cacheWrite ?? 0),
    totalTokens: (first?.totalTokens ?? 0) + (second?.totalTokens ?? 0),
    cost: hasCost
      ? {
          input: (first?.cost?.input ?? 0) + (second?.cost?.input ?? 0),
          output: (first?.cost?.output ?? 0) + (second?.cost?.output ?? 0),
          cacheRead: (first?.cost?.cacheRead ?? 0) + (second?.cost?.cacheRead ?? 0),
          cacheWrite: (first?.cost?.cacheWrite ?? 0) + (second?.cost?.cacheWrite ?? 0),
          total: (first?.cost?.total ?? 0) + (second?.cost?.total ?? 0),
        }
      : null,
  };
}

export function summarizeSessionTurnCompactions(
  messages: readonly CompactionMessageLike[],
): SessionTurnCompactionSummary | null {
  let count = 0;
  let summarizedMessageCountTotal = 0;
  let attemptCountTotal = 0;
  let usage: Usage | null = null;
  let durationMsTotal: number | null = null;
  let last: SessionTurnCompactionSummary["last"] = null;

  for (const message of messages) {
    const compaction = getContextCompactionMeta(message.meta);
    if (compaction?.scope !== "within_turn") continue;

    count += 1;
    summarizedMessageCountTotal += compaction.summarizedMessageCount;
    attemptCountTotal += compaction.attemptCount;
    usage = addUsage(usage, message.usage);
    if (typeof message.durationMs === "number" && Number.isFinite(message.durationMs)) {
      durationMsTotal = (durationMsTotal ?? 0) + Math.max(0, Math.floor(message.durationMs));
    }
    last = {
      compactionId: compaction.compactionId,
      tokensBefore: compaction.tokensBefore,
      estimatedTokensAfter: compaction.estimatedTokensAfter,
      compactedAt: compaction.compactedAt,
    };
  }

  return count > 0
    ? { count, summarizedMessageCountTotal, attemptCountTotal, usage, durationMsTotal, last }
    : null;
}
