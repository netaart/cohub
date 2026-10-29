import { DEFAULT_UPLOAD_CONFIG, resolveUploadGroup, UploadGroup, usesMultipart, type UploadConfig, type UploadOptions } from "./upload-config.js";
import type { MultipartUploadPlan } from "@cohub/protocol";
import type { HttpTransport } from "./transport.js";

export type UploadSource = {
  size: number;
  slice(start: number, end: number): Blob | Promise<Blob>;
  validate?(): void | Promise<void>;
};
export type UploadProgress = { loadedBytes: number; totalBytes: number; ratio: number };
export type UploadTaskOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: UploadProgress) => void;
  fetch?: typeof fetch;
};
export type UploadTaskCreateOptions = UploadTaskOptions & { upload?: UploadOptions };
export type PreparedUploadTaskOptions = UploadTaskOptions & { upload: UploadGroup };
export type UploadPlan = {
  uploadUrl?: string;
  headers?: Record<string, string>;
  multipart?: MultipartUploadPlan;
};

export class UploadHttpError extends Error {
  constructor(readonly status: number) {
    super(`Upload failed: HTTP ${status}`);
    this.name = "UploadHttpError";
  }
}

const abortError = () => new DOMException("Upload aborted", "AbortError");
const retryable = (error: unknown) => {
  const status = (error as { status?: number } | null)?.status;
  return status != null
    ? status === 408 || status === 429 || [500, 502, 503, 504].includes(status)
    : error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
};

function delay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted();
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function retry<T>(action: () => Promise<T>, signal: AbortSignal, config: Readonly<UploadConfig>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted();
    try { return await action(); } catch (error) {
      if (signal.aborted || attempt + 1 >= config.maxAttempts || !retryable(error)) throw error;
      await delay(300 * 2 ** Math.min(attempt, 4) + Math.random() * 200, signal);
    }
  }
}

async function withTimeout<T>(action: (signal: AbortSignal) => Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  signal.throwIfAborted();
  if (timeoutMs === 0) return action(signal);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Upload timed out", "TimeoutError")), timeoutMs);
  try {
    const result = await action(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}

export function retryUploadRequest<T>(
  action: (signal: AbortSignal) => Promise<T>, signal = new AbortController().signal, config = DEFAULT_UPLOAD_CONFIG,
) {
  return retry(() => withTimeout(action, signal, config.timeoutMs), signal, config);
}

function uploadHeaders(headers?: Record<string, string>) {
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name, value]) =>
    !["content-length", "host"].includes(name.toLowerCase()) && !/[\r\n\0]/.test(value)));
}

async function put(input: {
  url: string;
  headers?: Record<string, string>;
  body: Blob;
  signal: AbortSignal;
  onProgress: (bytes: number) => void;
  timeoutMs: number;
  progressEnabled?: boolean;
  fetch?: typeof fetch;
}): Promise<string | undefined> {
  input.signal.throwIfAborted();
  const headers = uploadHeaders(input.headers);
  if (input.progressEnabled && typeof XMLHttpRequest === "function" && !input.fetch) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const onAbort = () => xhr.abort();
      const finish = (error?: Error) => {
        input.signal.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(xhr.getResponseHeader?.("ETag") ?? undefined);
      };
      xhr.open("PUT", input.url);
      xhr.timeout = input.timeoutMs;
      for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
      xhr.upload.onprogress = (event) => input.onProgress(Math.min(input.body.size, event.loaded));
      xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? undefined : new UploadHttpError(xhr.status));
      xhr.onerror = () => finish(new TypeError("Upload network error"));
      xhr.ontimeout = () => finish(new DOMException("Upload timed out", "TimeoutError"));
      xhr.onabort = () => finish(abortError());
      input.signal.addEventListener("abort", onAbort, { once: true });
      try { xhr.send(input.body); } catch (error) { finish(error as Error); }
    });
  }
  return withTimeout(async (signal) => {
    const response = await (input.fetch ?? fetch)(input.url, {
      method: "PUT", headers, body: input.body, signal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new UploadHttpError(response.status);
    }
    input.onProgress(input.body.size);
    return response.headers.get("etag") ?? undefined;
  }, input.signal, input.timeoutMs);
}

