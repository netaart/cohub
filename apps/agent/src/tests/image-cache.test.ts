import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import { test } from "node:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import { RemoteImageCache } from "../runtime/image-cache.js";

const image: ImageContent = { type: "image", mimeType: "image/png", data: "a".repeat(32) };

test("the byte budget applies across sessions and evicts the least recently read image", () => {
  const cache = new RemoteImageCache({ maxBytes: 200 });
  const first = {}, second = {}, third = {};
  cache.set(first, "a", image);
  cache.set(second, "a", image);
  assert.equal(cache.get(third, "a"), undefined, "the same URL is isolated between sessions");
  assert.equal(cache.get(first, "a"), image);
  cache.set(third, "a", image);
  assert.equal(cache.get(second, "a"), undefined, "the older session loses its bytes first");
  assert.equal(cache.get(first, "a"), image);
  assert.equal(cache.get(third, "a"), image);
  assert(cache.retainedBytes <= 200);
  const replacement = { ...image, data: "b".repeat(32) };
  cache.set(second, "a", replacement);
  assert.equal(cache.get(second, "a"), replacement, "an evicted URL can be cached again");
});

test("oversized images are usable without being retained or evicting smaller cached images", () => {
  const cache = new RemoteImageCache({ maxBytes: 200 });
  const owner = {};
  cache.set(owner, "a", image);
  const before = cache.retainedBytes;
  cache.set(owner, "large", { ...image, data: "b".repeat(1000) });
  assert.equal(cache.get(owner, "large"), undefined);
  assert.equal(cache.get(owner, "a"), image);
  assert.equal(cache.retainedBytes, before);
});

test("history pruning and disposal release retained bytes and allow the URL to be added again", () => {
  const cache = new RemoteImageCache();
  const owner = {};
  cache.set(owner, "a", image);
  cache.set(owner, "b", image);
  cache.retain(owner, new Set(["b"]));
  assert.equal(cache.get(owner, "a"), undefined);
  assert.equal(cache.get(owner, "b"), image);
  cache.retain(owner, new Set());
  assert.equal(cache.retainedBytes, 0);
  cache.set(owner, "a", image);
  assert.equal(cache.get(owner, "a"), image);
  cache.retain(owner, new Set());
});

test("idle image bytes expire even if their session owner remains alive and no request returns", async () => {
  const cache = new RemoteImageCache({ ttlMs: 10 });
  const owner = {};
  cache.set(owner, "a", image);
  assert(cache.retainedBytes > 0);
  await setTimeout(50);
  assert.equal(cache.retainedBytes, 0, "expiry must run without a cache read");
  cache.set(owner, "a", image);
  assert.equal(cache.get(owner, "a"), image);
  cache.retain(owner, new Set());
});
