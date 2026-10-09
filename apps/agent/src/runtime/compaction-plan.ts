import type { AgentMessage, Entry } from "@earendil-works/pi-agent-core";
import type { ContextCompactionScope } from "@cohub/protocol/model";

type CompactionPreparationLike = {
  messagesToSummarize: readonly unknown[];
  turnPrefixMessages: readonly unknown[];
  isSplitTurn: boolean;
};

export function getCompactionSummaryMessageCount(
  preparation: CompactionPreparationLike,
): number {
  return preparation.messagesToSummarize.length + preparation.turnPrefixMessages.length;
}

/**
 * Id of the entry whose message starts the retained tail. Pi's plan carries the
 * retained messages themselves (the same objects as the entries'), not entry ids.
 */
export function findFirstKeptEntryId(
  entries: readonly Entry[],
  retainedTail: readonly AgentMessage[],
): string | undefined {
  const first = retainedTail[0];
  if (!first) return undefined;
  return entries.find((entry) => entry.type === "message" && entry.message === first)?.id;
}

export function resolveCompactionScope(
  preparation: Pick<CompactionPreparationLike, "isSplitTurn">,
  firstKeptTurnId: string | null,
): { scope: ContextCompactionScope; ownerTurnId: string | null } {
  return preparation.isSplitTurn && firstKeptTurnId
    ? { scope: "within_turn", ownerTurnId: firstKeptTurnId }
    : { scope: "between_turns", ownerTurnId: null };
}

/**
 * Reject compactions whose retained context is not meaningfully smaller than
 * what would have been sent. Threshold-triggered compactions require at least
 * a 20% reduction — image-dominated contexts that compaction cannot shrink
 * would otherwise compact on every round without reducing the payload.
 * Overflow-recovery (force) compactions only require any reduction.
 */
export function validateCompactionEffect(input: {
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  inputBudget: number;
  force?: boolean;
}): "compaction_no_effect" | "compaction_still_over_budget" | null {
  const minimumReduction = input.force ? 0 : 0.2;
  if (input.estimatedTokensAfter >= input.estimatedTokensBefore * (1 - minimumReduction)) {
    return "compaction_no_effect";
  }
  if (input.estimatedTokensAfter >= input.inputBudget) {
    return "compaction_still_over_budget";
  }
  return null;
}
