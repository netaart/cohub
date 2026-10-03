import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import type { ContentBlock } from "@cohub/protocol/core";
import { getRemoteImageUrl } from "@cohub/model-runtime/image-content";
import { AGENT_IMAGE_URL_PASSTHROUGH_MAX_BYTES, AGENT_IMAGE_MAX_OUTPUT_BYTES, normalizeAgentImage, normalizeAgentToolImageContent, normalizeImageContentBlock } from "../image-normalizer.js";

const sampleUrl = "https://public.cohub.run/spaces/x/chat/a.png";
const resizedUrl = "https://public.cohub.run/chat-attachments/resized.png";
const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 12, g: 34, b: 56 } } }).png().toBuffer();
const urlBlock = (): Extract<ContentBlock, { type: "image" }> => ({ type: "image", source: { type: "url", url: sampleUrl } });

test("eligible URL images stay URLs without redundant encoding or upload", async () => {
  for (const width of [64, 2048]) {
    const data = await png(width, 48);
    const block = await normalizeImageContentBlock(urlBlock(), {
      readUrlImage: async () => ({ data, mimeType: "image/png" }),
      writeImage: async () => { throw new Error("Unexpected upload"); },
    });
    assert.equal(block.type, "image");
    assert.deepEqual(block.source, { type: "url", url: sampleUrl });
    assert.equal(block._meta?.imageUrlPassthrough, true);
    assert.equal(block._meta?.originalWidth, width);
  }
});

test("an approved URL is not downloaded or uploaded again on later passes", async () => {
  let reads = 0, uploads = 0;
  const data = await png(3000, 40);
  const options = {
    readUrlImage: async () => { reads++; return { data, mimeType: "image/png" }; },
    writeImage: async () => { uploads++; return resizedUrl; },
  };
  const first = await normalizeImageContentBlock(urlBlock(), options);
  assert.equal(first.type, "image");
  assert.deepEqual(await normalizeImageContentBlock(first, options), first);
  assert.equal(reads, 1);
  assert.equal(uploads, 1);
});

test("oversized landscape URL images resize to 2048px and upload bytes", async () => {
  const data = await png(4096, 2048);
  const block = await normalizeImageContentBlock(urlBlock(), {
    readUrlImage: async () => ({ data, mimeType: "image/png" }),
    writeImage: async (image) => {
      assert(Buffer.isBuffer(image.data));
      const metadata = await sharp(image.data).metadata();
      assert.equal(metadata.width, 2048);
      assert.equal(metadata.height, 1024);
      assert.equal(image.mimeType, "image/png");
      return resizedUrl;
    },
  });
  assert.equal(block.type, "image");
  assert.deepEqual(block.source, { type: "url", url: resizedUrl });
  assert.equal(block._meta?.imageUrlPassthrough, true);
  assert.equal(block._meta?.originalUrl, sampleUrl);
});

test("portrait resizing preserves aspect ratio and transparency", async () => {
  const data = await sharp({ create: { width: 1000, height: 4000, channels: 4, background: { r: 12, g: 34, b: 56, alpha: 0.5 } } }).png().toBuffer();
  const block = await normalizeImageContentBlock(urlBlock(), {
    readUrlImage: async () => ({ data, mimeType: "image/png" }),
    writeImage: async (image) => {
      const metadata = await sharp(image.data).metadata();
      assert.equal(metadata.width, 512);
      assert.equal(metadata.height, 2048);
      assert.equal(metadata.hasAlpha, true);
      return resizedUrl;
    },
  });
  assert.equal(block.type, "image");
  assert.equal(block.source.type, "url");
});

test("JPEG resizing keeps JPEG rather than forcing WebP", async () => {
  const data = await sharp(await png(3000, 20)).jpeg().toBuffer();
  const block = await normalizeImageContentBlock(urlBlock(), {
    readUrlImage: async () => ({ data, mimeType: "image/jpeg" }),
    writeImage: async (image) => {
      assert.equal(image.mimeType, "image/jpeg");
      assert.equal((await sharp(image.data).metadata()).width, 2048);
      return resizedUrl;
    },
  });
  assert.equal(block.type, "image");
  assert.equal(block.source.type, "url");
});

test("the URL byte limit also applies to images whose dimensions already fit", async () => {
  const data = Buffer.concat([await png(20, 20), Buffer.alloc(AGENT_IMAGE_URL_PASSTHROUGH_MAX_BYTES)]);
  const block = await normalizeImageContentBlock(urlBlock(), {
    readUrlImage: async () => ({ data, mimeType: "image/png" }),
    writeImage: async (image) => { assert(image.data.byteLength <= AGENT_IMAGE_MAX_OUTPUT_BYTES); return resizedUrl; },
  });
  assert.equal(block.type, "image");
  assert.deepEqual(block.source, { type: "url", url: resizedUrl });
});

