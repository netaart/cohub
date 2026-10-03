import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contextToPiMessages, type RuntimeContext } from "@cohub/protocol";
import sharp from "sharp";
import { getRemoteImageUrl } from "@cohub/model-runtime/image-content";
import type { ContentBlock } from "@cohub/protocol/core";
import { SessionManager } from "../runtime/local-session-manager.js";
import { syncCloudContext } from "../runtime/cloud-context.js";
import { hydrateSessionImages } from "../runtime/context-images.js";

const png = (width = 20) => sharp({ create: { width, height: 20, channels: 3, background: "red" } }).png().toBuffer();

const history: RuntimeContext = { revision: "r", throughTurnId: "t", messages: [
  { id: "u", turnId: "t", role: "user", content: [{ type: "text", text: "request" }] },
  { id: "a", turnId: "t", role: "assistant", provider: "p", model: "m", stopReason: "error", errorMessage: "failed", usage: { input: 7, output: 3 }, meta: { nativeApi: "anthropic-messages", createdAt: "2026-09-16T00:00:00Z" }, content: [
    { type: "thinking", thinking: "reasoning", signature: "opaque" },
    { type: "tool_use", id: "tc", name: "read", input: { path: "a" } },
    { type: "tool_result", tool_use_id: "tc", content: "result", is_error: true },
  ] },
] };

