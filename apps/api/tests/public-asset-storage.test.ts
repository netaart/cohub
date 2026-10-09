import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.js";
import {
  assertPublicAssetUploadFile,
  buildPublicAssetObjectKey,
  createPublicAssetUploadPlan,
  isPublicAssetPurpose,
  type PublicAssetPurpose,
  PublicAssetValidationError,
} from "../src/public-asset-storage.js";

const file = (mimeType: string, size = 1024) => ({ size, mimeType, filename: "shot.png" });

test("accepts generation inputs as user-scoped media", () => {
  assert.equal(isPublicAssetPurpose("generation_input"), true);
  for (const mimeType of ["image/png", "video/mp4", "audio/mpeg"]) {
    assert.doesNotThrow(() => assertPublicAssetUploadFile({ purpose: "generation_input", file: file(mimeType) }));
  }
  const key = buildPublicAssetObjectKey({
    purpose: "generation_input",
    userUuid: "user_1",
    mimeType: "image/png",
    filename: "shot.png",
  });
  assert.match(key, /(^|\/)generation-inputs\/user_1\/[0-9a-f-]{36}\.png$/);
});

test("rejects generation inputs that are not image, video, or audio", () => {
  for (const mimeType of ["image/svg+xml", "text/html", "application/pdf", "application/octet-stream"]) {
    assert.throws(
      () => assertPublicAssetUploadFile({ purpose: "generation_input", file: file(mimeType) }),
      PublicAssetValidationError,
      mimeType,
    );
  }
  assert.equal(isPublicAssetPurpose("anything_else"), false);
});

test("only attachments download under their name; avatars and inputs serve inline", (t) => {
  const storage = {
    chatAttachmentS3Bucket: "bucket",
    chatAttachmentPublicBaseUrl: "https://uploads.example.com",
    userUploadS3Endpoint: "https://s3.example.com",
    userUploadS3AccessKeyId: "key",
    userUploadS3SecretAccessKey: "secret",
  };
  const previous = Object.fromEntries(Object.keys(storage).map((key) => [key, config[key as keyof typeof storage]]));
  Object.assign(config, storage);
  t.after(() => Object.assign(config, previous));
  const disposition = (purpose: PublicAssetPurpose) =>
    createPublicAssetUploadPlan({
      purpose,
      uploadProtocol: "presigned_put_v1",
      userUuid: "user_1",
      spaceId: "space_1",
      sessionId: "session_1",
      file: file("image/png"),
    }).asset.uploadHeaders?.["content-disposition"];

  assert.match(disposition("chat_attachment") ?? "", /^attachment; filename="shot\.png"/);
  assert.match(disposition("app_source") ?? "", /^attachment;/);
  assert.equal(disposition("user_avatar"), undefined);
  assert.equal(disposition("generation_input"), undefined);
});
