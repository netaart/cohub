import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";
import { config } from "../src/config.js";
import {
  assertPublicAssetUploadFile,
  buildPublicAssetObjectKey,
  createPublicAssetUploadPlan,
  isPublicAssetPurpose,
  type PublicAssetPurpose,
  PublicAssetValidationError,
} from "../src/public-asset-storage.js";

const file = (mimeType: string, size = 1024, filename = "shot.png") => ({ size, mimeType, filename });

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

test("rejects generation inputs that are not image, video, audio, or a 3D model", () => {
  for (const mimeType of ["image/svg+xml", "text/html", "application/pdf", "application/octet-stream", "image/x+xml", "video/x+xml", "audio/x+xml"]) {
    assert.throws(
      () => assertPublicAssetUploadFile({ purpose: "generation_input", file: file(mimeType) }),
      PublicAssetValidationError,
      mimeType,
    );
  }
  assert.equal(isPublicAssetPurpose("anything_else"), false);
});

test("session images accept raster images and reject XML image types", () => {
  assert.doesNotThrow(() => assertPublicAssetUploadFile({ purpose: "session_image", file: file("image/png") }));
  for (const mimeType of ["image/svg+xml", "image/x+xml", "text/html"]) {
    assert.throws(
      () => assertPublicAssetUploadFile({ purpose: "session_image", file: file(mimeType) }),
      PublicAssetValidationError,
      mimeType,
    );
  }
});

test("accepts GLB, glTF, OBJ, FBX and STL generation inputs by extension and serves them with that extension's type", (t) => {
  useUserUploadStorage(t);
  const served = (mimeType: string, filename: string) => {
    const { asset } = createPublicAssetUploadPlan({
      purpose: "generation_input",
      uploadProtocol: "presigned_put_v1",
      userUuid: "user_1",
      file: file(mimeType, 1024, filename),
    });
    return { extension: asset.objectKey.split(".").pop(), type: asset.uploadHeaders?.["content-type"] };
  };

  assert.deepEqual(served("model/gltf-binary", "barrel.glb"), { extension: "glb", type: "model/gltf-binary" });
  assert.deepEqual(served("application/octet-stream", "barrel.GLB"), { extension: "glb", type: "model/gltf-binary" });
  assert.deepEqual(served("model/gltf+json", "barrel.gltf"), { extension: "gltf", type: "model/gltf+json" });
  assert.deepEqual(served("model/obj", "barrel.obj"), { extension: "obj", type: "model/obj" });
  assert.deepEqual(served("model/stl", "barrel.stl"), { extension: "stl", type: "model/stl" });
  assert.deepEqual(served("application/octet-stream", "barrel.fbx"), { extension: "fbx", type: "application/octet-stream" });
});

test("rejects 3D generation inputs whose type or extension is not an accepted model format", () => {
  const rejected: Array<[string, string | undefined]> = [
    ["model/x3d+xml", "scene.x3d"],
    ["model/vnd.collada+xml", "scene.dae"],
    ["model/x3d+xml", "scene.glb"],
    ["model/gltf-binary", undefined],
    ["model/gltf-binary", "barrel.obj"],
    ["model/vnd.usdz+zip", "barrel.usdz"],
    ["application/octet-stream", "barrel.bin"],
  ];
  for (const [mimeType, filename] of rejected) {
    assert.throws(
      () => assertPublicAssetUploadFile({ purpose: "generation_input", file: { size: 1024, mimeType, filename } }),
      PublicAssetValidationError,
      `${mimeType} ${filename}`,
    );
  }
});

test("chat attachments keep the model type the client sent", (t) => {
  useUserUploadStorage(t);
  const { asset } = createPublicAssetUploadPlan({
    purpose: "chat_attachment",
    uploadProtocol: "presigned_put_v1",
    userUuid: "user_1",
    file: { size: 1024, mimeType: "model/vnd.collada+xml" },
  });
  assert.match(asset.objectKey, /\.bin$/);
  assert.equal(asset.uploadHeaders?.["content-type"], "model/vnd.collada+xml");
});

function useUserUploadStorage(t: TestContext) {
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
}

test("only attachments download under their name; avatars and inputs serve inline", (t) => {
  useUserUploadStorage(t);
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
