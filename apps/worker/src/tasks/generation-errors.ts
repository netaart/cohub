import {
  GenerationConfigError,
  GenerationProviderError,
  GenerationTimeoutError,
  GenerationUnsupportedAdapterError,
  GenerationValidationError,
} from "@neta-art/generation";

const PROVIDER_REQUEST_FAILED = "Generation provider request failed";
const CREDENTIALS_REJECTED = "Generation provider rejected the configured credentials";
const RATE_LIMITED = "Generation provider rate limit exceeded";
const UNAVAILABLE = "Generation provider is temporarily unavailable";
const TIMED_OUT = "Generation request timed out";

const MAX_MESSAGE_DEPTH = 4;

// 错误文本会显示给用户；上游地址、请求 id 和日志形的诊断内容只留在日志里。
const PROVIDER_MESSAGE_NOISE = [
  /\(\s*request\s*id\s*:[^)]*\)/gi,
  /\[\s*request\s*id\s*:[^\]]*\]/gi,
  /\b[\w-]*(?:request|task|trace|span)[_-]?id\b["']?\s*[:=]\s*["']?[\w.:-]+["']?/gi,
  /\b[\w-]*(?:url|host|path)\b["']?\s*[:=]\s*["']?[^\s"',;}]+["']?/gi,
  /https?:\/\/[^\s"'<>]+/gi,
];

const DIAGNOSTIC_BODY = /\b(?:newapi_status|upstream_status|upstream_url|upstream_message|response_code|origin|stage)=/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function sanitizeProviderMessage(message: string): string {
  let sanitized = message;
  for (const pattern of PROVIDER_MESSAGE_NOISE) sanitized = sanitized.replace(pattern, " ");
  return sanitized
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/^[\s,;:]+|[\s,;:]+$/g, "")
    .trim();
}

function rawProviderMessage(record: Record<string, unknown>): string | null {
  const error = record.error;
  const nested = isRecord(error) ? error : null;
  return (
    (nested ? stringField(nested.message) : null) ??
    (typeof error === "string" ? stringField(error) : null) ??
    stringField(record.message) ??
    stringField(record.detail)
  );
}

function providerBodyMessage(text: string, depth = 0): string | null {
  if (depth > MAX_MESSAGE_DEPTH) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const parsed = parseJson(trimmed);
  if (parsed !== undefined) {
    if (!isRecord(parsed)) return null;
    const message = rawProviderMessage(parsed);
    return message ? providerBodyMessage(message, depth + 1) : null;
  }
  if (trimmed.startsWith("<") || DIAGNOSTIC_BODY.test(trimmed)) return null;
  return sanitizeProviderMessage(trimmed) || null;
}

function providerFailureMessage(error: GenerationProviderError): string {
  const status = error.status;
  if (status === undefined) {
    return error instanceof GenerationTimeoutError ? TIMED_OUT : PROVIDER_REQUEST_FAILED;
  }
  const controlled =
    status === 401 || status === 403 ? CREDENTIALS_REJECTED : status === 429 ? RATE_LIMITED : null;
  const detail = controlled === null ? providerBodyMessage(error.body ?? "") : null;
  const message = controlled ?? detail ?? (status >= 500 ? UNAVAILABLE : PROVIDER_REQUEST_FAILED);
  return `${message} — HTTP ${status}`;
}

export function normalizeGenerationError(error: unknown): Error {
  if (error instanceof GenerationValidationError) {
    return new Error(`Invalid generation input: ${error.message}`);
  }
  if (error instanceof GenerationProviderError) {
    return new Error(providerFailureMessage(error));
  }
  if (error instanceof GenerationConfigError || error instanceof GenerationUnsupportedAdapterError) {
    return new Error(error.message);
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}
