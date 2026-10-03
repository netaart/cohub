import { createHash } from "node:crypto";
import sharp from "sharp";
import type { ContentBlock } from "@cohub/protocol/core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { contentBlockToPiImage } from "@cohub/model-runtime/image-content";
import { logger } from "./logger.js";

export const AGENT_IMAGE_MAX_EDGE = 2048;
export const AGENT_IMAGE_MAX_INPUT_BYTES = 32 * 1024 * 1024;
export const AGENT_IMAGE_MAX_INPUT_PIXELS = 64_000_000;
export const AGENT_IMAGE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
export const AGENT_IMAGE_URL_PASSTHROUGH_MAX_BYTES = 5 * 1024 * 1024;
export const AGENT_IMAGE_URL_PASSTHROUGH_MAX_EDGE = AGENT_IMAGE_MAX_EDGE;

const IMAGE_NORMALIZE_CONCURRENCY = 2;
const validatedImages = new WeakSet<object>();
const BASE64_PREFIX_PATTERN = /^data:[^;,]+;base64,/;
const BASE64_INPUT_MAX_CHARS = Math.ceil(AGENT_IMAGE_MAX_INPUT_BYTES / 3) * 4 + 64;
const IMAGE_MIME_TYPES: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

type NormalizeImageInput = {
  data: Buffer;
  mimeType?: string | null;
  sourceKind: "user_message" | "tool_result" | "public_asset";
  label?: string;
  originalSource?: "base64" | "url" | "file";
  originalUrl?: string;
  maxEdge?: number;
  maxBytes?: number;
};
export type NormalizedImage = { data: Buffer; mimeType: string; meta: Record<string, unknown> };
export type ImageNormalizationOptions = {
  readUrlImage?: (url: string, signal?: AbortSignal) => Promise<{ data: Buffer; mimeType: string } | null>;
  writeImage?: (image: NormalizedImage) => Promise<string>;
  userId?: string | null;
  signal?: AbortSignal;
};

async function writeImage(image: NormalizedImage, options: ImageNormalizationOptions): Promise<string> {
  if (options.writeImage) return options.writeImage(image);
  const { uploadPublicAssetImage } = await import("./image-upload.js");
  return uploadPublicAssetImage(image, options.userId, options.signal);
}

export function imageOmittedText(reason: string, label?: string) {
  return label ? `Image omitted (${label}): ${reason}.` : `Image omitted: ${reason}.`;
}

export async function normalizeAgentImage(input: NormalizeImageInput): Promise<NormalizedImage | null> {
  if (input.data.byteLength === 0 || input.data.byteLength > AGENT_IMAGE_MAX_INPUT_BYTES) return null;
  try {
    const metadata = await sharp(input.data, { animated: false, limitInputPixels: AGENT_IMAGE_MAX_INPUT_PIXELS }).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height) return null;
    const maxEdge = Math.min(input.maxEdge ?? AGENT_IMAGE_MAX_EDGE, AGENT_IMAGE_MAX_EDGE);
    const maxBytes = input.maxBytes ?? AGENT_IMAGE_MAX_OUTPUT_BYTES;
    const outputMaxBytes = Math.min(maxBytes, AGENT_IMAGE_MAX_OUTPUT_BYTES);
    const originalMimeType = IMAGE_MIME_TYPES[metadata.format ?? ""];
    const originalMeta = {
      originalMimeType: input.mimeType ?? null, originalSource: input.originalSource ?? null,
      originalUrl: input.originalUrl ?? null, originalSizeBytes: input.data.byteLength,
      originalWidth: width, originalHeight: height,
      originalSha256: createHash("sha256").update(input.data).digest("hex"),
    };
    if (originalMimeType && width <= maxEdge && height <= maxEdge && input.data.byteLength <= maxBytes) {
      // Header metadata alone also accepts truncated images. Decode all frames without re-encoding.
      await sharp(input.data, { animated: true, limitInputPixels: AGENT_IMAGE_MAX_INPUT_PIXELS }).stats();
      return { data: input.data, mimeType: originalMimeType, meta: originalMeta };
    }
    let resizeEdge = Math.min(maxEdge, Math.max(width, height));
    const pipeline = () => sharp(input.data, { animated: false, limitInputPixels: AGENT_IMAGE_MAX_INPUT_PIXELS })
      .rotate().resize(resizeEdge, resizeEdge, { fit: "inside", withoutEnlargement: true });
    let mimeType = metadata.format === "jpeg" ? "image/jpeg" : "image/png";
    let output = mimeType === "image/jpeg"
      ? await pipeline().jpeg({ quality: 86 }).toBuffer({ resolveWithObject: true })
      : await pipeline().png().toBuffer({ resolveWithObject: true });
    if (output.data.byteLength > outputMaxBytes && metadata.hasAlpha) {
      output = await pipeline().png({ palette: true, quality: 100 }).toBuffer({ resolveWithObject: true });
    }
    if (output.data.byteLength > outputMaxBytes && !metadata.hasAlpha) {
      mimeType = "image/jpeg";
      for (const quality of [86, 78, 70, 62]) {
        output = await pipeline().jpeg({ quality }).toBuffer({ resolveWithObject: true });
        if (output.data.byteLength <= outputMaxBytes) break;
      }
    }
    while (output.data.byteLength > outputMaxBytes && resizeEdge > 1) {
      resizeEdge = Math.max(1, Math.floor(resizeEdge * Math.sqrt(outputMaxBytes / output.data.byteLength) * 0.95));
      output = mimeType === "image/jpeg"
        ? await pipeline().jpeg({ quality: 62 }).toBuffer({ resolveWithObject: true })
        : await pipeline().png({ palette: true, quality: 100 }).toBuffer({ resolveWithObject: true });
    }
    if (output.data.byteLength > outputMaxBytes) return null;
    return { data: output.data, mimeType, meta: {
      ...originalMeta, imageNormalized: true, imageFormat: output.info.format,
      normalizedSizeBytes: output.data.byteLength, normalizedWidth: output.info.width,
      normalizedHeight: output.info.height, normalizedMaxEdge: resizeEdge, normalizedMaxBytes: outputMaxBytes,
    } };
  } catch (error) {
    logger.warn(`[AgentImage] failed to normalize image source=${input.sourceKind} label=${input.label ?? "unknown"}:`, error);
    return null;
  }
}

