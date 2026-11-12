import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { fetchRemoteImage } from "./index.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const serve = (bytes: number[], contentType?: string) => {
  globalThis.fetch = async () => new Response(new Uint8Array(bytes), { headers: contentType ? { "content-type": contentType } : {} });
  return fetchRemoteImage({ url: "https://1.1.1.1/image.webp" });
};

const RIFF_WEBP = [0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50];

test("fetchRemoteImage declares the sniffed image type over the response header", async () => {
  assert.equal((await serve([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/webp")).mimeType, "image/png");
  assert.equal((await serve([0xff, 0xd8, 0xff, 0xe0], "image/webp")).mimeType, "image/jpeg");
  assert.equal((await serve([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], "image/png")).mimeType, "image/gif");
  assert.equal((await serve(RIFF_WEBP, "image/png; charset=binary")).mimeType, "image/webp");
  assert.equal((await serve([1, 2, 3, 4], "image/avif")).mimeType, "image/avif");
  assert.equal((await serve([1, 2, 3, 4])).mimeType, "application/octet-stream");
  await assert.rejects(serve([0x89, 0x50, 0x4e, 0x47], "text/html"), /not an image: text\/html/);
});
