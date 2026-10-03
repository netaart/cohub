import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost/cohub_test";
process.env.APP_ENCRYPTION_KEY ??= "test-key";
process.env.SESSIONS_NAMESPACE ??= "test";

test("image uploads send binary bytes using the existing attachment upload plan", async (testContext) => {
  const { env } = await import("../env.js");
  const { uploadPublicAssetImage } = await import("../image-upload.js");
  const previousBase = env.CHAT_ATTACHMENT_PUBLIC_BASE_URL;
  env.CHAT_ATTACHMENT_PUBLIC_BASE_URL = "https://assets.test";
  testContext.after(() => { env.CHAT_ATTACHMENT_PUBLIC_BASE_URL = previousBase; });
  const prefix = env.ENV === "prod" ? "" : `${env.ENV}/`;
  const url = `https://assets.test/${prefix}chat-attachments/user/image.png`;
  const data = Buffer.from([0, 1, 255, 42]);
  const calls: string[] = [];
  testContext.mock.method(globalThis, "fetch", async (target: unknown, init?: RequestInit) => {
    calls.push(String(target));
    assert(init?.signal);
    if (init.method === "POST") {
      assert.deepEqual(JSON.parse(String(init.body)), { userId: "user", file: { size: data.byteLength, mimeType: "image/png" } });
      return Response.json({ asset: { publicUrl: url, uploadMethod: "PUT", uploadUrl: "https://storage.test/upload", uploadHeaders: { "content-type": "image/png" } } });
    }
    assert.equal(init.method, "PUT");
    assert.deepEqual(init.body, new Uint8Array(data));
    assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("content-type"), "image/png");
    return new Response(null, { status: 200 });
  });
  assert.equal(await uploadPublicAssetImage({ data, mimeType: "image/png" }, "user"), url);
  assert(calls[0]?.endsWith("/internal/public-assets/image-upload"));
  assert.equal(calls.length, 2);
});

test("image uploads propagate cancellation into the in-flight PUT", async (testContext) => {
  const { env } = await import("../env.js");
  const { uploadPublicAssetImage } = await import("../image-upload.js");
  const previousBase = env.CHAT_ATTACHMENT_PUBLIC_BASE_URL;
  env.CHAT_ATTACHMENT_PUBLIC_BASE_URL = "https://assets.test";
  testContext.after(() => { env.CHAT_ATTACHMENT_PUBLIC_BASE_URL = previousBase; });
  const prefix = env.ENV === "prod" ? "" : `${env.ENV}/`;
  const controller = new AbortController();
  let markStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  testContext.mock.method(globalThis, "fetch", async (_target: unknown, init?: RequestInit) => {
    if (init?.method === "POST") return Response.json({ asset: { publicUrl: `https://assets.test/${prefix}chat-attachments/user/image.png`, uploadMethod: "PUT", uploadUrl: "https://storage.test/upload" } });
    const signal = init?.signal;
    assert(signal);
    markStarted?.();
    return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const pending = uploadPublicAssetImage({ data: Buffer.from([1]), mimeType: "image/png" }, "user", controller.signal);
  await started;
  const reason = new Error("Turn stopped");
  controller.abort(reason);
  await assert.rejects(pending, (error) => error === reason);
});

test("failed image PUTs never return a durable URL", async (testContext) => {
  const { env } = await import("../env.js");
  const { uploadPublicAssetImage } = await import("../image-upload.js");
  const previousBase = env.CHAT_ATTACHMENT_PUBLIC_BASE_URL;
  env.CHAT_ATTACHMENT_PUBLIC_BASE_URL = "https://assets.test";
  testContext.after(() => { env.CHAT_ATTACHMENT_PUBLIC_BASE_URL = previousBase; });
  const prefix = env.ENV === "prod" ? "" : `${env.ENV}/`;
  testContext.mock.method(globalThis, "fetch", async (_target: unknown, init?: RequestInit) => init?.method === "POST"
    ? Response.json({ asset: { publicUrl: `https://assets.test/${prefix}chat-attachments/user/image.png`, uploadMethod: "PUT", uploadUrl: "https://storage.test/upload" } })
    : new Response(null, { status: 503 }));
  await assert.rejects(uploadPublicAssetImage({ data: Buffer.from([1]), mimeType: "image/png" }, "user"), /Image upload failed 503/);
});