/** Retain this task and call run again to resume within the current client session. */
export class UploadTask<T = void> {
  readonly group: UploadGroup;
  private prepared?: { plan: UploadPlan; result: T };
  private readonly completedParts = new Map<number, string>();
  private readonly inflightBytes = new Map<number, number>();
  private pending?: Promise<T>;
  private controller?: AbortController;
  private refreshing?: Promise<void>;
  private finished = false;
  private cancelled = false;
  private singlePutComplete = false;
  private singlePutEtag?: string;
  private lastProgress?: { callback: UploadTaskOptions["onProgress"]; loadedBytes: number };

  constructor(
    private readonly transport: HttpTransport,
    private readonly source: Blob | UploadSource,
    private readonly prepare: (signal: AbortSignal) => Promise<{ plan: UploadPlan; result: T }>,
    private readonly options: UploadTaskCreateOptions = {},
    prepared?: { plan: UploadPlan; result: T },
  ) {
    this.prepared = prepared;
    this.group = resolveUploadGroup(transport, options.upload);
  }

  get etag() { return this.singlePutEtag; }

  run(options: UploadTaskOptions = {}): Promise<T> {
    if ("upload" in options) return Promise.reject(new Error("Upload configuration cannot change during a task"));
    if (this.cancelled) return Promise.reject(abortError());
    if (this.finished && this.prepared) return Promise.resolve(this.prepared.result);
    if (this.pending) return this.pending;
    const settings = { ...this.options, ...options };
    const controller = new AbortController();
    this.controller = controller;
    const onAbort = () => controller.abort(settings.signal?.reason ?? abortError());
    if (settings.signal?.aborted) onAbort();
    else settings.signal?.addEventListener("abort", onAbort, { once: true });
    this.pending = this.execute(controller, settings).finally(() => {
      settings.signal?.removeEventListener("abort", onAbort);
      this.inflightBytes.clear();
      this.pending = undefined;
      this.controller = undefined;
    });
    return this.pending;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.controller?.abort(abortError());
    await this.pending?.catch(() => {});
    const multipart = this.prepared?.plan.multipart;
    if (multipart && !this.finished) {
      await retryUploadRequest((signal) => this.transport.request(`/api/uploads/${encodeURIComponent(multipart.uploadId)}`, { method: "DELETE", signal }), undefined, this.group.config);
    }
  }

  private currentPlan() {
    if (!this.prepared) throw new Error("Upload plan is missing");
    return this.prepared.plan;
  }

  private async refresh(signal: AbortSignal) {
    if (!this.refreshing) {
      const plan = this.currentPlan();
      const multipart = plan.multipart;
      if (!multipart) throw new Error("Multipart upload plan is missing");
      this.refreshing = retryUploadRequest(async (requestSignal) => {
        const next = await this.transport.request<MultipartUploadPlan>(
          `/api/uploads/${encodeURIComponent(multipart.uploadId)}/refresh`, { method: "POST", signal: requestSignal },
        );
        if (next.uploadId !== multipart.uploadId || next.partSize !== multipart.partSize) {
          throw new Error("Upload session changed unexpectedly");
        }
        plan.multipart = next;
      }, signal, this.group.config).finally(() => { this.refreshing = undefined; });
    }
    await this.refreshing;
  }

  private emitProgress(options: UploadTaskOptions) {
    if (!options.onProgress) return;
    const partSize = this.prepared?.plan.multipart?.partSize ?? this.source.size;
    let loadedBytes = this.singlePutComplete ? this.source.size : 0;
    for (const partNumber of this.completedParts.keys()) {
      loadedBytes += Math.min(partSize, this.source.size - (partNumber - 1) * partSize);
    }
    for (const bytes of this.inflightBytes.values()) loadedBytes += bytes;
    loadedBytes = Math.min(loadedBytes, this.source.size);
    if (this.lastProgress?.callback === options.onProgress && this.lastProgress.loadedBytes === loadedBytes) return;
    this.lastProgress = { callback: options.onProgress, loadedBytes };
    try {
      options.onProgress({ loadedBytes, totalBytes: this.source.size, ratio: this.source.size ? loadedBytes / this.source.size : 1 });
    } catch { /* Progress observers cannot interrupt uploads. */ }
  }

  private async validate() {
    await (this.source as UploadSource).validate?.();
  }

