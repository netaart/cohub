import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.js";
import router from "../src/routes/internal/public-assets.route.js";

test("internal image upload plans require the worker secret", async () => {
  const response = await router.request("/image-upload", { method: "POST", body: "{}" });
  assert.equal(response.status, 403);
});

test("internal image upload plans reuse user-scoped attachment storage", async (testContext) => {
  const storage = { workerSecret: "test-worker", chatAttachmentS3Bucket: "bucket", chatAttachmentPublicBaseUrl: "https://uploads.example.com", userUploadS3Endpoint: "https://s3.example.com", userUploadS3AccessKeyId: "test-key", userUploadS3SecretAccessKey: "test-secret" };
  const previous = Object.fromEntries(Object.keys(storage).map((key) => [key, config[key as keyof typeof storage]]));
  Object.assign(config, storage);
  testContext.after(() => Object.assign(config, previous));
  const response = await router.request("/image-upload", { method: "POST", headers: { "x-worker-secret": "test-worker", "content-type": "application/json" }, body: JSON.stringify({ userId: "user_1", file: { size: 1024, mimeType: "image/png" } }) });
  assert.equal(response.status, 200);
  const plan = await response.json();
  assert.match(plan.asset.objectKey, /chat-attachments\/user_1\/[0-9a-f-]{36}\.png$/);
  assert.match(plan.asset.publicUrl, /^https:\/\/uploads.example.com\//);
  assert.equal(plan.asset.uploadMethod, "PUT");
  assert.equal(plan.asset.uploadHeaders["content-type"], "image/png");
});

test("internal image upload plans reject unsafe owners, oversized images and unsupported types", async (testContext) => {
  const previous = config.workerSecret;
  config.workerSecret = "test-worker";
  testContext.after(() => { config.workerSecret = previous; });
  for (const input of [
    { userId: "../escape", file: { size: 1, mimeType: "image/png" } },
    { userId: "user", file: { size: 5 * 1024 * 1024 + 1, mimeType: "image/png" } },
    { userId: "user", file: { size: 1, mimeType: "image/svg+xml" } },
  ]) {
    const response = await router.request("/image-upload", { method: "POST", headers: { "x-worker-secret": "test-worker", "content-type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(response.status, 400);
  }
});
