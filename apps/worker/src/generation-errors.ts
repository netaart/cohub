import { setTimeout as sleep } from "node:timers/promises";
import {
  GenerationConfigError,
  GenerationProviderError,
  GenerationUnsupportedAdapterError,
  GenerationValidationError,
} from "@neta-art/generation";

type GatewayFailure = {
  message?: string;
  type?: string;
  code?: string;
  category?: string;
  upstreamStatus?: number;
  requestId?: string;
};

type ProviderErrorKind = "credentials" | "rate_limited" | "rejected" | "no_output" | "unavailable" | "upstream" | "failed";

const headlines: Record<ProviderErrorKind, string> = {
  credentials: "Generation provider rejected the configured credentials",
  rate_limited: "Generation provider rate limit exceeded",
  rejected: "Generation provider rejected the request",
  no_output: "Generation provider returned no output",
  unavailable: "Generation provider is temporarily unavailable",
  upstream: "Generation provider failed",
  failed: "Generation provider request failed",
};

const invalidRequestTypes = new Set(["invalid_request_error", "invalid_request"]);
const NO_OUTPUT = /\bempty\b|\bno (?:output|data|result)\b|\breturned no\b/i;
const RETRY_DELAY_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/\s+/g, " ").trim() : undefined;
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function parseJson(value: string | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function findEnvelope(value: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!isRecord(value) || depth > 3) return undefined;
  if (isRecord(value.new_api) || (isRecord(value.error) && text(value.error.message))) return value;
  return findEnvelope(value.error, depth + 1) ?? findEnvelope(value.body, depth + 1);
}

function gatewayFailure(error: GenerationProviderError): GatewayFailure | undefined {
  const envelope = findEnvelope(parseJson(error.body)) ?? findEnvelope(error.details);
  if (!envelope) return undefined;
  const detail = isRecord(envelope.error) ? envelope.error : envelope;
  const gateway = isRecord(envelope.new_api) ? envelope.new_api : {};
  return {
    message: text(detail.message),
    type: text(detail.type),
    code: text(detail.code),
    category: text(gateway.failure_category),
    upstreamStatus: typeof gateway.upstream_status === "number" ? gateway.upstream_status : undefined,
    requestId: text(gateway.request_id),
  };
}

function classify(error: GenerationProviderError, failure: GatewayFailure | undefined): ProviderErrorKind {
  const { status } = error;
  if (status === 401 || status === 403) return "credentials";
  if (status === 429) return "rate_limited";
  if (invalidRequestTypes.has(failure?.type ?? "") || invalidRequestTypes.has(failure?.code ?? "")) return "rejected";
  const upstream = failure?.category === "provider_error" || failure?.type === "upstream_error";
  if ((upstream || status === undefined) && NO_OUTPUT.test(failure?.message ?? error.message)) return "no_output";
  if (status !== undefined && status >= 500) return "unavailable";
  return upstream ? "upstream" : "failed";
}

function describeFailure(failure: GatewayFailure): string | null {
  const facts = [
    failure.type && `type ${failure.type}`,
    failure.code && failure.code !== failure.type && `code ${failure.code}`,
    failure.category && `category ${failure.category}`,
    failure.upstreamStatus !== undefined && `upstream HTTP ${failure.upstreamStatus}`,
    failure.requestId && `request ${failure.requestId}`,
  ].filter(Boolean);
  const message = failure.message ? truncate(failure.message, 500) : null;
  if (facts.length === 0) return message;
  return `${message ?? "no message"} (${facts.join(", ")})`;
}

function summarizeRaw(error: GenerationProviderError): string[] {
  const parts: string[] = [];
  if (error.details) {
    try {
      const serialized = JSON.stringify(error.details);
      if (serialized) parts.push(`details ${truncate(serialized.replace(/\s+/g, " "), 1_000)}`);
    } catch {
      parts.push("details [unserializable]");
    }
  }
  const body = text(error.body);
  if (body) parts.push(truncate(body, 500));
  return parts;
}

export function isRetryableGenerationError(error: unknown): boolean {
  if (!(error instanceof GenerationProviderError)) return false;
  const failure = gatewayFailure(error);
  const kind = classify(error, failure);
  if (error.status === 504 || failure?.upstreamStatus === 504) return false;
  if (kind === "no_output") return true;
  if (kind !== "upstream" && kind !== "unavailable") return false;
  return (failure?.upstreamStatus ?? error.status ?? 500) >= 500;
}

export async function withGenerationRetry<T>(
  run: () => Promise<T>,
  options: { gatewayRequests: () => number; onRetry: (error: unknown) => void; delayMs?: number },
): Promise<T> {
  const before = options.gatewayRequests();
  try {
    return await run();
  } catch (error) {
    if (options.gatewayRequests() - before > 1 || !isRetryableGenerationError(error)) throw error;
    options.onRetry(error);
    await sleep(options.delayMs ?? RETRY_DELAY_MS);
    return run();
  }
}

export function normalizeGenerationError(error: unknown): Error {
  if (error instanceof GenerationValidationError) {
    return new Error(`Invalid generation input: ${error.message}`);
  }
  if (error instanceof GenerationProviderError) {
    const failure = gatewayFailure(error);
    const parts = [error.status === undefined ? error.message : headlines[classify(error, failure)]];
    if (error.status !== undefined) parts.push(`HTTP ${error.status}`);
    const described = failure && describeFailure(failure);
    parts.push(...(described ? [described] : summarizeRaw(error)));
    return new Error(parts.join(" — "));
  }
  if (error instanceof GenerationConfigError || error instanceof GenerationUnsupportedAdapterError) {
    return new Error(error.message);
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}
