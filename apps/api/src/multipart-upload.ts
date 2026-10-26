import { createHash, randomUUID } from "node:crypto";
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, HeadObjectCommand, ListPartsCommand, S3Client } from "@aws-sdk/client-s3";
import { UPLOAD_MAX_FILE_BYTES, UPLOAD_MULTIPART_PART_BYTES, type MultipartUploadCompletedPart, type MultipartUploadPlan, type UploadStrategy } from "@cohub/protocol";
import { createPresignedUploadPartUrl } from "./object-presign.js";
import { requirePublicAssetOssStorage } from "./public-file-storage.js";
import { redisCommandClient } from "./redis.js";
import { requireUserUploadStorage, type UserUploadBucket } from "./user-upload-storage.js";

const LEGACY_MULTIPART_PART_BYTES = 16 * 1024 * 1024;
const MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
const UPLOAD_TTL_SECONDS = 24 * 60 * 60;
type StorageKind = UserUploadBucket | "public_asset";
type UploadAccess = { spaceId: string; permission: "file.edit" | "space.edit" | "app.manage" } | { spaceId: string; sessionId?: string; permission: "session_image" };
export type MultipartUploadRecord = {
  uploadId: string;
  providerUploadId: string;
  userId: string;
  storageKind: StorageKind;
  objectKey: string;
  size: number;
  partSize?: number;
  access?: UploadAccess;
  internalEndpoint?: boolean;
  forbidOverwrite: boolean;
  expiresAt: string;
  state: "uploading" | "completed" | "aborted";
};

export class MultipartUploadError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 | 503 = 400) { super(message); }
}

export function normalizeUploadStrategy(input: { uploadProtocol?: unknown; upload?: unknown }): UploadStrategy {
  const protocol = input.uploadProtocol;
  if (protocol !== undefined && protocol !== "presigned_put_v1" && protocol !== "multipart_v1") {
    throw new MultipartUploadError("unsupported upload protocol");
  }
  const options = input.upload;
  if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options)
    || Object.keys(options).some((key) => !["multipart", "multipartThresholdBytes", "partSizeBytes"].includes(key)))) {
    throw new MultipartUploadError("invalid upload configuration");
  }
  const supplied = (options ?? {}) as Partial<UploadStrategy>;
  const multipart = supplied.multipart === undefined
    ? (protocol === "presigned_put_v1" || (protocol === undefined && options === undefined) ? "never" : "auto")
    : supplied.multipart;
  if (multipart !== "auto" && multipart !== "always" && multipart !== "never") {
    throw new MultipartUploadError("upload multipart must be auto, always, or never");
  }
  if ((protocol === "presigned_put_v1" && multipart !== "never") || (protocol === "multipart_v1" && multipart === "never")) {
    throw new MultipartUploadError("upload configuration conflicts with upload protocol");
  }
  const multipartThresholdBytes = supplied.multipartThresholdBytes === undefined ? UPLOAD_MULTIPART_PART_BYTES : supplied.multipartThresholdBytes;
  const partSizeBytes = supplied.partSizeBytes === undefined ? UPLOAD_MULTIPART_PART_BYTES : supplied.partSizeBytes;
  if (!Number.isSafeInteger(multipartThresholdBytes) || multipartThresholdBytes < 0) {
    throw new MultipartUploadError("upload multipartThresholdBytes must be a nonnegative safe integer");
  }
  if (!Number.isSafeInteger(partSizeBytes) || partSizeBytes < MIN_MULTIPART_PART_BYTES || partSizeBytes > UPLOAD_MAX_FILE_BYTES) {
    throw new MultipartUploadError(`upload partSizeBytes must be an integer between ${MIN_MULTIPART_PART_BYTES} and ${UPLOAD_MAX_FILE_BYTES}`);
  }
  return { multipart, multipartThresholdBytes, partSizeBytes };
}

export const shouldUseMultipartUpload = (size: number, strategy: UploadStrategy) =>
  size > 0 && (strategy.multipart === "always" || (strategy.multipart === "auto" && size > strategy.multipartThresholdBytes));

const recordKey = (id: string) => `upload:multipart:${id}`;
const storageFor = (kind: StorageKind) => kind === "public_asset" ? requirePublicAssetOssStorage() : requireUserUploadStorage(kind);
const clients = new Map<StorageKind, S3Client>();
const clientFor = (kind: StorageKind) => {
  let client = clients.get(kind);
  if (!client) {
    const storage = storageFor(kind);
    client = new S3Client({
      endpoint: storage.endpoint,
      region: storage.region,
      forcePathStyle: false,
      maxAttempts: 2,
      requestHandler: { requestTimeout: 30_000, connectionTimeout: 5_000 },
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
      credentials: { accessKeyId: storage.accessKeyId, secretAccessKey: storage.secretAccessKey },
    });
    clients.set(kind, client);
  }
  return client;
};

