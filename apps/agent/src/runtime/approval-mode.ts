import { resolveHarness, validateCodexApprovalMode, type CodexApprovalMode } from "@cohub/protocol";

export function readTurnApprovalMode(meta: unknown): CodexApprovalMode | undefined {
  const value = meta && typeof meta === "object" && !Array.isArray(meta) ? (meta as Record<string, unknown>).codexApprovalMode : undefined;
  validateCodexApprovalMode({ harness: resolveHarness(meta), codexApprovalMode: value });
  return value as CodexApprovalMode | undefined;
}

/** Never let the last queued turn change the permissions of an earlier prompt. */
export function limitApprovalBatch<T extends { meta: unknown }>(turns: T[]): T[] {
  const first = turns[0];
  if (!first) return [];
  const mode = readTurnApprovalMode(first.meta);
  const end = turns.findIndex((turn) => readTurnApprovalMode(turn.meta) !== mode);
  return end === -1 ? turns : turns.slice(0, end);
}