test("Cloud DB projection survives file reload with native reasoning, tools and error state", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-projection-"));
  try {
    const path = join(root, "session.jsonl");
    const manager = SessionManager.create(root, root); manager.newSession({ id: "s" }); manager.setSessionFile(path);
    assert(syncCloudContext(manager, history));
    await manager.close();
    const reopened = await SessionManager.open(path, root);
    const expected = contextToPiMessages(history.messages);
    assert.deepEqual(reopened.buildSessionContext().messages, expected);
    assert.equal(syncCloudContext(reopened, { ...history, revision: "new" }), false);
    assert.deepEqual(reopened.buildSessionContext().messages, expected);
    const assistant = expected[1];
    assert(assistant);
    assert.equal(assistant.api, "anthropic-messages"); assert.equal(assistant.errorMessage, "failed");
    assert.equal((assistant.usage as { input: number }).input, 7);
    await reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("generation placeholders never advance the Cloud resume marker", () => {
  const manager = SessionManager.create("/tmp", "/tmp"); manager.newSession({ id: "test" });
  const context: RuntimeContext = { ...history, messages: [{ id: "g", turnId: "t", role: "assistant", content: [{ type: "text", text: "queued" }], meta: { generationTaskId: "g", messageKind: "generation_result", generationStatus: "queued" } }] };
  assert.throws(() => syncCloudContext(manager, context), /not settled/);
  assert.equal(manager.getCustomEntries("cohub.context").length, 0);
  assert.equal(manager.buildSessionContext().messages.length, 0);
});

const imageBlock = (url: string): ContentBlock => ({ type: "image", source: { type: "url", url } });
function projected(context: RuntimeContext) {
  const manager = SessionManager.create("/tmp", "/tmp");
  manager.newSession({ id: "images" });
  syncCloudContext(manager, context);
  return manager;
}
function remoteUrls(manager: SessionManager) {
  return manager.buildSessionContext().messages.flatMap((message) => {
    if (message.role !== "user" && message.role !== "toolResult" || typeof message.content === "string") return [];
    return message.content.flatMap((block) => block.type === "image" && "data" in block ? [getRemoteImageUrl(block)] : []);
  });
}

test("retained user and tool images recover with bounded downloads and URL deduplication", { timeout: 5000 }, async () => {
  const image = (index: number) => imageBlock(`https://trusted.test/${index}.png`);
  const manager = projected({ ...history, messages: [
    { id: "u", turnId: "t", role: "user", content: [image(0), image(1)] },
    { id: "a", turnId: "t", role: "assistant", content: [
      { type: "tool_use", id: "tc", name: "read", input: {} },
      { type: "tool_result", tool_use_id: "tc", content: [image(0), image(2), image(3), image(4), image(5), image(1)] },
    ] },
  ] });
  const original = manager.serializeSnapshot();
  const data = await png();
  let active = 0, maximum = 0;
  const calls: string[] = [];
  assert.equal((await hydrateSessionImages(manager, async (url) => {
    calls.push(url); active++; maximum = Math.max(maximum, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active--;
    return { data, mimeType: "image/png" };
  })).changed, false);
  assert.equal(maximum, 4);
  assert.equal(calls.length, 6);
  assert.equal(new Set(calls).size, 6);
  assert.equal(manager.serializeSnapshot(), original, "eligible native URLs need no rewrite");
  assert.equal((await hydrateSessionImages(manager, async () => { throw new Error("Validated native images should not be downloaded again"); })).changed, false);
});

test("existing inline and oversized JSONL images become URLs even when Cloud sync skips their IDs", async () => {
  const root = await mkdtemp(join(tmpdir(), "cloud-existing-images-"));
  const legacy = await png();
  const oversized = await png(3000);
  const context: RuntimeContext = { ...history, messages: [
    { id: "legacy", turnId: "t", role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: legacy.toString("base64") } }] },
    { id: "tool", turnId: "t", role: "assistant", content: [
      { type: "tool_use", id: "tc", name: "read", input: {} },
      { type: "tool_result", tool_use_id: "tc", content: [{ type: "text", text: "read result" }, imageBlock("https://trusted.test/large.png")] },
    ] },
  ] };
  const original = structuredClone(context);
  const path = join(root, "session.jsonl");
  let uploads = 0;
  const stored = new Map<string, Buffer>();
  try {
    const manager = SessionManager.create(root, root); manager.newSession({ id: "s" }); manager.setSessionFile(path);
    syncCloudContext(manager, context);
    manager.appendThinkingLevelChange("high");
    manager.appendCustomEntry("image_description.v1", { sourceEntryId: "legacy", imageIndex: 0, text: "red image" });
    const identities = manager.getEntries().map(({ id, parentId, timestamp, type }) => ({ id, parentId, timestamp, type }));
    const settings = manager.buildSessionContext().thinkingLevel;
    await manager.close();
    for (const revision of [context.revision, "next"]) {
      const restored = await SessionManager.open(path, root);
      assert.equal(syncCloudContext(restored, { ...context, revision }), false);
      const migrated = await hydrateSessionImages(restored, async (url) => ({ data: stored.get(url) ?? (url.endsWith("large.png") ? oversized : legacy), mimeType: "image/png" }), {
        writeImage: async (image) => {
          uploads++;
          const metadata = await sharp(image.data).metadata();
          assert(metadata.width && metadata.width <= 2048);
          const url = `https://trusted.test/migrated-${image.meta.originalWidth === 20 ? "legacy" : "tool"}.png`;
          stored.set(url, image.data);
          return url;
        },
      });
      assert.equal(migrated.changed, revision === context.revision);
      assert.deepEqual(remoteUrls(restored), ["https://trusted.test/migrated-legacy.png", "https://trusted.test/migrated-tool.png"]);
      assert.deepEqual(restored.getEntries().slice(0, identities.length).map(({ id, parentId, timestamp, type }) => ({ id, parentId, timestamp, type })), identities);
      assert.equal(restored.buildSessionContext().thinkingLevel, settings);
      const description = restored.getCustomEntries("image_description.v1")[0]?.data;
      assert(description && typeof description === "object" && "sourceEntryId" in description);
      assert.equal(description.sourceEntryId, "legacy");
      await restored.close();
    }
    assert.equal(uploads, 2, "later restores reuse persisted URLs rather than uploading DB originals again");
    assert.deepEqual(context, original, "DB history is unchanged");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("compacted-away images are never downloaded or uploaded during recovery", async () => {
  const manager = projected({ ...history, messages: [
    { id: "dropped", turnId: "old", role: "user", content: [imageBlock("https://trusted.test/dropped.png")] },
    { id: "kept", turnId: "t", role: "user", content: [imageBlock("https://trusted.test/kept.png")] },
  ] });
  manager.appendCompaction("Earlier work", "kept", 100);
  const data = await png();
  const reads: string[] = [];
  await hydrateSessionImages(manager, async (url) => { reads.push(url); return { data, mimeType: "image/png" }; });
  assert.deepEqual(reads, ["https://trusted.test/kept.png"]);
});

test("transient download or upload failures preserve native sources for retry", async () => {
  const data = await png();
  const context: RuntimeContext = { ...history, messages: [{ id: "u", turnId: "t", role: "user", content: [imageBlock("https://trusted.test/a.png")] }] };
  const manager = projected(context);
  const snapshot = manager.serializeSnapshot();
  for (const read of [async () => null, async () => { throw new Error("CDN timeout"); }]) {
    const recovered = await hydrateSessionImages(manager, read);
    assert.equal(recovered.changed, false);
    assert(JSON.stringify(recovered.messages).includes("Image omitted"));
    assert.equal(manager.serializeSnapshot(), snapshot);
  }
  assert.equal((await hydrateSessionImages(manager, async () => ({ data, mimeType: "image/png" }))).changed, false);
  const inline = projected({ ...context, messages: [{ id: "u", turnId: "t", role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: data.toString("base64") } }] }] });
  const before = inline.serializeSnapshot();
  const omitted = await hydrateSessionImages(inline, async () => null, { writeImage: async () => { throw new Error("Storage unavailable"); } });
  assert.equal(omitted.changed, false);
  assert(JSON.stringify(omitted.messages).includes("Image omitted"));
  assert.equal(inline.serializeSnapshot(), before);
  assert.equal((await hydrateSessionImages(inline, async () => null, { writeImage: async () => "https://trusted.test/retried.png" })).changed, true);
  assert.deepEqual(remoteUrls(inline), ["https://trusted.test/retried.png"]);
});


