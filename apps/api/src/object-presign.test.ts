import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import {
  createPresignedGetObjectUrl,
  createPresignedPutObjectUrl,
  type PresignStorageConfig,
} from "./object-presign.js";

const storage: PresignStorageConfig = {
  endpoint: "https://account-id.r2.cloudflarestorage.com",
  publicEndpoint: "https://account-id.r2.cloudflarestorage.com",
  region: "auto",
  bucket: "cohub-chat-attachments",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  includeUnsignedPayloadQuery: true,
};

describe("object presigning", () => {
  it("signs an R2 PUT with immutable attachment headers", () => {
    const signed = createPresignedPutObjectUrl(
      storage,
      "dev/chat-attachments/user/file.txt",
      "text/plain",
      "public, max-age=31536000, immutable",
      "attachment; filename=\"file.txt\"",
    );
    const url = new URL(signed.uploadUrl);

    assert.equal(url.hostname, "cohub-chat-attachments.account-id.r2.cloudflarestorage.com");
    assert.equal(url.pathname, "/dev/chat-attachments/user/file.txt");
    assert.equal(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
    assert.equal(url.searchParams.get("X-Amz-Content-Sha256"), "UNSIGNED-PAYLOAD");
    assert.match(url.searchParams.get("X-Amz-SignedHeaders") ?? "", /content-disposition/);
    assert.deepEqual(signed.headers, {
      "content-type": "text/plain",
      "cache-control": "public, max-age=31536000, immutable",
      "content-disposition": "attachment; filename=\"file.txt\"",
    });
  });

  it("signs exact PUT length and OSS create-only conditions when requested", () => {
    const signed = createPresignedPutObjectUrl(
      { ...storage, endpoint: "https://oss-us-west-1.aliyuncs.com", publicEndpoint: "https://oss-us-west-1.aliyuncs.com" },
      "dev/p/space/file.html",
      "text/html",
      "public, max-age=300",
      null,
      { contentLength: 42, forbidOverwrite: true, metadata: { width: "640" } },
    );
    const url = new URL(signed.uploadUrl);

    assert.match(url.searchParams.get("X-Amz-SignedHeaders") ?? "", /content-length/);
    assert.match(url.searchParams.get("X-Amz-SignedHeaders") ?? "", /x-amz-meta-width;x-oss-forbid-overwrite/);
    assert.deepEqual(signed.headers, {
      "content-type": "text/html",
      "cache-control": "public, max-age=300",
      "content-length": "42",
      "x-oss-forbid-overwrite": "true",
      "x-amz-meta-width": "640",
    });
  });

  it("signs S3 conditional creation and integrity without adding ACL headers", () => {
    const signed = createPresignedPutObjectUrl(storage, "native/sha.jsonl", "application/x-ndjson", "private, max-age=0", null,
      { contentLength: 3, contentMd5: "test-md5", forbidOverwrite: true });
    assert.equal(signed.headers?.["if-none-match"], "*");
    assert.equal(signed.headers?.["content-md5"], "test-md5");
    assert.equal(signed.headers?.["x-amz-acl"], undefined);
    assert.equal(signed.headers?.["x-oss-object-acl"], undefined);
    const headers = new URL(signed.uploadUrl).searchParams.get("X-Amz-SignedHeaders");
    assert(headers?.includes("content-md5"));
    assert(!headers?.includes("acl"));
  });

  it("signs a GET that downloads as an attachment under a non-ASCII name", () => {
    mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 0, 1) });
    try {
      const url = new URL(createPresignedGetObjectUrl(storage, "checkpoint-assets/report.pdf", { attachmentName: "报告 (1).pdf" }).downloadUrl);
      assert.equal(url.searchParams.get("response-content-disposition"), "attachment;filename*=UTF-8''%E6%8A%A5%E5%91%8A%20%281%29.pdf");
      // Reference value from @smithy/signature-v4's canonical request.
      assert.equal(url.searchParams.get("X-Amz-Signature"), "c417ec9b1b7f706cfbba371cd1db64fcd04f9d26b87d81d2ea75f04e791a64e1");
    } finally {
      mock.timers.reset();
    }
  });
});
