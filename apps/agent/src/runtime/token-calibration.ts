import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { estimateProxyContextTokens } from "./compaction-policy.js";

/**
 * Per-model ratio of provider-reported tokens to our `chars / 4` estimate,
 * learned at runtime from real usage and overflow errors. Tokenizers differ by
 * up to ~2x across providers, so usage reported by one model (or the raw
 * estimate) cannot size requests for another.
 *
 * - `context`: live agent requests (provider may drop old thinking, etc.).
 * - `summary`: serialized-transcript summarization requests.
 */
export type TokenRatioKind = "context" | "summary";

type ModelRef = { provider: string; id: string };

const MIN_SAMPLE_ESTIMATE: Record<TokenRatioKind, number> = { context: 32_768, summary: 4_096 };
const MIN_RATIO = 0.25;
const MAX_RATIO = 8;
const SMOOTHING = 0.3;

const ratios = new Map<string, number>();

const keyOf = (kind: TokenRatioKind, model: ModelRef) => `${kind}\0${model.provider}\0${model.id}`;

export function getTokenRatio(kind: TokenRatioKind, model: ModelRef): number | undefined {
  return ratios.get(keyOf(kind, model));
}

/**
 * Record one observation. Overflow errors report the exact size of a rejected
 * request, so they only ever raise the ratio; normal usage is smoothed.
 */
export function observeTokenRatio(
  kind: TokenRatioKind,
  model: ModelRef,
  estimatedTokens: number,
  actualTokens: number,
  options?: { overflow?: boolean },
): number | undefined {
  const key = keyOf(kind, model);
  if (!(estimatedTokens >= MIN_SAMPLE_ESTIMATE[kind]) || !(actualTokens > 0)) return ratios.get(key);
  const sample = Math.min(MAX_RATIO, Math.max(MIN_RATIO, actualTokens / estimatedTokens));
  const previous = ratios.get(key);
  const next = previous === undefined
    ? sample
    : options?.overflow
      ? Math.max(previous, sample)
      : previous + SMOOTHING * (sample - previous);
  ratios.set(key, next);
  return next;
}

export function resetTokenRatios() {
  ratios.clear();
}

const toInt = (value: string | undefined) => {
  if (!value) return undefined;
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

// [actual, limit] capture groups; `limit` may be absent.
const OVERFLOW_TOKEN_PATTERNS: Array<{ pattern: RegExp; actual: number; limit?: number }> = [
  { pattern: /([\d,]+) tokens\s*>\s*([\d,]+)/i, actual: 1, limit: 2 }, // Anthropic
  { pattern: /输入Tokens数量\((\d+)\)超过系统限制\((\d+)\)/, actual: 1, limit: 2 }, // Cohub proxy
  { pattern: /maximum context length is ([\d,]+) tokens.*?requested (?:about )?([\d,]+) tokens/is, actual: 2, limit: 1 }, // OpenAI / OpenRouter
  { pattern: /input token count \(([\d,]+)\) exceeds the maximum number of tokens allowed \(([\d,]+)\)/i, actual: 1, limit: 2 }, // Gemini
  { pattern: /input length \(([\d,]+)\) exceeds (?:the )?model'?s maximum context length \(([\d,]+)\)/i, actual: 1, limit: 2 },
  { pattern: /maximum prompt length is ([\d,]+) but the request contains ([\d,]+) tokens/i, actual: 2, limit: 1 }, // xAI
  { pattern: /prompt token count of ([\d,]+) exceeds the limit of ([\d,]+)/i, actual: 1, limit: 2 }, // Copilot
  { pattern: /prompt has ([\d,]+) tokens?, but the configured context size is ([\d,]+)/i, actual: 1, limit: 2 },
];

/** Extract the rejected request size (and limit, when present) from an overflow error. */
export function parseOverflowTokens(errorMessage: string | undefined): { actual: number; limit?: number } | null {
  if (!errorMessage) return null;
  // Proxies may nest JSON-encoded upstream errors, escaping `<`/`>` as \u003c/\u003e.
  const text = errorMessage.replace(/\\+u003e/gi, ">").replace(/\\+u003c/gi, "<");
  for (const { pattern, actual, limit } of OVERFLOW_TOKEN_PATTERNS) {
    const match = text.match(pattern);
    const actualTokens = toInt(match?.[actual]);
    if (actualTokens) return { actual: actualTokens, limit: limit ? toInt(match?.[limit]) : undefined };
  }
  return null;
}

/** Learn the live-context ratio from an overflow error on a main agent request. */
export function observeContextOverflow(model: ModelRef, messages: readonly unknown[], errorMessage: string | undefined) {
  const parsed = parseOverflowTokens(errorMessage);
  if (!parsed) return;
  observeTokenRatio("context", model, estimateProxyContextTokens(messages as AgentMessage[]), parsed.actual, { overflow: true });
}