test("generation image sources recover alongside native URL markers", async () => {
  const context: RuntimeContext = { ...history, messages: [{ id: "generation", turnId: "t", role: "user", content: [imageBlock("https://trusted.test/generation.png")],
    meta: { generationTaskId: "task", messageKind: "generation_request" },
  }] };
  const manager = projected(context);
  const data = await png(3000);
  assert.equal((await hydrateSessionImages(manager, async () => ({ data, mimeType: "image/png" }), { writeImage: async () => "https://trusted.test/resized-generation.png" })).changed, true);
  const message = manager.buildSessionContext().messages[0];
  assert(message?.role === "user" && Array.isArray(message.content));
  const block = message.content[0];
  assert(block?.type === "image" && "source" in block);
  assert.deepEqual(block.source, { type: "url", url: "https://trusted.test/resized-generation.png" });
});

test("cancelled recovery stops queued downloads and preserves the session snapshot", async () => {
  const manager = projected({ ...history, messages: [{ id: "u", turnId: "t", role: "user", content: Array.from({ length: 7 }, (_, i) => imageBlock(`https://trusted.test/${i}.png`)) }] });
  const snapshot = manager.serializeSnapshot();
  const controller = new AbortController();
  let started = 0;
  let ready: (() => void) | undefined;
  const firstBatch = new Promise<void>((resolve) => { ready = resolve; });
  const pending = hydrateSessionImages(manager, async (_url, signal) => {
    assert.equal(signal, controller.signal);
    if (++started === 4) ready?.();
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, { signal: controller.signal });
  await firstBatch;
  const reason = new Error("Recovery cancelled");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
  assert.equal(started, 4);
  assert.equal(manager.serializeSnapshot(), snapshot);
});
