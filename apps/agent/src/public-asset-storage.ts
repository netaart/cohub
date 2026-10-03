import { AGENT_IMAGE_MAX_INPUT_BYTES } from "./image-normalizer.js";
import { env } from "./env.js";

const RELAXED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/tiff",
  "application/octet-stream",
]);

const decodeObjectKeyPath = (value: string) => {
  try {
    return value
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part))
      .join("/");
  } catch {
    return null;
  }
};

const objectKeyFromBaseUrl = (url: URL, baseValue: string | undefined) => {
  if (!baseValue) return null;
  let base: URL;
  try {
    base = new URL(baseValue);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" || url.origin !== base.origin) return null;
  const basePath = base.pathname.replace(/\/+$/, "");
  if (basePath && !url.pathname.startsWith(`${basePath}/`)) return null;
  const keyPath = basePath ? url.pathname.slice(basePath.length + 1) : url.pathname.replace(/^\/+/, "");
  return decodeObjectKeyPath(keyPath);
};

const isChatAttachmentObjectKey = (objectKey: string) => {
  const prefix = env.ENV === "prod" ? "chat-attachments/" : `${env.ENV}/chat-attachments/`;
  return objectKey.startsWith(prefix);
};

const trustedPublicAssetBases = () => [
  env.PUBLIC_ASSET_CDN_BASE_URL,
  env.CHAT_ATTACHMENT_PUBLIC_BASE_URL,
];

export const publicAssetObjectKeyFromUrl = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  for (const baseUrl of trustedPublicAssetBases()) {
    const objectKey = objectKeyFromBaseUrl(url, baseUrl);
    if (objectKey && isChatAttachmentObjectKey(objectKey)) return objectKey;
  }
  return null;
};

const bodyToBuffer = async (body: unknown, maxBytes: number) => {
  if (!body) return null;
  const chunks: Buffer[] = [];
  let size = 0;

  if (Symbol.asyncIterator in Object(body)) {
    for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > maxBytes) return null;
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, size);
  }

  if (typeof (body as { transformToByteArray?: unknown }).transformToByteArray === "function") {
    const bytes = await (body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray();
    if (bytes.byteLength > maxBytes) return null;
    return Buffer.from(bytes);
  }

  return null;
};

export async function readPublicAssetImageUrl(value: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!publicAssetObjectKeyFromUrl(value)) return null;

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), env.PUBLIC_ASSET_DOWNLOAD_TIMEOUT_MS);
  let response: Response | undefined;
  try {
    response = await fetch(value, {
      method: "GET",
      redirect: "manual",
      signal: signal ? AbortSignal.any([signal, abortController.signal]) : abortController.signal,
    });
    if (!response.ok || response.status !== 200) return null;
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > AGENT_IMAGE_MAX_INPUT_BYTES) return null;
    const mimeType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
      ?? "application/octet-stream";
    if (!RELAXED_IMAGE_MIME_TYPES.has(mimeType) && !mimeType.startsWith("image/")) return null;
    const data = await bodyToBuffer(response.body, AGENT_IMAGE_MAX_INPUT_BYTES);
    return data ? { data, mimeType } : null;
  } finally {
    clearTimeout(timeout);
    await response?.body?.cancel().catch(() => undefined);
  }
}
