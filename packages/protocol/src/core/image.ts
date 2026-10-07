import type { ContentBlock } from "./content.js";

export type ImageBlock = Extract<ContentBlock, { type: "image" }>;

export type PiImageContent = { type: "image"; data: string; mimeType: string };

/** Pi only models inline image bytes; remote images travel through it under this MIME type with the URL as `data`. */
export const IMAGE_URL_MIME_TYPE = "application/x-cohub-image-url";

export const IMAGE_UNAVAILABLE_TEXT = "[Image unavailable]";

export const imageUrlContent = (url: string): PiImageContent => ({ type: "image", data: url, mimeType: IMAGE_URL_MIME_TYPE });

export const isImageUrlContent = (value: unknown): value is PiImageContent => {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "image" && record.mimeType === IMAGE_URL_MIME_TYPE && typeof record.data === "string";
};

const DATA_URL_PATTERN = /^data:([^;,]*)((?:;[^;,]*)*);base64,/i;

export function parseBase64DataUrl(value: string): { mediaType: string | null; data: string } | null {
  const match = DATA_URL_PATTERN.exec(value.trimStart());
  if (!match) return null;
  return { mediaType: match[1]?.trim().toLowerCase() || null, data: value.trimStart().slice(match[0].length).trim() };
}

const stripDataUrlPrefix = (data: string) => parseBase64DataUrl(data)?.data ?? data.trim();

const IMAGE_SIGNATURES: Array<[string, (bytes: Uint8Array) => boolean]> = [
  ["image/png", (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ["image/jpeg", (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ["image/gif", (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46],
  ["image/webp", (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50],
];

export function sniffImageMimeType(bytes: Uint8Array): string | null {
  return IMAGE_SIGNATURES.find(([, matches]) => matches(bytes))?.[0] ?? null;
}

export function sniffBase64ImageMimeType(data: string): string | null {
  try {
    return sniffImageMimeType(Uint8Array.from(atob(stripDataUrlPrefix(data).slice(0, 16)), (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

export function imageBlockToPi(block: ImageBlock): PiImageContent | null {
  if (block.source.type === "url") {
    const url = block.source.url.trim();
    return url ? imageUrlContent(url) : null;
  }
  const data = stripDataUrlPrefix(block.source.data);
  if (!data) return null;
  const mimeType = block.source.media_type && block.source.media_type !== "application/octet-stream"
    ? block.source.media_type
    : sniffBase64ImageMimeType(data) ?? "application/octet-stream";
  return { type: "image", data, mimeType };
}