export async function normalizeImageContentBlock(block: Extract<ContentBlock, { type: "image" }>, options: ImageNormalizationOptions = {}): Promise<ContentBlock> {
  const omitted = (reason: string, text: string): ContentBlock => ({ type: "text", text: imageOmittedText(text), _meta: {
    ...block._meta, imageUrlPassthrough: false, imageNormalizationFailed: true, reason,
    originalSource: block.source.type, ...(block.source.type === "url" ? { originalUrl: block.source.url } : {}),
  } });
  options.signal?.throwIfAborted();
  let image: { data: Buffer; mimeType: string } | null;
  if (block.source.type === "url") {
    if (validatedImages.has(block)) return block;
    image = await options.readUrlImage?.(block.source.url, options.signal).catch(() => {
      options.signal?.throwIfAborted();
      return null;
    }) ?? null;
    if (!image) return omitted("load_failed", "image could not be loaded");
  } else {
    const data = block.source.data.replace(BASE64_PREFIX_PATTERN, "");
    if (data.length > BASE64_INPUT_MAX_CHARS) return omitted("too_large", "image is too large to process");
    image = { data: Buffer.from(data, "base64"), mimeType: block.source.media_type };
  }
  options.signal?.throwIfAborted();
  const normalized = await normalizeAgentImage({
    ...image, sourceKind: block.source.type === "url" ? "public_asset" : "user_message",
    maxBytes: block.source.type === "url" ? AGENT_IMAGE_URL_PASSTHROUGH_MAX_BYTES : AGENT_IMAGE_MAX_OUTPUT_BYTES,
    originalSource: block.source.type, ...(block.source.type === "url" ? { originalUrl: block.source.url } : {}),
  });
  options.signal?.throwIfAborted();
  if (!normalized) return omitted("decode_failed", "image could not be processed");
  let url: string;
  if (block.source.type === "url" && normalized.data === image.data) {
    url = block.source.url;
  } else {
    try {
      url = await writeImage(normalized, options);
    } catch (error) {
      options.signal?.throwIfAborted();
      logger.warn("[AgentImage] failed to upload image:", error);
      return omitted("upload_failed", "image could not be uploaded");
    }
  }
  options.signal?.throwIfAborted();
  const result: ContentBlock = { type: "image", source: { type: "url", url }, _meta: { ...block._meta, ...normalized.meta, imageUrlPassthrough: true } };
  validatedImages.add(result);
  return result;
}

async function mapWithConcurrency<Item, Result>(items: Item[], concurrency: number, mapper: (item: Item) => Promise<Result>): Promise<Result[]> {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const itemIndex = nextIndex++;
      const item = items[itemIndex];
      if (item === undefined) return;
      results[itemIndex] = await mapper(item);
    }
  }));
  return results;
}

export async function normalizeContentBlocksImages(content: ContentBlock[], options?: ImageNormalizationOptions): Promise<ContentBlock[]> {
  return mapWithConcurrency(content, IMAGE_NORMALIZE_CONCURRENCY, (block) => {
    if (block.type === "image") return normalizeImageContentBlock(block, options);
    if (block.type === "tool_result" && Array.isArray(block.content)) {
      return normalizeContentBlocksImages(block.content, options).then((content) => ({ ...block, content }));
    }
    return Promise.resolve(block);
  });
}

export async function normalizeAgentToolImageContent(input: { data: Buffer; mimeType: string; label?: string }, options: ImageNormalizationOptions = {}): Promise<ImageContent | { type: "text"; text: string }> {
  options.signal?.throwIfAborted();
  const normalized = await normalizeAgentImage({ ...input, sourceKind: "tool_result", originalSource: "file" });
  options.signal?.throwIfAborted();
  if (!normalized) return { type: "text", text: imageOmittedText("image could not be processed", input.label) };
  try {
    const url = await writeImage(normalized, options);
    options.signal?.throwIfAborted();
    return contentBlockToPiImage({ type: "image", source: { type: "url", url } }) ?? { type: "text", text: imageOmittedText("image could not be loaded", input.label) };
  } catch (error) {
    options.signal?.throwIfAborted();
    logger.warn("[AgentImage] failed to upload tool image:", error);
    return { type: "text", text: imageOmittedText("image could not be uploaded", input.label) };
  }
}
