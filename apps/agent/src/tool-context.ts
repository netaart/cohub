import { AsyncLocalStorage } from "node:async_hooks";
import type { GenerationPolicy } from "@cohub/protocol/generation";
import type { PromptEnv } from "@cohub/core/sessions";
import type { ImageInputCache } from "@cohub/model-runtime/image-content";
import type { Permission } from "@cohub/core/permissions";
import type { AgentFileVisibility } from "./runtime/workspace-visibility.js";

export type TurnTelemetryMetrics = {
  llmRoundCount: number;
  toolCallCount: number;
};

export type AssistantMessageTimingContext = {
  startedAt?: string | null;
};

export type ToolExecutionContext = {
  spaceId: string;
  sessionId: string;
  turnId?: string;
  turnSeq?: number;
  anchorUserMessageId?: string | null;
  llmRound?: number;
  model?: { provider: string; id: string } | null;
  toolCallId?: string;
  actorUserId?: string | null;
  executionToken?: string | null;
  executionScopes?: Permission[] | null;
  /**
   * Frontend instance that originated this work, propagated from request
   * provenance so `cohub` inside the sandbox can address the same UI.
   */
  sourceClientId?: string | null;
  requestId?: string | null;
  metrics?: TurnTelemetryMetrics;
  assistantMessageTiming?: AssistantMessageTimingContext;
  generationPolicy?: GenerationPolicy | null;
  /** Space-level env snapshot loaded once for this execution scope. */
  spaceEnv?: Readonly<Record<string, string>>;
  env?: PromptEnv | null;
  fileVisibility?: AgentFileVisibility;
  abortSignal?: AbortSignal;
  imageInputCache?: ImageInputCache;
};

const storage = new AsyncLocalStorage<ToolExecutionContext>();

export function runWithToolExecutionContext<T>(
  ctx: ToolExecutionContext,
  fn: () => Promise<T>,
): Promise<T> {
  const current = storage.getStore();
  return storage.run({ ...(current ?? {}), ...ctx }, fn);
}

export function getCurrentToolExecutionContext(): ToolExecutionContext | null {
  return storage.getStore() ?? null;
}
