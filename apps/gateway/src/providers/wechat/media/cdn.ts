import { createLogger } from "@cohub/infra/logging";
import {
  responseToTempMediaFile,
  tempMediaBlob,
  transformTempMediaFile,
  type TempMediaFile,
} from "../../../media/temp-media-file.js";
import {
  aesEcbPaddedSize,
  createAesEcbDecryptStream,
  createAesEcbEncryptStream,
  decryptAesEcb,
  encryptAesEcb,
  parseWeChatAesKey,
} from "./crypto.js";
import { allowedHostFromBaseUrl, safeFetch } from "@cohub/infra/safe-fetch";

const logger = createLogger({ serviceName: "cohub-gateway" });
const CDN_MAX_RETRIES = 3;
const LARGE_MEDIA_TIMEOUT_MS = 10 * 60 * 1000;

const buildDownloadUrl = (cdnBaseUrl: string, encryptedQueryParam: string) =>
  `${cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;

const buildUploadUrl = (cdnBaseUrl: string, uploadParam: string, filekey: string) =>
  `${cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

async function fetchBytes(url: string, label: string, maxBytes: number | undefined, allowedHosts: string[]) {
  const response = await safeFetch({ url, label, allowedHosts });
  if (!response.ok) throw new Error(`${label}: CDN download failed ${response.status}`);

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (maxBytes && contentLength > maxBytes) throw new Error(`${label}: CDN response exceeds ${maxBytes} bytes`);

  const buffer = Buffer.from(await response.arrayBuffer());
  if (maxBytes && buffer.length > maxBytes) throw new Error(`${label}: CDN response exceeds ${maxBytes} bytes`);
  return buffer;
}

export async function downloadWeChatCdnImage(params: {
  cdnBaseUrl: string;
  encryptedQueryParam?: string;
  fullUrl?: string;
  aesKeyBase64?: string;
  maxBytes: number;
  label: string;
}) {
  const url = params.fullUrl?.trim() || (params.encryptedQueryParam ? buildDownloadUrl(params.cdnBaseUrl, params.encryptedQueryParam) : "");
  if (!url) throw new Error(`${params.label}: CDN URL is missing`);

  const buffer = await fetchBytes(url, params.label, params.maxBytes, [allowedHostFromBaseUrl(params.cdnBaseUrl)]);
  if (!params.aesKeyBase64) return buffer;

  const key = parseWeChatAesKey(params.aesKeyBase64, params.label);
  return decryptAesEcb(buffer, key);
}

export async function downloadWeChatCdnFile(params: {
  cdnBaseUrl: string;
  encryptedQueryParam?: string;
  fullUrl?: string;
  aesKeyBase64?: string;
  maxBytes: number;
  label: string;
}): Promise<TempMediaFile> {
  const url = params.fullUrl?.trim() || (params.encryptedQueryParam ? buildDownloadUrl(params.cdnBaseUrl, params.encryptedQueryParam) : "");
  if (!url) throw new Error(`${params.label}: CDN URL is missing`);

  const response = await safeFetch({
    url,
    label: params.label,
    allowedHosts: [allowedHostFromBaseUrl(params.cdnBaseUrl)],
    timeoutMs: LARGE_MEDIA_TIMEOUT_MS,
  });
  if (!response.ok) throw new Error(`${params.label}: CDN download failed ${response.status}`);

  const downloadLimit = params.aesKeyBase64 ? aesEcbPaddedSize(params.maxBytes) : params.maxBytes;
  const encrypted = await responseToTempMediaFile(response, downloadLimit, params.label);
  if (!params.aesKeyBase64) return encrypted;

  try {
    const key = parseWeChatAesKey(params.aesKeyBase64, params.label);
    return await transformTempMediaFile(
      encrypted,
      createAesEcbDecryptStream(key),
      params.maxBytes,
      `${params.label}-decrypted`,
    );
  } finally {
    await encrypted.cleanup();
  }
}

export async function uploadWeChatCdnFile(params: {
  file: TempMediaFile;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  aesKey: Buffer;
  label: string;
}) {
  const url = params.uploadFullUrl?.trim() || (params.uploadParam ? buildUploadUrl(params.cdnBaseUrl, params.uploadParam, params.filekey) : "");
  if (!url) throw new Error(`${params.label}: CDN upload URL is missing`);

  const ciphertext = await transformTempMediaFile(
    params.file,
    createAesEcbEncryptStream(params.aesKey),
    aesEcbPaddedSize(params.file.size),
    `${params.label}-encrypted`,
  );
  try {
    const body = await tempMediaBlob(ciphertext);
    let lastError: unknown;
    for (let attempt = 1; attempt <= CDN_MAX_RETRIES; attempt += 1) {
      try {
        const response = await safeFetch({
          url,
          label: params.label,
          allowedHosts: [allowedHostFromBaseUrl(params.cdnBaseUrl)],
          timeoutMs: LARGE_MEDIA_TIMEOUT_MS,
          init: {
            method: "POST",
            headers: { "Content-Type": "application/octet-stream" },
            body,
          },
        });
        if (response.status >= 400 && response.status < 500) {
          throw new Error(`${params.label}: CDN upload client error ${response.status}: ${await response.text().catch(() => "")}`);
        }
        if (response.status !== 200) throw new Error(`${params.label}: CDN upload failed ${response.status}`);
        const downloadParam = response.headers.get("x-encrypted-param")?.trim();
        if (!downloadParam) throw new Error(`${params.label}: CDN upload response missing x-encrypted-param`);
        return { downloadParam, ciphertextSize: ciphertext.size };
      } catch (error) {
        lastError = error;
        if (error instanceof Error && error.message.includes("client error")) throw error;
        if (attempt < CDN_MAX_RETRIES) logger.warn(`[WeChat] ${params.label} upload retry ${attempt}`, error);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${params.label}: CDN upload failed`);
  } finally {
    await ciphertext.cleanup();
  }
}

export async function uploadWeChatCdnBuffer(params: {
  buffer: Buffer;
  uploadFullUrl?: string;
  uploadParam?: string;
  filekey: string;
  cdnBaseUrl: string;
  aesKey: Buffer;
  label: string;
}) {
  const url = params.uploadFullUrl?.trim() || (params.uploadParam ? buildUploadUrl(params.cdnBaseUrl, params.uploadParam, params.filekey) : "");
  if (!url) throw new Error(`${params.label}: CDN upload URL is missing`);

  const ciphertext = encryptAesEcb(params.buffer, params.aesKey);
  let lastError: unknown;
  for (let attempt = 1; attempt <= CDN_MAX_RETRIES; attempt += 1) {
    try {
      const response = await safeFetch({
        url,
        label: params.label,
        allowedHosts: [allowedHostFromBaseUrl(params.cdnBaseUrl)],
        init: {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: new Uint8Array(ciphertext),
        },
      });
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`${params.label}: CDN upload client error ${response.status}: ${await response.text().catch(() => "")}`);
      }
      if (response.status !== 200) throw new Error(`${params.label}: CDN upload failed ${response.status}`);
      const downloadParam = response.headers.get("x-encrypted-param")?.trim();
      if (!downloadParam) throw new Error(`${params.label}: CDN upload response missing x-encrypted-param`);
      return { downloadParam, ciphertextSize: ciphertext.length };
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.includes("client error")) throw error;
      if (attempt < CDN_MAX_RETRIES) logger.warn(`[WeChat] ${params.label} upload retry ${attempt}`, error);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`${params.label}: CDN upload failed`);
}
