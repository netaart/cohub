import type { AgentRunCommandJobResult } from "@cohub/infra/agent-queue";
import { isRequestSourceClientId } from "@cohub/protocol/provenance";
import { APP_ACTION_EXECUTION_SOURCE } from "@cohub/protocol/task";

export type RunCommandExecutionContext = {
  sourceClientId: string | null;
  model: { provider: string; id: string } | null;
};

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;

const APP_ACTION_OUTPUT_TAIL_CHARS = 4000;

export function appActionFailureMessage(
  source: unknown,
  result: Pick<AgentRunCommandJobResult, "exitCode" | "termination"> & { output?: string },
): string | null {
  if (source !== APP_ACTION_EXECUTION_SOURCE || result.exitCode === 0) return null;
  const message = result.termination?.reason === "timed_out"
    ? "App Action timed out."
    : result.termination?.reason === "aborted"
      ? "App Action was aborted."
      : `App Action exited with code ${result.exitCode ?? "unknown"}.`;
  // Viewers already receive this output on success, so the tail adds no new exposure.
  const tail = result.output?.trim().slice(-APP_ACTION_OUTPUT_TAIL_CHARS);
  return tail ? `${message}\n${tail}` : message;
}

export function parseRunCommandExecutionContext(data: Record<string, unknown>): RunCommandExecutionContext {
  const rawClientId = typeof data.sourceClientId === "string" ? data.sourceClientId.trim() : "";
  const model = asRecord(data.model);
  const provider = typeof model?.provider === "string" ? model.provider.trim() : "";
  const id = typeof model?.id === "string" ? model.id.trim() : "";

  return {
    sourceClientId: isRequestSourceClientId(rawClientId) ? rawClientId : null,
    model: provider && id ? { provider, id } : null,
  };
}
