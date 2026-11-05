import { applyGenerationModelDiscount, normalizePositiveUsd } from "@cohub/billing";
import type {
  GenerationBillingRetryTaskDataV2,
  GenerationModelDiscountSnapshot,
} from "@cohub/protocol/generation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseModelDiscountSnapshot(value: unknown): GenerationModelDiscountSnapshot {
  if (!isRecord(value)) throw new Error("Invalid generation billing retry payload: modelDiscount is required");
  if (
    typeof value.multiplier !== "number" ||
    !Number.isFinite(value.multiplier) ||
    value.multiplier < 0 ||
    value.multiplier > 1
  ) {
    throw new Error("Invalid generation billing retry payload: modelDiscount.multiplier must be between 0 and 1");
  }
  if (
    typeof value.resolvedAt !== "string" ||
    !value.resolvedAt.trim() ||
    !Number.isFinite(Date.parse(value.resolvedAt))
  ) {
    throw new Error("Invalid generation billing retry payload: modelDiscount.resolvedAt must be an ISO date-time");
  }
  return { multiplier: value.multiplier, resolvedAt: value.resolvedAt };
}

function parsePinnedPayer(value: unknown): "personal" | "space_wallet" | null {
  return value === "personal" || value === "space_wallet" ? value : null;
}

export function parseGenerationBillingRetryData(data: unknown): GenerationBillingRetryTaskDataV2 {
  if (!isRecord(data)) throw new Error("Invalid generation billing retry payload: data is required");
  if (typeof data.taskRunId !== "string" || !data.taskRunId.trim()) {
    throw new Error("Invalid generation billing retry payload: taskRunId is required");
  }
  if (typeof data.userId !== "string" || !data.userId.trim()) {
    throw new Error("Invalid generation billing retry payload: userId is required");
  }
  if (typeof data.model !== "string" || !data.model.trim()) {
    throw new Error("Invalid generation billing retry payload: model is required");
  }
  if (typeof data.usageType !== "string" || !data.usageType.trim()) {
    throw new Error("Invalid generation billing retry payload: usageType is required");
  }
  if (typeof data.amountUsd !== "number" || !Number.isFinite(data.amountUsd) || data.amountUsd <= 0) {
    throw new Error("Invalid generation billing retry payload: amountUsd must be a positive number");
  }
  const payer = parsePinnedPayer(data.payer);
  const common = {
    taskRunId: data.taskRunId,
    userId: data.userId,
    amountUsd: normalizePositiveUsd(data.amountUsd),
    usageType: data.usageType,
    model: data.model,
    adapterType: typeof data.adapterType === "string" ? data.adapterType : null,
    ...(payer ? { payer } : {}),
  };
  if (data.schemaVersion === undefined || data.schemaVersion === 1) {
    return {
      schemaVersion: 2,
      ...common,
      officialCostUsd: common.amountUsd,
      modelDiscount: {
        multiplier: 1,
        resolvedAt: "1970-01-01T00:00:00.000Z",
      },
    };
  }
  if (data.schemaVersion !== 2) {
    throw new Error("Invalid generation billing retry payload: unsupported schemaVersion");
  }
  if (
    typeof data.officialCostUsd !== "number" ||
    !Number.isFinite(data.officialCostUsd) ||
    data.officialCostUsd <= 0
  ) {
    throw new Error("Invalid generation billing retry payload: officialCostUsd must be a positive number");
  }
  const modelDiscount = parseModelDiscountSnapshot(data.modelDiscount);
  const expectedAmountUsd = applyGenerationModelDiscount(data.officialCostUsd, modelDiscount);
  if (expectedAmountUsd !== common.amountUsd) {
    throw new Error("Invalid generation billing retry payload: amountUsd does not match the pricing snapshot");
  }
  return {
    schemaVersion: 2,
    ...common,
    officialCostUsd: data.officialCostUsd,
    modelDiscount,
  };
}
