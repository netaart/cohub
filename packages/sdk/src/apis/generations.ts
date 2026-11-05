import type {
  CreateGenerationTaskRequest,
  CreateGenerationTaskResponse,
  GenerationTaskResult,
} from "@cohub/protocol/generation";
import type { HttpTransport } from "../transport.js";
import type { TaskRunDetailResponse } from "../types.js";

export type WaitGenerationTaskOptions = {
  intervalMs?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onPoll?: (detail: TaskRunDetailResponse) => void;
};

const DEFAULT_INTERVAL_MS = 1500;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function sleep(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Generation wait aborted"));
  return new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason ?? new Error("Generation wait aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isGenerationTaskResult(value: unknown): value is GenerationTaskResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as {
    model?: unknown;
    output?: unknown;
    requestId?: unknown;
    cost?: unknown;
    billing?: unknown;
  };
  if (typeof record.model !== "string" || !Array.isArray(record.output)) return false;
  if (record.requestId !== undefined && typeof record.requestId !== "string") return false;
  if (record.cost !== undefined && (typeof record.cost !== "number" || !Number.isFinite(record.cost))) return false;
  if (record.billing !== undefined && record.billing !== null) {
    if (!record.billing || typeof record.billing !== "object" || Array.isArray(record.billing)) return false;
    const billing = record.billing as {
      officialCostUsd?: unknown;
      amountUsd?: unknown;
      discountMultiplier?: unknown;
      usageType?: unknown;
      status?: unknown;
      reason?: unknown;
    };
    if (
      billing.officialCostUsd !== undefined &&
      (typeof billing.officialCostUsd !== "number" || !Number.isFinite(billing.officialCostUsd))
    ) return false;
    if (typeof billing.amountUsd !== "number" || !Number.isFinite(billing.amountUsd)) return false;
    if (
      billing.discountMultiplier !== undefined &&
      (
        typeof billing.discountMultiplier !== "number" ||
        !Number.isFinite(billing.discountMultiplier) ||
        billing.discountMultiplier < 0 ||
        billing.discountMultiplier > 1
      )
    ) return false;
    if (typeof billing.usageType !== "string") return false;
    if (billing.status !== "recorded" && billing.status !== "overage" && billing.status !== "skipped") return false;
    if (billing.reason !== undefined && billing.reason !== null && typeof billing.reason !== "string") return false;
  }
  return true;
}

export class GenerationsApi {
  constructor(private readonly transport: HttpTransport) {}

  async create(request: CreateGenerationTaskRequest): Promise<CreateGenerationTaskResponse> {
    return this.transport.request<CreateGenerationTaskResponse>("/api/generations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  }

  async wait(taskRunId: string, options: WaitGenerationTaskOptions = {}): Promise<GenerationTaskResult> {
    const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const startedAt = Date.now();

    while (true) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Generation wait aborted");
      const detail = await this.transport.request<TaskRunDetailResponse>(`/api/tasks/${taskRunId}`);
      options.onPoll?.(detail);

      if (detail.run.taskType !== "generation") {
        throw new Error(`Task is not a generation task: ${detail.run.taskType}`);
      }

      if (detail.run.status === "completed") {
        if (!isGenerationTaskResult(detail.run.result)) {
          throw new Error("Generation task completed without a valid result");
        }
        return detail.run.result;
      }

      if (detail.run.status === "failed") {
        const message = detail.run.errorMessage || "Generation task failed";
        throw new Error(`${message}\ntask ID: ${taskRunId}`);
      }

      const elapsedMs = Date.now() - startedAt;
      const remainingMs = timeoutMs - elapsedMs;
      if (remainingMs <= 0) {
        throw new Error(`Generation task timed out after ${timeoutMs}ms`);
      }

      await sleep(Math.min(intervalMs, remainingMs), options.signal);
    }
  }

  async createAndWait(
    request: CreateGenerationTaskRequest,
    options?: WaitGenerationTaskOptions,
  ): Promise<GenerationTaskResult> {
    const created = await this.create(request);
    return this.wait(created.taskRunId, options);
  }
}
