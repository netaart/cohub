import assert from "node:assert/strict";
import { test } from "node:test";

process.env.DATABASE_URL ??= "postgres://localhost/cohub_test";
process.env.APP_ENCRYPTION_KEY ??= "test-key";
process.env.SESSIONS_NAMESPACE ??= "test";

test("trusted image downloads forward the turn cancellation to fetch", async (t) => {
  const { env } = await import("../env.js");
  const { readPublicAssetImageUrl } = await import("../public-asset-storage.js");
  const original = env.PUBLIC_ASSET_CDN_BASE_URL;
  env.PUBLIC_ASSET_CDN_BASE_URL = "https://assets.test";
  t.after(() => { env.PUBLIC_ASSET_CDN_BASE_URL = original; });
  const controller = new AbortController();
  let fetchSignal: AbortSignal | null | undefined;
  t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
    fetchSignal = init?.signal;
    assert(fetchSignal);
    const signal = fetchSignal;
    return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const prefix = env.ENV === "prod" ? "" : `${env.ENV}/`;
  const downloading = readPublicAssetImageUrl(`https://assets.test/${prefix}chat-attachments/a.png`, controller.signal);
  const reason = new Error("Turn stopped");
  controller.abort(reason);
  await assert.rejects(downloading, (error) => error === reason);
  assert.equal(fetchSignal?.aborted, true);
});

test("rejected image responses cancel the unread body", async (t) => {
  const { env } = await import("../env.js");
  const { readPublicAssetImageUrl } = await import("../public-asset-storage.js");
  const original = env.PUBLIC_ASSET_CDN_BASE_URL;
  env.PUBLIC_ASSET_CDN_BASE_URL = "https://assets.test";
  t.after(() => { env.PUBLIC_ASSET_CDN_BASE_URL = original; });
  let cancelled = false;
  t.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { "content-type": "text/html" } }));
  const prefix = env.ENV === "prod" ? "" : `${env.ENV}/`;
  assert.equal(await readPublicAssetImageUrl(`https://assets.test/${prefix}chat-attachments/a.png`), null);
  assert.equal(cancelled, true);
});

test("already cancelled downloads fail before starting fetch", async (t) => {
  const { readPublicAssetImageUrl } = await import("../public-asset-storage.js");
  let fetched = false;
  t.mock.method(globalThis, "fetch", async () => { fetched = true; return new Response(); });
  const controller = new AbortController();
  const reason = new Error("Already stopped");
  controller.abort(reason);
  await assert.rejects(readPublicAssetImageUrl("https://assets.test/a.png", controller.signal), (error) => error === reason);
  assert.equal(fetched, false);
});
