import type { RuntimeMessage } from "@neta-art/cohub";
import { record } from "./json-rpc.js";

const fields = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteInputTokens", "totalTokens"] as const;
export type CodexTokenTotals = Record<typeof fields[number], number>;
const tokens = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
export const codexTokenTotals = (value: unknown): CodexTokenTotals => {
  const input = record(value);
  return Object.fromEntries(fields.map((key) => [key, tokens(input[key])])) as CodexTokenTotals;
};
export const subtractCodexTokens = (total: CodexTokenTotals, base: CodexTokenTotals): CodexTokenTotals =>
  Object.fromEntries(fields.map((key) => [key, Math.max(0, total[key] - base[key])])) as CodexTokenTotals;

export function codexUsage(total: CodexTokenTotals): NonNullable<RuntimeMessage["usage"]> {
  return { input: Math.max(0, total.inputTokens - total.cachedInputTokens - total.cacheWriteInputTokens), output: total.outputTokens, cacheRead: total.cachedInputTokens, cacheWrite: total.cacheWriteInputTokens, totalTokens: total.totalTokens };
}
