import type { UploadProtocol, UploadStrategy } from "@cohub/protocol";
import type { HttpTransport } from "./transport.js";

export type UploadConfig = UploadStrategy & {
  concurrency: number;
  maxAttempts: number;
  timeoutMs: number;
};
export const DEFAULT_UPLOAD_CONFIG: Readonly<UploadConfig> = Object.freeze({
  multipart: "auto", multipartThresholdBytes: 16 * 1024 * 1024, partSizeBytes: 16 * 1024 * 1024,
  concurrency: 2, maxAttempts: 3, timeoutMs: 120_000,
});

export function resolveUploadConfig(overrides: Partial<UploadConfig> = {}, defaults = DEFAULT_UPLOAD_CONFIG): Readonly<UploadConfig> {
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_UPLOAD_CONFIG, key)) throw new Error(`Unknown upload option: ${key}`);
  }
  const config = { ...defaults, ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined)) };
  if (!["auto", "always", "never"].includes(config.multipart)) throw new Error("Invalid upload multipart mode");
  for (const key of ["partSizeBytes", "concurrency", "maxAttempts", "multipartThresholdBytes", "timeoutMs"] as const) {
    const minimum = key === "multipartThresholdBytes" || key === "timeoutMs" ? 0 : 1;
    if (!Number.isSafeInteger(config[key]) || config[key] < minimum) throw new Error(`Invalid upload ${key}`);
  }
  if (config.timeoutMs > 2_147_483_647) throw new Error("Upload timeoutMs exceeds the supported timer range");
  return Object.freeze(config);
}

/** One upload operation or file batch shares this immutable policy and transfer budget. */
export class UploadGroup {
  private readonly settings: Readonly<UploadConfig>;
  private activeRequests = 0;
  private readonly waitingRequests: Array<() => void> = [];

  constructor(overrides: Partial<UploadConfig> = {}, defaults = DEFAULT_UPLOAD_CONFIG) {
    this.settings = resolveUploadConfig(overrides, defaults);
  }

  get config(): Readonly<UploadConfig> { return this.settings; }

  acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.activeRequests--;
      this.waitingRequests.shift()?.();
    };
    if (this.activeRequests < this.config.concurrency) {
      this.activeRequests++;
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal.removeEventListener("abort", onAbort);
        this.activeRequests++;
        resolve(release);
      };
      const onAbort = () => {
        const index = this.waitingRequests.indexOf(grant);
        if (index >= 0) this.waitingRequests.splice(index, 1);
        reject(signal.reason);
      };
      this.waitingRequests.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export type UploadOptions = Partial<UploadConfig> | UploadGroup;
export function resolveUploadGroup(transport: Pick<HttpTransport, "uploadConfig">, upload?: UploadOptions): UploadGroup {
  return upload instanceof UploadGroup ? upload : new UploadGroup(upload, transport.uploadConfig);
}

export function usesMultipart(config: UploadStrategy, size: number) {
  return size > 0 && (config.multipart === "always" || (config.multipart === "auto" && size > config.multipartThresholdBytes));
}

export function uploadStrategy(config: UploadStrategy): UploadStrategy {
  return { multipart: config.multipart, multipartThresholdBytes: config.multipartThresholdBytes, partSizeBytes: config.partSizeBytes };
}

export function configureUploadInput<T extends { upload?: Partial<UploadStrategy>; uploadProtocol?: UploadProtocol }>(
  input: T, group?: UploadGroup,
): T {
  if (!group) return input;
  const strategy = uploadStrategy(group.config);
  for (const key of Object.keys(strategy) as Array<keyof UploadStrategy>) {
    if (input.upload?.[key] !== undefined && input.upload[key] !== strategy[key]) throw new Error(`Upload ${key} conflicts with the upload group`);
  }
  if ((input.uploadProtocol === "presigned_put_v1" && strategy.multipart !== "never")
    || (input.uploadProtocol === "multipart_v1" && strategy.multipart === "never")) {
    throw new Error("Upload protocol conflicts with the upload group");
  }
  return { ...input, upload: strategy };
}

export function resolveUploadRequestGroup(
  transport: Pick<HttpTransport, "uploadConfig" | "hasUploadConfig">,
  input: { upload?: Partial<UploadStrategy>; uploadProtocol?: UploadProtocol },
  upload?: UploadOptions,
  force = false,
): UploadGroup | undefined {
  if (upload instanceof UploadGroup) return upload;
  if (!force && !upload && !input.upload && !transport.hasUploadConfig) return undefined;
  const overrides: Partial<UploadConfig> = { ...input.upload };
  for (const [key, value] of Object.entries(upload ?? {})) {
    if (value === undefined) continue;
    if (Object.hasOwn(overrides, key) && overrides[key as keyof UploadConfig] !== undefined && overrides[key as keyof UploadConfig] !== value) {
      throw new Error(`Conflicting upload option: ${key}`);
    }
  }
  Object.assign(overrides, Object.fromEntries(Object.entries(upload ?? {}).filter(([, value]) => value !== undefined)));
  if (overrides.multipart === undefined && input.uploadProtocol) {
    overrides.multipart = input.uploadProtocol === "presigned_put_v1" ? "never" : "auto";
  }
  return resolveUploadGroup(transport, overrides);
}