test("small SVG and TIFF images are uploaded as supported PNG files", async () => {
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>`);
  const tiff = await sharp(await png(20, 20)).tiff().toBuffer();
  for (const [data, mimeType] of [[svg, "image/svg+xml"], [tiff, "image/tiff"]] as const) {
    const block = await normalizeImageContentBlock(urlBlock(), {
      readUrlImage: async () => ({ data, mimeType }),
      writeImage: async (image) => {
        assert.equal((await sharp(image.data).metadata()).format, "png");
        assert.equal(image.mimeType, "image/png");
        return resizedUrl;
      },
    });
    assert.equal(block.type, "image");
    assert.deepEqual(block.source, { type: "url", url: resizedUrl });
  }
});

test("base64 ingress and tool images upload bytes and retain URL markers", async () => {
  const data = await png(32, 24);
  let uploads = 0;
  const options = { writeImage: async (image: { data: Buffer; mimeType: string }) => {
    uploads++;
    assert.deepEqual(image.data, data);
    assert.equal(image.mimeType, "image/png");
    return resizedUrl;
  } };
  const block = await normalizeImageContentBlock({ type: "image", source: { type: "base64", media_type: "image/png", data: data.toString("base64") } }, options);
  assert.equal(block.type, "image");
  assert.deepEqual(block.source, { type: "url", url: resizedUrl });
  const toolImage = await normalizeAgentToolImageContent({ data, mimeType: "image/png" }, options);
  assert.equal(toolImage.type, "image");
  assert.equal(getRemoteImageUrl(toolImage), resizedUrl);
  assert.equal(uploads, 2);
});

test("unavailable URLs become explicit omission text", async () => {
  const block = await normalizeImageContentBlock(urlBlock(), { readUrlImage: async () => null });
  assert.equal(block.type, "text");
  assert.equal(block._meta?.reason, "load_failed");
});

test("caller-supplied passthrough metadata cannot skip image validation", async () => {
  const block = await normalizeImageContentBlock({ ...urlBlock(), _meta: { imageUrlPassthrough: true } }, { readUrlImage: async () => null });
  assert.equal(block.type, "text");
  assert.equal(block._meta?.reason, "load_failed");
});

test("upload failure becomes omission text without an inline base64 fallback", async () => {
  const data = await png(3000, 20);
  const block = await normalizeImageContentBlock(urlBlock(), {
    readUrlImage: async () => ({ data, mimeType: "image/png" }),
    writeImage: async () => { throw new Error("Storage unavailable"); },
  });
  assert.equal(block.type, "text");
  assert.equal(block._meta?.reason, "upload_failed");
});

test("cancellation during upload propagates without persisting omission text", async () => {
  const controller = new AbortController();
  const reason = new Error("Turn stopped");
  const data = await png(3000, 20);
  await assert.rejects(normalizeImageContentBlock(urlBlock(), {
    signal: controller.signal,
    readUrlImage: async () => ({ data, mimeType: "image/png" }),
    writeImage: async () => { controller.abort(reason); throw reason; },
  }), (error) => error === reason);
});


test("metadata-readable truncated PNGs are omitted before URL or tool transport", async () => {
  const original = await sharp(randomBytes(128 * 128 * 3), { raw: { width: 128, height: 128, channels: 3 } }).png().toBuffer();
  const damaged = original.subarray(0, Math.floor(original.length / 2));
  assert.equal((await sharp(damaged).metadata()).width, 128);
  await assert.rejects(sharp(damaged).raw().toBuffer());
  assert.equal(await normalizeAgentImage({ data: damaged, mimeType: "image/png", sourceKind: "public_asset" }), null);
  const options = {
    readUrlImage: async () => ({ data: damaged, mimeType: "image/png" }),
    writeImage: async () => { throw new Error("Damaged images must never be uploaded"); },
  };
  const block = await normalizeImageContentBlock(urlBlock(), options);
  assert.equal(block.type, "text");
  assert.equal(block._meta?.reason, "decode_failed");
  assert.equal((await normalizeAgentToolImageContent({ data: damaged, mimeType: "image/png" }, options)).type, "text");
});

test("valid original formats remain byte-identical after full decode validation", async () => {
  const input = sharp(await png(64, 48));
  for (const data of [await input.clone().png().toBuffer(), await input.clone().jpeg().toBuffer(), await input.clone().gif().toBuffer(), await input.clone().webp().toBuffer()]) {
    const result = await normalizeAgentImage({ data, sourceKind: "public_asset" });
    assert(result);
    assert.equal(result.data, data);
  }
});

test("stricter byte limits also constrain encoded transparent derivatives", async () => {
  const data = await sharp(randomBytes(128 * 128 * 4), { raw: { width: 128, height: 128, channels: 4 } }).png().toBuffer();
  const maxBytes = 5_000;
  assert(data.length > maxBytes);
  const result = await normalizeAgentImage({ data, sourceKind: "public_asset", maxBytes });
  assert(result);
  assert(result.data.length <= maxBytes);
  assert.equal(result.meta.normalizedMaxBytes, maxBytes);
  const metadata = await sharp(result.data).metadata();
  assert.equal(metadata.hasAlpha, true);
  assert(metadata.width && metadata.width < 128);
  assert(metadata.height && metadata.height < 128);
  await sharp(result.data).raw().toBuffer();
});
