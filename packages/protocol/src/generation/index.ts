import type { GenerationContentBlock, GenerationModelDeclaration } from "@neta-art/generation";
import type { BillingPayload } from "../billing.js";
import type { RequestSource } from "../provenance.js";
import type { TurnSpeechTarget } from "../speech.js";
export * from "./catalog.js";
export * from "./policy.js";
export * from "./session-messages.js";

export type {
  GenerateRequest,
  GenerationContentBlock,
  GenerationContentBlockMeta,
  GenerationContentSpec,
  GenerationModelDeclaration,
  GenerationModelPricing,
  GenerationParameterSpec,
  GenerationResult,
  GenerationSource,
} from "@neta-art/generation";

export const GENERATION_TASK_TYPE = "generation" as const;
export const GENERATION_BILLING_RETRY_TASK_TYPE = "generation.billing_retry" as const;
export const TURN_SPEECH_TASK_TYPE = "generation.speech" as const;

export const isGenerationTaskType = (taskType: string) =>
  taskType === GENERATION_TASK_TYPE || taskType === TURN_SPEECH_TASK_TYPE;

export type CreateGenerationTaskRequest = {
  spaceId: string;
  sessionId?: string | null;
  turnId?: string | null;
  model: string;
  content: GenerationContentBlock[];
  parameters?: Record<string, unknown>;
  meta?: Record<string, unknown>;
};

export type CreateGenerationTaskResponse = {
  taskRunId: string;
  taskType: typeof GENERATION_TASK_TYPE;
  status: "pending";
  billing?: BillingPayload | null;
  /** Present when a whitelisted model held its reserve against the payer's balance. */
  reservation?: { amountUsd: number; status: "held" } | null;
};

export type GenerationTaskData = {
  model: string;
  content: GenerationContentBlock[];
  parameters?: Record<string, unknown>;
  /** Model-owned request metadata validated against the generation declaration. */
  meta?: Record<string, unknown>;
  /** Server-derived request provenance. Never forwarded to the generation provider. */
  requestSource?: RequestSource | null;
  /** Server-resolved pricing snapshot. This field is never accepted from the public request. */
  modelDiscount?: GenerationModelDiscountSnapshot;
  /** Submission-time balance hold for whitelisted models; released when the task ends. */
  reserveHold?: GenerationReserveHold | null;
  speech?: TurnSpeechTarget;
};

/** Persisted in the task payload so the worker and queued-turn cancellation can release it. */
export type GenerationReserveHold = {
  payer: { type: "personal" | "space_wallet"; id: string };
  amountUsd: number;
};

export type GenerationModelDiscountSnapshot = {
  multiplier: number;
  resolvedAt: string;
};

type GenerationBillingRetryTaskDataBase = {
  taskRunId: string;
  userId: string;
  amountUsd: number;
  usageType: string;
  model: string;
  adapterType?: string | null;
  /** Payer pinned by a reserve hold; absent means the wallet router chooses. */
  payer?: GenerationReserveHold["payer"]["type"] | null;
};

/** Legacy payloads already queued before model-discount snapshots were introduced. */
export type GenerationBillingRetryTaskDataV1 = GenerationBillingRetryTaskDataBase & {
  schemaVersion?: 1;
};

/** Payload for async billing retry after a successful generation charge failure. */
export type GenerationBillingRetryTaskDataV2 = GenerationBillingRetryTaskDataBase & {
  schemaVersion: 2;
  officialCostUsd: number;
  modelDiscount: GenerationModelDiscountSnapshot;
};

export type GenerationBillingRetryTaskData =
  | GenerationBillingRetryTaskDataV1
  | GenerationBillingRetryTaskDataV2;

/**
 * Final generation task payload stored on the task run.
 *
 * - `output` is the generated content blocks (SDK `GenerationResult.content`)
 * - `requestId` maps to the provider response body's top-level `request_id`
 * - `cost` maps to the official request price in `usage.cost`
 * - `billing` records post-success credit consumption (when attempted)
 * - `meta` is the model-owned request meta
 */
export type GenerationUsageBilling = {
  /** Official provider cost before plan discount. */
  officialCostUsd?: number;
  /** Effective charge amount after plan discount; inspect status to confirm recording. */
  amountUsd: number;
  /** Server-resolved multiplier applied to officialCostUsd. */
  discountMultiplier?: number;
  usageType: string;
  status: "recorded" | "overage" | "skipped";
  reason?: string | null;
};

export type GenerationTaskResult = {
  model: string;
  provider?: string | null;
  output: GenerationContentBlock[];
  requestId?: string;
  cost?: number;
  /** Post-success usage charge metadata. Distinct from gate `billing` on create. */
  billing?: GenerationUsageBilling | null;
  meta?: Record<string, unknown>;
};

export type GenerationExampleRequest = Omit<CreateGenerationTaskRequest, "spaceId">;
export type GenerationDeclaration = GenerationModelDeclaration;
export type PublicGenerationDeclaration = Omit<GenerationModelDeclaration, "adapter">;

export type ListGenerationModelsResponse = {
  models: PublicGenerationDeclaration[];
};
