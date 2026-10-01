import type { Usage } from "@cohub/protocol/core";
import { metricsRecord } from "@cohub/protocol/model";
import { addUsage } from "./compaction.js";
import { sumImageToTextUsage } from "./image-to-text.js";

export function isFinalAssistantMessageMeta(meta: unknown): boolean {
  const kind = metricsRecord(meta).messageKind;
  return kind === "assistant_final" || kind === "assistant_error";
}

export function interruptedTurnUsage(
  intermediate: Usage | null | undefined,
  last: { usage?: Usage | null; meta?: unknown } | null,
): Usage | null {
  if (!isFinalAssistantMessageMeta(last?.meta)) return intermediate ?? null;
  return addUsage(addUsage(intermediate, last?.usage), sumImageToTextUsage(last?.meta));
}

export function interruptedSummaryPatch(existing: unknown, incoming: Record<string, unknown>): Record<string, unknown> | null {
  const current = metricsRecord(existing);
  if (current.reason === "steer") return null;
  if (current.reason && incoming.reason !== "steer") return null;
  if (Object.entries(incoming).every(([key, value]) => current[key] === value)) return null;
  return { ...current, ...incoming };
}
