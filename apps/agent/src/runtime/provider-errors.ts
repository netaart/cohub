import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";

const COHUB_RETRYABLE_ERROR_OVERRIDE_PATTERN = /\b400\b.*(?:upstream(?:_error)?:?\s*upstream request failed|upstream response failed.*(?:bad_response_status_code|stage["']?\s*[:=]\s*["']?upstream_response))/i;
const COHUB_NON_RETRYABLE_ERROR_PATTERN = /insufficient[_ ](?:user[_ ])?quota|quota exceeded|out of budget|billing|余额不足|额度不足|invalid (?:request|url)|content[_ ]filter|request (?:is )?too large|payload too large/i;
const COHUB_MODEL_UNAVAILABLE_PATTERN = /model (?:is )?(?:(?:not )?available|unavailable)|requested model is not available/i;
const COHUB_RETRYABLE_ERROR_PATTERN = /responses_missing_terminal|anthropic_missing_message_stop|upstream_temporarily_unavailable|stream_read_error|upstream_http2_stream_error|upstream_replay_blocked|upstream HTTP\/2 stream failed|stream ended before a terminal response event|upstream service temporarily unavailable|upstream request failed/i;

function getHttpErrorStatus(errorMessage: string): number | null {
  const status = errorMessage.match(/\b([45]\d{2})\b/)?.[1];
  return status ? Number(status) : null;
}

// null: inconclusive from the text alone; defer to pi-ai.
function classifyProviderErrorMessage(errorMessage: string): boolean | null {
  if (COHUB_RETRYABLE_ERROR_OVERRIDE_PATTERN.test(errorMessage)) return true;
  if (COHUB_NON_RETRYABLE_ERROR_PATTERN.test(errorMessage)) return false;

  const status = getHttpErrorStatus(errorMessage);
  if (status != null) return status === 408 || status === 413 || status === 429 || status >= 500;
  if (COHUB_MODEL_UNAVAILABLE_PATTERN.test(errorMessage)) return false;
  if (COHUB_RETRYABLE_ERROR_PATTERN.test(errorMessage)) return true;

  return null;
}

export function isRetryableProviderError(message: AssistantMessage | undefined): boolean {
  if (message?.stopReason !== "error" || !message.errorMessage) return false;
  return classifyProviderErrorMessage(message.errorMessage) ?? isRetryableAssistantError(message);
}

/**
 * Supplementary overflow patterns not yet covered by upstream pi-ai.
 * The cohub provider proxy returns Chinese error messages on context overflow.
 */
const LOCAL_OVERFLOW_PATTERNS = [
  /超过系统限制/, // Cohub proxy: "输入Tokens数量(N)超过系统限制(M)"
];

/**
 * Explicit context-window overflow (provider error). Silent / length-stop overflow
 * is intentionally excluded so we never discard a successful-looking response.
 */
export function isContextOverflowFailure(message: AssistantMessage | undefined): boolean {
  if (message?.stopReason !== "error" || !message.errorMessage) return false;
  if (isContextOverflow(message)) return true;
  const errorMessage = message.errorMessage;
  return LOCAL_OVERFLOW_PATTERNS.some((p) => p.test(errorMessage));
}
