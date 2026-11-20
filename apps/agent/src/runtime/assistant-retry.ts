import { DEFAULT_MAX_AGENT_RETRY_DELAY_MS, type AssistantMessage } from "@earendil-works/pi-ai";
import { isContextOverflowFailure, isRetryableProviderError } from "./provider-errors.js";

// 上游瞬时故障（如 503 暂不可用）常持续数十秒，退避总窗口约 2 分钟。
export const AGENT_RETRY_MAX_RETRIES = 6;
export const AGENT_RETRY_BASE_DELAY_MS = 2_000;
export const AGENT_RETRY_MAX_DELAY_MS = DEFAULT_MAX_AGENT_RETRY_DELAY_MS;

function hasAssistantContent(message: AssistantMessage): boolean {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.length > 0;
}

function isEmptySuccessfulAssistantMessage(message: AssistantMessage | undefined): boolean {
  if (!message) return false;
  if (message.stopReason === "error" || message.stopReason === "aborted") return false;
  return !hasAssistantContent(message);
}

export function isRetryableAssistantFailure(message: AssistantMessage | undefined): boolean {
  return isRetryableProviderError(message)
    || isEmptySuccessfulAssistantMessage(message)
    || isContextOverflowFailure(message);
}

export type AssistantRetryOutcome = {
  shouldRetry: boolean;
  retryAttempt: number;
  retryDelayMs?: number;
  retryReason?: string;
  forceCompaction?: boolean;
};

export function getAssistantRetryOutcome(message: AssistantMessage | undefined, retryAttempt: number): AssistantRetryOutcome {
  if (!isRetryableAssistantFailure(message)) {
    return { shouldRetry: false, retryAttempt, retryReason: "not_retryable" };
  }
  if (retryAttempt >= AGENT_RETRY_MAX_RETRIES) {
    return { shouldRetry: false, retryAttempt, retryReason: "retry_exhausted" };
  }

  const overflow = isContextOverflowFailure(message);
  return {
    shouldRetry: true,
    retryAttempt: retryAttempt + 1,
    // Overflow recovery starts with force-compact; no backoff needed.
    retryDelayMs: overflow ? 0 : Math.min(AGENT_RETRY_BASE_DELAY_MS * 2 ** retryAttempt, AGENT_RETRY_MAX_DELAY_MS),
    retryReason: overflow
      ? "context_overflow"
      : message?.stopReason === "error"
        ? (message?.errorMessage ?? "assistant_error")
        : "empty_assistant_message",
    forceCompaction: overflow,
  };
}

export function shouldResetAssistantRetryState(message: AssistantMessage | undefined): boolean {
  return !isRetryableAssistantFailure(message);
}

/** Resolves early when `signal` aborts, so a stopped Turn does not wait out the backoff. */
export function waitRetryBackoff(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