const saveRecord = async (record: MultipartUploadRecord) => {
  const ttl = Math.ceil((Date.parse(record.expiresAt) - Date.now()) / 1000);
  if (ttl <= 0) throw new MultipartUploadError("upload has expired", 404);
  await redisCommandClient.set(recordKey(record.uploadId), JSON.stringify(record), "EX", ttl);
};

export const getMultipartUpload = async (id: string) => {
  const raw = await redisCommandClient.get(recordKey(id));
  return raw ? JSON.parse(raw) as MultipartUploadRecord : null;
};

export function multipartUploadPlan(record: MultipartUploadRecord): MultipartUploadPlan {
  if (record.state === "aborted") throw new MultipartUploadError("upload was cancelled", 409);
  const storage = storageFor(record.storageKind);
  const partSize = record.partSize ?? LEGACY_MULTIPART_PART_BYTES;
  const parts = Array.from({ length: Math.ceil(record.size / partSize) }, (_, index) => {
    const signed = createPresignedUploadPartUrl(
      record.internalEndpoint ? { ...storage, publicEndpoint: storage.endpoint } : storage,
      record.objectKey, record.providerUploadId, index + 1,
      Math.min(partSize, record.size - index * partSize),
    );
    return { partNumber: index + 1, uploadUrl: signed.uploadUrl, headers: signed.headers };
  });
  return { uploadId: record.uploadId, partSize, parts,
    expiresAt: new Date(Math.min(Date.now() + 60 * 60 * 1000, Date.parse(record.expiresAt))).toISOString() };
}

export async function createMultipartUpload(input: {
  userId: string;
  storageKind: StorageKind;
  objectKey: string;
  size: number;
  partSize: number;
  headers?: Record<string, string>;
  access?: UploadAccess;
  internalEndpoint?: boolean;
  forbidOverwrite?: boolean;
}): Promise<MultipartUploadPlan> {
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > UPLOAD_MAX_FILE_BYTES
    || !Number.isSafeInteger(input.partSize) || input.partSize < MIN_MULTIPART_PART_BYTES || input.partSize > UPLOAD_MAX_FILE_BYTES
    || Math.ceil(input.size / input.partSize) > 10_000) {
    throw new MultipartUploadError("invalid multipart file or part size");
  }
  const uploadId = randomUUID();
  const storage = storageFor(input.storageKind);
  const headers = input.headers ?? {};
  const result = await clientFor(input.storageKind).send(new CreateMultipartUploadCommand({
    Bucket: storage.bucket,
    Key: input.objectKey,
    ContentType: headers["content-type"],
    CacheControl: headers["cache-control"],
    ContentDisposition: headers["content-disposition"],
    Metadata: {
      ...Object.fromEntries(Object.entries(headers).filter(([key]) => key.startsWith("x-amz-meta-")).map(([key, value]) => [key.slice(11), value])),
      "cohub-upload-id": uploadId,
    },
  }));
  if (!result.UploadId) throw new Error("storage did not return an upload id");
  const record: MultipartUploadRecord = {
    uploadId, providerUploadId: result.UploadId, userId: input.userId, storageKind: input.storageKind,
    objectKey: input.objectKey, size: input.size, partSize: input.partSize, access: input.access, internalEndpoint: input.internalEndpoint,
    forbidOverwrite: input.forbidOverwrite ?? false, state: "uploading",
    expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000).toISOString(),
  };
  try {
    await saveRecord(record);
    return multipartUploadPlan(record);
  } catch (error) {
    await clientFor(record.storageKind).send(new AbortMultipartUploadCommand({ Bucket: storage.bucket, Key: record.objectKey, UploadId: record.providerUploadId })).catch(() => {});
    throw error;
  }
}

const missingUpload = (error: unknown) => error instanceof Error && (error.name === "NoSuchUpload" || error.name === "NotFound" || error.name === "NoSuchKey");
const normalizedEtag = (etag: string) => etag.replace(/^"|"$/g, "");

const alreadyCompleted = async (record: MultipartUploadRecord) => {
  try {
    const head = await clientFor(record.storageKind).send(new HeadObjectCommand({ Bucket: storageFor(record.storageKind).bucket, Key: record.objectKey }));
    return head.Metadata?.["cohub-upload-id"] === record.uploadId && head.ContentLength === record.size;
  } catch (error) {
    if (missingUpload(error)) return false;
    throw error;
  }
};

