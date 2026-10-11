import {
  GenerationConfigError,
  GenerationProviderError,
  GenerationUnsupportedAdapterError,
  GenerationValidationError,
} from "@neta-art/generation";
import type { GenerationTaskFailureResult } from "@cohub/protocol/generation";
import { TaskRunFailure } from "./task-run-failure.js";

/** Provider failure; the request ids land on the failed task run result. */
export class GenerationTaskFailure extends TaskRunFailure<GenerationTaskFailureResult> {
  constructor(message: string, result: GenerationTaskFailureResult) {
    super(message, result);
    this.name = "GenerationTaskFailure";
  }
}

function summarizeProviderBody(body: string | undefined): string | null {
  if (!body) return null;
  return body.replace(/\s+/g, " ").trim().slice(0, 500) || null;
}

function truncateProviderDetail(value: string, maxLength = 1_000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

function summarizeProviderDetails(details: Record<string, unknown> | undefined): string | null {
  if (!details) return null;
  try {
    const serialized = JSON.stringify(details);
    if (!serialized) return null;
    return `details ${truncateProviderDetail(serialized.replace(/\s+/g, " "))}`;
  } catch {
    return "details [unserializable]";
  }
}

function providerStatusMessage(status: number | undefined): string | null {
  if (status === undefined) return null;
  if (status === 401 || status === 403) return "Generation provider rejected the configured credentials";
  if (status === 429) return "Generation provider rate limit exceeded";
  if (status >= 500) return "Generation provider is temporarily unavailable";
  return "Generation provider request failed";
}

export function normalizeGenerationError(error: unknown): Error {
  if (error instanceof GenerationValidationError) {
    return new Error(`Invalid generation input: ${error.message}`);
  }
  if (error instanceof GenerationProviderError) {
    const parts = [providerStatusMessage(error.status) ?? error.message];
    if (error.status !== undefined) parts.push(`HTTP ${error.status}`);
    const details = summarizeProviderDetails(error.details);
    if (details) parts.push(details);
    const body = summarizeProviderBody(error.body);
    if (body) parts.push(body);
    return new GenerationTaskFailure(parts.join(" — "), {
      ...(error.requestId !== undefined ? { requestId: error.requestId } : {}),
      upstreamRequestIds: error.upstreamRequestIds,
    });
  }
  if (error instanceof GenerationConfigError || error instanceof GenerationUnsupportedAdapterError) {
    return new Error(error.message);
  }
  if (error instanceof Error) return error;
  return new Error(String(error));
}
