import { resolveHarness } from "@cohub/protocol";
import { isAgentTurn, type SessionTurnIndexItem } from "@cohub/protocol/model";
import type { ModelCatalogEntry } from "./types.js";

const SETTLED_STATUSES = new Set(["completed", "failed", "interrupted"]);

export type ColdResendTurn = Pick<
  SessionTurnIndexItem,
  "id" | "sequence" | "status" | "completedAt" | "provider" | "model" | "executionKind" | "intent" | "harness" | "finalUsageIsTotal"
> & {
  finalUsage?: SessionTurnIndexItem["finalUsage"];
  totalUsage?: SessionTurnIndexItem["totalUsage"];
  meta?: Record<string, unknown> | null;
};

export type ColdResendEstimate = {
  turnId: string;
  /** Unix milliseconds, or `0` after a model switch. */
  expiresAt: number;
  contextTokens: number;
  costUsd: number;
};

function positiveNumber(record: unknown, key: string): number | null {
  const value = record && typeof record === "object"
    ? (record as Record<string, unknown>)[key]
    : undefined;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function promptTokens(usage: ColdResendTurn["finalUsage"]): number {
  return (usage?.input ?? 0) + (usage?.cacheRead ?? 0) +
    (usage?.cacheWrite ?? 0) + (usage?.output ?? 0);
}

/** Estimates cold-cache resend cost with an inclusive USD threshold (default: 1). */
export function estimateColdResend(
  turns: readonly ColdResendTurn[],
  selected: ModelCatalogEntry | null | undefined,
  { minCostUsd = 1 }: { minCostUsd?: number } = {},
): ColdResendEstimate | null {
  if (!Number.isFinite(minCostUsd) || minCostUsd < 0) {
    throw new RangeError("minCostUsd must be a finite non-negative number");
  }
  if (!selected) return null;

  const byId = new Map<string, ColdResendTurn>();
  for (const turn of turns) {
    const first = byId.get(turn.id);
    if (!first) byId.set(turn.id, turn);
    else if (first.finalUsageIsTotal === undefined && turn.finalUsageIsTotal !== undefined) {
      byId.set(turn.id, { ...first, finalUsageIsTotal: turn.finalUsageIsTotal });
    }
  }

  let last: ColdResendTurn | undefined;
  let cached: ColdResendTurn | undefined;
  let contextTokens = 0;
  for (const turn of byId.values()) {
    if (!isAgentTurn(turn) || turn.intent === "compact" || turn.status === "cancelled" ||
      resolveHarness({ harness: turn.meta?.harness ?? turn.harness }) !== "cohub") continue;
    if (!last || turn.sequence > last.sequence) last = turn;
    if (cached && turn.sequence <= cached.sequence) continue;
    const tokens = turn.finalUsageIsTotal ? 0 : promptTokens(turn.finalUsage);
    // Cumulative usage signals a model call, but cannot describe its cached prefix.
    if (tokens > 0 || turn.finalUsageIsTotal || promptTokens(turn.totalUsage) > 0) {
      cached = turn;
      contextTokens = tokens;
    }
  }
  if (!last || !SETTLED_STATUSES.has(last.status) || !cached?.completedAt ||
    !(contextTokens > 0)) return null;

  const price = positiveNumber(selected.model.cost, "cacheWrite") ??
    positiveNumber(selected.model.cost, "input");
  if (price === null) return null;
  const costUsd = (contextTokens * price) / 1_000_000;
  if (!Number.isFinite(costUsd) || costUsd < minCostUsd) return null;

  const completedAt = Date.parse(cached.completedAt);
  if (!Number.isFinite(completedAt)) return null;
  const sameModel = (cached.provider ?? "cohub") === selected.provider && cached.model === selected.id;
  let expiresAt = 0;
  if (sameModel) {
    const ttlSeconds = positiveNumber(selected.model.promptCache, "short");
    if (ttlSeconds === null) return null;
    expiresAt = completedAt + ttlSeconds * 1000;
    if (!Number.isFinite(expiresAt)) return null;
  }
  return { turnId: last.id, expiresAt, contextTokens, costUsd };
}
