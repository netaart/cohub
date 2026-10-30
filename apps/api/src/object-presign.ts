import { createHash, createHmac, randomUUID } from "node:crypto";

export type PresignStorageConfig = {
  endpoint?: string;
  publicEndpoint?: string;
  region: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  includeUnsignedPayloadQuery?: boolean;
};

const PRESIGN_TTL_SECONDS = 60 * 60;

const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest();
const hexHmac = (key: Buffer | string, value: string) => createHmac("sha256", key).update(value).digest("hex");
const toAmzDate = (date: Date) => date.toISOString().replace(/[:-]|\.\d{3}/g, "");
const toDateStamp = (date: Date) => toAmzDate(date).slice(0, 8);
const encodePath = (value: string) => value.split("/").map(encodeURIComponent).join("/");
const canonicalHeaderValue = (value: string) => value.trim().replace(/\s+/g, " ");

const signingKey = (secret: string, dateStamp: string, region: string) => {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, "s3");
  return hmac(kService, "aws4_request");
};

export const getBucketPublicEndpoint = (storage: PresignStorageConfig) => {
  if (!storage.bucket) throw new Error("bucket is required");
  const endpoint = storage.publicEndpoint ?? storage.endpoint?.replace("-internal.", ".");
  if (!endpoint) throw new Error("endpoint is required");
  const parsed = new URL(endpoint.replace(/\/+$/, ""));
  if (!parsed.hostname.startsWith(`${storage.bucket}.`)) {
    parsed.hostname = `${storage.bucket}.${parsed.hostname}`;
  }
  return parsed.toString().replace(/\/+$/, "");
};

type PutConditions = {
  contentLength?: number;
  forbidOverwrite?: boolean;
  contentMd5?: string;
  metadata?: Record<string, string>;
};

const createPresignedObjectUrl = (
  method: "GET" | "PUT",
  storage: PresignStorageConfig,
  objectKey: string,
  contentType?: string | null,
  cacheControl?: string | null,
  contentDisposition?: string | null,
  putConditions?: PutConditions,
) => {
  if (!storage.bucket) throw new Error("bucket is required");
  if (!storage.endpoint) throw new Error("endpoint is required");
  if (!storage.accessKeyId || !storage.secretAccessKey) {
    throw new Error("access key id and secret access key are required");
  }

  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = toDateStamp(now);
  const credentialScope = `${dateStamp}/${storage.region}/s3/aws4_request`;
  const endpoint = getBucketPublicEndpoint(storage);
  const url = new URL(`${endpoint}/${encodePath(objectKey)}`);
  const headers = {
    host: url.host,
    ...(method === "PUT" && contentType ? { "content-type": contentType } : {}),
    ...(method === "PUT" && cacheControl ? { "cache-control": cacheControl } : {}),
    ...(method === "PUT" && contentDisposition ? { "content-disposition": contentDisposition } : {}),
    ...(method === "PUT" && putConditions?.contentLength != null
      ? { "content-length": String(putConditions.contentLength) }
      : {}),
    ...(method === "PUT" && putConditions?.forbidOverwrite ? (storage.endpoint?.includes("aliyuncs.com") ? { "x-oss-forbid-overwrite": "true" } : { "if-none-match": "*" }) : {}),
    ...(method === "PUT" && putConditions?.contentMd5 ? { "content-md5": putConditions.contentMd5 } : {}),
    ...(method === "PUT" ? Object.fromEntries(Object.entries(putConditions?.metadata ?? {}).map(([key, value]) => [`x-amz-meta-${key}`, value])) : {}),
  };
  const signedHeaders = Object.keys(headers).sort().join(";");
  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  if (storage.includeUnsignedPayloadQuery) {
    url.searchParams.set("X-Amz-Content-Sha256", "UNSIGNED-PAYLOAD");
  }
  url.searchParams.set("X-Amz-Credential", `${storage.accessKeyId}/${credentialScope}`);
  url.searchParams.set("X-Amz-Date", amzDate);
  url.searchParams.set("X-Amz-Expires", String(PRESIGN_TTL_SECONDS));
  url.searchParams.set("X-Amz-SignedHeaders", signedHeaders);

  const canonicalQuery = Array.from(url.searchParams.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  const canonicalHeaders = Object.entries(headers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}:${canonicalHeaderValue(value)}\n`)
    .join("");
  const canonicalRequest = [
    method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hexHmac(signingKey(storage.secretAccessKey, dateStamp, storage.region), stringToSign);
  url.searchParams.set("X-Amz-Signature", signature);

  const uploadHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "host"));
  return {
    url: url.toString(),
    expiresAt: new Date(now.getTime() + PRESIGN_TTL_SECONDS * 1000).toISOString(),
    headers: method === "PUT" && Object.keys(uploadHeaders).length > 0 ? uploadHeaders : undefined,
  };
};

export const createPresignedPutObjectUrl = (
  storage: PresignStorageConfig,
  objectKey: string,
  contentType?: string | null,
  cacheControl?: string | null,
  contentDisposition?: string | null,
  conditions?: PutConditions,
) => {
  const signed = createPresignedObjectUrl(
    "PUT",
    storage,
    objectKey,
    contentType,
    cacheControl,
    contentDisposition,
    conditions,
  );
  return { uploadUrl: signed.url, expiresAt: signed.expiresAt, headers: signed.headers };
};

export const createPresignedGetObjectUrl = (
  storage: PresignStorageConfig,
  objectKey: string,
) => {
  const signed = createPresignedObjectUrl("GET", storage, objectKey);
  return { downloadUrl: signed.url, expiresAt: signed.expiresAt };
};

export const buildPublicObjectUrl = (storage: PresignStorageConfig, objectKey: string) =>
  `${getBucketPublicEndpoint(storage)}/${encodePath(objectKey)}`;

export const cacheBuster = () => randomUUID().replaceAll("-", "").slice(0, 12);
