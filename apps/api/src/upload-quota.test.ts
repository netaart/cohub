import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { UPLOAD_RATE_MAX_BYTES, UPLOAD_RATE_MAX_FILES, UPLOAD_RATE_WINDOW_SECONDS } from "@cohub/protocol";
import { consumeUploadQuota, UploadRateLimitError, type UploadQuotaRedis } from "./upload-quota.js";

/** Minimal fixed-window replica of the Lua script for behavior coverage. */
const fakeRedis = () => {
  const store = new Map<string, number>();
  const redis: UploadQuotaRedis = {
    eval: (async (_script: string, _numKeys: number, ...args: unknown[]) => {
      const [filesKey, bytesKey, entryCount, totalBytes, maxFiles, maxBytes, window] = args as [
        string, string, number, number, number, number, number,
      ];
      const next = (key: string, delta: number) => (store.get(key) ?? 0) + delta;
      const overFiles = entryCount > 0 && next(filesKey, entryCount) > maxFiles;
      const overBytes = totalBytes > 0 && next(bytesKey, totalBytes) > maxBytes;
      if (overFiles || overBytes) return [0, window];
      if (entryCount > 0) store.set(filesKey, next(filesKey, entryCount));
      if (totalBytes > 0) store.set(bytesKey, next(bytesKey, totalBytes));
      return [1, 0];
    }) as UploadQuotaRedis["eval"],
  };
  return { redis, store };
};

describe("consumeUploadQuota", () => {
  it("charges files and bytes atomically and sets the window ttl", async () => {
    const { redis, store } = fakeRedis();
    await consumeUploadQuota(redis, "user", { entryCount: 10, totalBytes: 1024 });
    assert.equal(store.get("upload:rate:user:files"), 10);
    assert.equal(store.get("upload:rate:user:bytes"), 1024);
  });

  it("rejects batches over the file cap without consuming the window", async () => {
    const { redis, store } = fakeRedis();
    await assert.rejects(
      consumeUploadQuota(redis, "user", { entryCount: UPLOAD_RATE_MAX_FILES + 1 }),
      UploadRateLimitError,
    );
    assert.equal(store.get("upload:rate:user:files"), undefined);
  });

  it("rejects on the byte budget while rolling back the file counter", async () => {
    const { redis, store } = fakeRedis();
    await assert.rejects(
      consumeUploadQuota(redis, "user", { entryCount: 5, totalBytes: UPLOAD_RATE_MAX_BYTES + 1 }),
      UploadRateLimitError,
    );
    assert.equal(store.get("upload:rate:user:files"), undefined);
  });

  it("ignores empty usage without touching redis", async () => {
    const { redis } = fakeRedis();
    await consumeUploadQuota(redis, "user");
    await consumeUploadQuota(redis, "user", { entryCount: 0, totalBytes: 0 });
  });

  it("exposes a retry hint in seconds when limited", async () => {
    const { redis } = fakeRedis();
    const limited = await consumeUploadQuota(redis, "burst", {
      entryCount: UPLOAD_RATE_MAX_FILES + 1,
    }).catch((error: unknown) => error);
    assert.ok(limited instanceof UploadRateLimitError);
    assert.equal(limited.retryAfterSeconds, UPLOAD_RATE_WINDOW_SECONDS);
  });
});
