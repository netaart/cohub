import type { BillingOperations, PricingQuota, PricingSnapshot } from "@cohub/billing";

type QuotaBilling = Pick<BillingOperations, "getQuotaStatus" | "consumeQuota" | "reverseQuota">;
type Log = (message: string, context: Record<string, unknown>) => void;
export type GenerationQuotaUse = NonNullable<PricingSnapshot["quota"]>;

const consumeOperationId = (taskRunId: string) => `generation-quota:${taskRunId}`;

/**
 * Draws a generation's quota at admission so concurrent submissions and day boundaries cannot spend the
 * same balance twice. Billing never refuses a consume, so the part the balance did not cover comes back
 * as overage and is cancelled at once; tomorrow's grant must never settle today's request.
 */
export async function consumeGenerationQuota(input: {
  billing: QuotaBilling;
  taskRunId: string;
  userId: string;
  usageType: string;
  model: string;
  quota: PricingQuota;
  requested: number;
  warn?: Log;
}): Promise<GenerationQuotaUse> {
  const { billing, taskRunId, userId, quota } = input;
  const unused: GenerationQuotaUse = { ruleKey: quota.ruleKey, tokenType: quota.tokenType, requested: input.requested, covered: 0 };
  if (input.requested <= 0) return unused;
  const { balance } = await billing.getQuotaStatus({ userId, tokenType: quota.tokenType });
  const amount = Math.min(Math.floor(balance), input.requested);
  if (amount <= 0) return unused;

  const originalOperationId = consumeOperationId(taskRunId);
  // Undo the whole draw: billing cancels open debt first, so this leaves the balance as it was.
  const voidDraw = () => billing.reverseQuota({
    userId,
    tokenType: quota.tokenType,
    originalOperationId,
    operationId: `${originalOperationId}:void`,
    amount,
    reason: "Quota draw voided at admission",
  });
  let consumed: { overage: number };
  try {
    consumed = await billing.consumeQuota({
      userId,
      tokenType: quota.tokenType,
      amount,
      usageType: input.usageType,
      sourceId: taskRunId,
      operationId: originalOperationId,
      // The ledger lists a generation the quota fully covered by comparing what is left of this draw to it.
      reason: `Generation ${input.model} [requested=${input.requested}]`,
    });
  } catch (error) {
    // The consume may have committed before its response was lost; a void of a consume that never
    // happened fails harmlessly.
    await voidDraw().catch(() => undefined);
    throw error;
  }
  if (consumed.overage <= 0) return { ...unused, covered: amount };
  try {
    const reversed = await billing.reverseQuota({
      userId,
      tokenType: quota.tokenType,
      originalOperationId,
      operationId: `${originalOperationId}:overage`,
      amount: consumed.overage,
      reason: "Quota overage cancelled at admission",
    });
    if (reversed.overageCancelled < consumed.overage) {
      input.warn?.("[GenerationQuota] overage reversal returned credit instead of cancelling debt", { taskRunId, userId, tokenType: quota.tokenType, overage: consumed.overage, cancelled: reversed.overageCancelled });
    }
  } catch (error) {
    await voidDraw().catch((voidError) => {
      input.warn?.("[GenerationQuota] failed to void a quota draw; manual billing verification required", { taskRunId, userId, tokenType: quota.tokenType, amount, error: voidError });
    });
    throw error;
  }
  return { ...unused, covered: amount - consumed.overage };
}

/**
 * Returns a failed or cancelled generation's quota. Idempotent per task; a failure is logged for manual
 * verification instead of thrown, since every caller is already on a failure path.
 */
export async function refundGenerationQuota(input: {
  billing: QuotaBilling;
  taskRunId: string;
  userId: string;
  quota: GenerationQuotaUse | null | undefined;
  error: Log;
}): Promise<void> {
  if (!input.quota || input.quota.covered <= 0) return;
  const originalOperationId = consumeOperationId(input.taskRunId);
  try {
    await input.billing.reverseQuota({
      userId: input.userId,
      tokenType: input.quota.tokenType,
      originalOperationId,
      operationId: `${originalOperationId}:refund`,
      amount: input.quota.covered,
      // One fixed reason: the API (cancel) and worker (failure) may both refund the same task under one key.
      reason: "Generation not delivered",
    });
  } catch (error) {
    input.error("[GenerationQuota] refund failed; manual billing verification required", { taskRunId: input.taskRunId, userId: input.userId, quota: input.quota, error });
  }
}