export async function completeMultipartUpload(record: MultipartUploadRecord, parts: MultipartUploadCompletedPart[]) {
  if (record.state === "aborted") throw new MultipartUploadError("upload was cancelled", 409);
  if (record.state === "completed") return;
  const partSize = record.partSize ?? LEGACY_MULTIPART_PART_BYTES;
  const expectedCount = Math.ceil(record.size / partSize);
  if (!Array.isArray(parts) || parts.length !== expectedCount || parts.some((part, index) =>
    !part || part.partNumber !== index + 1 || typeof part.etag !== "string" || !part.etag.length || part.etag.length > 256)) {
    throw new MultipartUploadError("invalid upload parts");
  }
  const storage = storageFor(record.storageKind);
  const client = clientFor(record.storageKind);
  const object = { Bucket: storage.bucket, Key: record.objectKey, UploadId: record.providerUploadId };
  if (!(await alreadyCompleted(record))) {
    try {
      const listed = await client.send(new ListPartsCommand({ ...object, MaxParts: expectedCount + 1 }));
      if (listed.IsTruncated || listed.Parts?.length !== expectedCount || listed.Parts.some((part, index) =>
        part.PartNumber !== index + 1 || part.Size !== Math.min(partSize, record.size - index * partSize)
        || normalizedEtag(part.ETag ?? "") !== normalizedEtag(parts[index]?.etag ?? ""))) {
        throw new MultipartUploadError("uploaded parts do not match the expected file");
      }
      const command = new CompleteMultipartUploadCommand({
        ...object,
        MultipartUpload: { Parts: parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })) },
        ...(record.forbidOverwrite && !storage.endpoint.includes("aliyuncs.com") ? { IfNoneMatch: "*" } : {}),
      });
      if (record.forbidOverwrite && storage.endpoint.includes("aliyuncs.com")) {
        command.middlewareStack.add((next) => async (args) => {
          (args.request as { headers: Record<string, string> }).headers["x-oss-forbid-overwrite"] = "true";
          return next(args);
        }, { step: "build", name: "forbidOverwrite" });
      }
      await client.send(command);
    } catch (error) {
      if (!(await alreadyCompleted(record))) {
        if (error instanceof Error && ["PreconditionFailed", "FileAlreadyExists", "ConditionalRequestConflict"].includes(error.name)) {
          throw new MultipartUploadError("upload target already exists", 409);
        }
        throw error;
      }
    }
  }
  record.state = "completed";
  await saveRecord(record);
}

export async function abortMultipartUpload(record: MultipartUploadRecord) {
  if (record.state !== "uploading") return;
  try {
    await clientFor(record.storageKind).send(new AbortMultipartUploadCommand({
      Bucket: storageFor(record.storageKind).bucket, Key: record.objectKey, UploadId: record.providerUploadId,
    }));
  } catch (error) { if (!missingUpload(error)) throw error; }
  record.state = "aborted";
  await saveRecord(record);
}

export async function withUploadLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const token = randomUUID();
  if (await redisCommandClient.set(key, token, "EX", 120, "NX") !== "OK") {
    throw new MultipartUploadError("upload operation is in progress; retry shortly", 503);
  }
  let leaseValid = true;
  let renewing = false;
  const renewal = setInterval(async () => {
    if (renewing) return;
    renewing = true;
    try {
      const renewed = await redisCommandClient.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("EXPIRE", KEYS[1], 120) end return 0', 1, key, token);
      if (renewed !== 1) leaseValid = false;
    } catch { leaseValid = false; } finally { renewing = false; }
  }, 30_000);
  renewal.unref();
  try {
    const result = await action();
    if (!leaseValid) throw new MultipartUploadError("upload operation lease expired; retry shortly", 503);
    return result;
  } finally {
    clearInterval(renewal);
    await redisCommandClient.eval('if redis.call("GET", KEYS[1]) == ARGV[1] then return redis.call("DEL", KEYS[1]) end return 0', 1, key, token);
  }
}

export async function withUploadRequest<T>(userId: string, scope: string, body: { uploadRequestId?: string }, action: (quotaRequestId?: string) => Promise<T>): Promise<T> {
  const requestId = body.uploadRequestId;
  if (requestId == null) return action();
  if (typeof requestId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(requestId)) throw new MultipartUploadError("invalid upload request id");
  const key = `upload:request:${userId}:${scope}:${requestId}`;
  const fingerprint = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return withUploadLock(`${key}:lock`, async () => {
    const raw = await redisCommandClient.get(key);
    const state = raw ? JSON.parse(raw) as { fingerprint: string; result?: T } : null;
    if (state && state.fingerprint !== fingerprint) throw new MultipartUploadError("upload request id was reused", 409);
    if (state?.result !== undefined) return state.result;
    await redisCommandClient.set(key, JSON.stringify({ fingerprint }), "EX", UPLOAD_TTL_SECONDS);
    const result = await action(key);
    await redisCommandClient.set(key, JSON.stringify({ fingerprint, result }), "EX", UPLOAD_TTL_SECONDS);
    return result;
  });
}
