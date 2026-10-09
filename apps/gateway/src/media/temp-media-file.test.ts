import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { UPLOAD_MAX_FILE_BYTES } from "@cohub/protocol";
import { createAesEcbDecryptStream, createAesEcbEncryptStream } from "../providers/wechat/media/crypto.js";
import {
  base64ToTempMediaFile,
  hashTempMediaFile,
  responseToTempMediaFile,
  transformTempMediaFile,
} from "./temp-media-file.js";

test("gateway attachments share the durable upload single-file cap", () => {
  assert.equal(UPLOAD_MAX_FILE_BYTES, 1024 * 1024 * 1024);
});

test("MIME-wrapped base64 is decoded across chunk boundaries and cleaned up", async () => {
  const source = randomBytes(1024 * 1024 + 17);
  const wrapped = source.toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "";
  const file = await base64ToTempMediaFile(wrapped, source.length, "base64-test");
  assert.equal(file.size, source.length);
  assert.deepEqual(await readFile(file.path), source);
  assert.equal(await hashTempMediaFile(file, "sha256"), hashBuffer(source));
  await file.cleanup();
  await assert.rejects(readFile(file.path));
});

test("response media enforces its byte limit", async () => {
  await assert.rejects(
    responseToTempMediaFile(new Response(randomBytes(17)), 16, "response-test"),
    /exceeds 16 bytes/,
  );
});

test("response media times out while reading the body", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
    },
    cancel() {
      cancelled = true;
    },
  });

  await assert.rejects(
    responseToTempMediaFile(new Response(body), 16, "slow-response", { timeoutMs: 20 }),
    /body timed out after 20ms/,
  );
  assert.equal(cancelled, true);
});

test("temporary media supports streaming AES round trips", async () => {
  const source = randomBytes(1024 * 1024 + 3);
  const key = randomBytes(16);
  const plain = await base64ToTempMediaFile(source.toString("base64"), source.length, "plain-test");
  const encrypted = await transformTempMediaFile(
    plain,
    createAesEcbEncryptStream(key),
    source.length + 16,
    "encrypted-test",
  );
  const decrypted = await transformTempMediaFile(
    encrypted,
    createAesEcbDecryptStream(key),
    source.length,
    "decrypted-test",
  );

  try {
    assert.deepEqual(await readFile(decrypted.path), source);
  } finally {
    await Promise.all([plain.cleanup(), encrypted.cleanup(), decrypted.cleanup()]);
  }
});

function hashBuffer(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
