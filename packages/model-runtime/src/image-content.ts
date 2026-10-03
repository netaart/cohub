import type { ContentBlock } from "@cohub/protocol/core";
import type { Api, ImageContent } from "@earendil-works/pi-ai";

/** Marker mime used to carry remote image URLs through pi-ai's base64-only image shape. */
export const URL_IMAGE_MIME = "application/x-cohub-image-url";
const URL_IMAGE_DATA_PREFIX = `data:${URL_IMAGE_MIME};base64,`;

/** True when pi-ai's base64-only image shape is standing in for a remote URL rather than bytes. */
export function isUrlMarkerImage(mimeType: string | null | undefined): boolean {
  return mimeType === URL_IMAGE_MIME;
}

/** APIs whose image payloads can carry a remote HTTP URL. Others require real image bytes. */
export function supportsRemoteImageUrls(api: Api): boolean {
  return [
    "anthropic-messages", "openai-completions", "openai-responses",
    "openai-codex-responses", "azure-openai-responses", "mistral-conversations",
  ].includes(api);
}

export function getRemoteImageUrl(image: ImageContent): string | null {
  return isUrlMarkerImage(image.mimeType) ? decodeImageUrlData(image.data) : null;
}

/** Encode a remote image URL into pi-ai's base64-only image shape. */
export function urlToPiImage(url: string): ImageContent {
  return {
    type: "image",
    mimeType: URL_IMAGE_MIME,
    data: Buffer.from(url, "utf8").toString("base64"),
  };
}

export function contentBlockToPiImage(block: Extract<ContentBlock, { type: "image" }>): ImageContent | null {
  if (block.source.type === "base64") {
    return {
      type: "image",
      data: block.source.data.replace(/^data:[^;,]+;base64,/, ""),
      mimeType: block.source.media_type || "application/octet-stream",
    };
  }
  const url = block.source.url.trim();
  if (!url) return null;
  return urlToPiImage(url);
}

function decodeImageUrlData(data: string): string | null {
  try {
    const url = Buffer.from(data, "base64").toString("utf8").trim();
    return url || null;
  } catch {
    return null;
  }
}

/** Restore marker images to provider-native remote URL payloads. */
export function restoreRemoteImageUrls(payload: unknown): unknown {
  if (Array.isArray(payload)) return payload.map((item) => restoreRemoteImageUrls(item));
  if (!payload || typeof payload !== "object") return payload;

  const prototype = Object.getPrototypeOf(payload);
  if (prototype !== Object.prototype && prototype !== null) return payload;

  const record = payload as Record<string, unknown>;
  if (record.type === "input_image" && typeof record.image_url === "string" && record.image_url.startsWith(URL_IMAGE_DATA_PREFIX)) {
    const url = decodeImageUrlData(record.image_url.slice(URL_IMAGE_DATA_PREFIX.length));
    if (url) return { ...record, image_url: url };
  }
  if (record.type === "image_url") {
    const imageUrl = record.image_url;
    if (typeof imageUrl === "string" && imageUrl.startsWith(URL_IMAGE_DATA_PREFIX)) {
      const url = decodeImageUrlData(imageUrl.slice(URL_IMAGE_DATA_PREFIX.length));
      if (url) return { ...record, image_url: { url } };
    }
    if (imageUrl && typeof imageUrl === "object" && !Array.isArray(imageUrl)) {
      const nested = imageUrl as Record<string, unknown>;
      if (typeof nested.url === "string" && nested.url.startsWith(URL_IMAGE_DATA_PREFIX)) {
        const url = decodeImageUrlData(nested.url.slice(URL_IMAGE_DATA_PREFIX.length));
        if (url) return { ...record, image_url: { ...nested, url } };
      }
    }
  }

  if (record.type === "image" && record.source && typeof record.source === "object" && !Array.isArray(record.source)) {
    const source = record.source as Record<string, unknown>;
    if (source.type === "base64" && source.media_type === URL_IMAGE_MIME && typeof source.data === "string") {
      const url = decodeImageUrlData(source.data);
      if (url) return { ...record, source: { type: "url", url } };
    }
  }

  if (typeof record.imageUrl === "string" && record.imageUrl.startsWith(URL_IMAGE_DATA_PREFIX)) {
    const url = decodeImageUrlData(record.imageUrl.slice(URL_IMAGE_DATA_PREFIX.length));
    if (url) return { ...record, imageUrl: url };
  }

  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [key, restoreRemoteImageUrls(value)]),
  );
}