  private async sendPart(partNumber: number, signal: AbortSignal, options: UploadTaskOptions) {
    let renewed = false;
    for (let attempt = 0; ; attempt++) {
      const plan = this.currentPlan();
      if (plan.multipart && Date.parse(plan.multipart.expiresAt) <= Date.now() + 30_000) await this.refresh(signal);
      const release = await this.group.acquire(signal);
      let failure: unknown;
      try {
        await this.validate();
        const partSize = plan.multipart?.partSize ?? this.source.size;
        const start = (partNumber - 1) * partSize;
        const end = Math.min(start + partSize, this.source.size);
        const body = !plan.multipart && this.source instanceof Blob ? this.source : await this.source.slice(start, end);
        if (body.size !== end - start) throw new Error("Upload source size changed");
        const part = plan.multipart?.parts.find((entry) => entry.partNumber === partNumber);
        const url = part?.uploadUrl ?? (plan.multipart ? undefined : plan.uploadUrl);
        if (!url) throw new Error("Upload URL is missing");
        const etag = await put({
          url, headers: part?.headers ?? plan.headers, body, signal, timeoutMs: this.group.config.timeoutMs, fetch: options.fetch, progressEnabled: Boolean(options.onProgress),
          onProgress: (bytes) => { this.inflightBytes.set(partNumber, bytes); this.emitProgress(options); },
        });
        if (plan.multipart) {
          if (!etag) throw new Error("Upload response is missing ETag; check storage CORS");
          this.completedParts.set(partNumber, etag);
        } else {
          this.singlePutComplete = true;
          this.singlePutEtag = etag;
        }
        return;
      } catch (error) {
        failure = error;
      } finally {
        this.inflightBytes.delete(partNumber);
        this.emitProgress(options);
        release();
      }
      if (signal.aborted || attempt + 1 >= this.group.config.maxAttempts) throw failure;
      if (failure instanceof UploadHttpError && failure.status === 403 && this.currentPlan().multipart && !renewed) {
        renewed = true;
        await this.refresh(signal);
      } else if (retryable(failure)) {
        await delay(300 * 2 ** Math.min(attempt, 4) + Math.random() * 200, signal);
      } else {
        throw failure;
      }
    }
  }

  private async execute(controller: AbortController, options: UploadTaskOptions): Promise<T> {
    const signal = controller.signal;
    signal.throwIfAborted();
    await this.validate();
    this.prepared ??= await retryUploadRequest(this.prepare, signal, this.group.config);
    signal.throwIfAborted();
    const multipart = this.prepared.plan.multipart;
    if (Boolean(multipart) !== usesMultipart(this.group.config, this.source.size)) throw new Error("Upload plan conflicts with the configured multipart mode");
    if (multipart && multipart.partSize !== this.group.config.partSizeBytes) throw new Error("Upload plan conflicts with the configured part size");
    if (multipart) {
      if (!Number.isSafeInteger(multipart.partSize) || multipart.partSize <= 0) throw new Error("Invalid upload part size");
      const count = Math.ceil(this.source.size / multipart.partSize);
      const pending = Array.from({ length: count }, (_, index) => index + 1).filter((part) => !this.completedParts.has(part));
      let failure: unknown;
      const worker = async () => {
        while (pending.length && !signal.aborted) {
          const partNumber = pending.shift();
          if (partNumber == null) return;
          try { await this.sendPart(partNumber, signal, options); } catch (error) {
            failure ??= error;
            controller.abort(error);
            return;
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.group.config.concurrency, pending.length) }, worker));
      if (failure) throw failure;
      signal.throwIfAborted();
      await this.validate();
      await retryUploadRequest((requestSignal) => this.transport.request(`/api/uploads/${encodeURIComponent(multipart.uploadId)}/complete`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: requestSignal,
        body: JSON.stringify({ parts: [...this.completedParts].sort(([a], [b]) => a - b).map(([partNumber, etag]) => ({ partNumber, etag })) }),
      }), signal, this.group.config);
    } else {
      if (!this.singlePutComplete) await this.sendPart(1, signal, options);
      await this.validate();
    }
    this.finished = true;
    this.emitProgress(options);
    return this.prepared.result;
  }
}

export function createUploadTask(
  transport: HttpTransport, plan: UploadPlan, source: Blob | UploadSource, options: PreparedUploadTaskOptions,
): UploadTask<void> {
  if (!(options.upload instanceof UploadGroup)) throw new Error("A shared upload group is required for prepared uploads");
  const prepared = { plan, result: undefined };
  return new UploadTask(transport, source, async () => prepared, options, prepared);
}
