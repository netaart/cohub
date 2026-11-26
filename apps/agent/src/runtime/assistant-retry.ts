import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Span } from "@opentelemetry/api";
import { logger } from "../logger.js";
import { isContextOverflowFailure, isRetryableProviderError } from "./provider-errors.js";

export const AGENT_RETRY_MAX_RETRIES = 2;
export const AGENT_RETRY_BASE_DELAY_MS = 1000;

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

type AssistantRetryOutcome = {
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
    retryDelayMs: overflow ? 0 : AGENT_RETRY_BASE_DELAY_MS * 2 ** retryAttempt,
    retryReason: overflow
      ? "context_overflow"
      : message?.stopReason === "error"
        ? (message?.errorMessage ?? "assistant_error")
        : "empty_assistant_message",
    forceCompaction: overflow,
  };
}

export function recordAssistantRetrySpanAttributes(span: Span | undefined, outcome: AssistantRetryOutcome) {
  if (!span) return;
  span.setAttribute("agent.retry.should_retry", outcome.shouldRetry);
  span.setAttribute("agent.retry.attempt", outcome.retryAttempt);
  if (outcome.retryDelayMs != null) span.setAttribute("agent.retry.delay_ms", outcome.retryDelayMs);
  if (outcome.retryReason) span.setAttribute("agent.retry.reason", outcome.retryReason);
  if (outcome.forceCompaction) span.setAttribute("agent.retry.force_compaction", true);
}

export function logAssistantRetry(sessionId: string, turnId: string | undefined, outcome: AssistantRetryOutcome) {
  const contextInfo = `sessionId=${sessionId}${turnId ? ` turnId=${turnId}` : ""}`;
  const reason = outcome.retryReason ?? "not_retryable";
  if (outcome.shouldRetry) {
    logger.info(
      `[Agent] assistant retry scheduled ${contextInfo} attempt=${outcome.retryAttempt} delayMs=${outcome.retryDelayMs} reason=${reason}`,
    );
  } else if (outcome.retryReason === "retry_exhausted") {
    logger.warn(`[Agent] assistant retry exhausted ${contextInfo} attempt=${outcome.retryAttempt}`);
  } else {
    logger.debug(`[Agent] assistant retry not scheduled ${contextInfo} attempt=${outcome.retryAttempt} reason=${reason}`);
  }
}

export function shouldResetAssistantRetryState(message: AssistantMessage | undefined): boolean {
  return !isRetryableAssistantFailure(message);
}
