import { config } from "./config.js";
import {
  createPresignedGetObjectUrl,
  createPresignedPutObjectUrl,
  type PresignStorageConfig,
} from "./object-presign.js";

export type UserUploadBucket = "chat_attachment" | "app_source" | "space_upload";

export class UserUploadConfigError extends Error {
  override name = "UserUploadConfigError";
}

export const requireUserUploadStorage = (kind: UserUploadBucket): PresignStorageConfig & {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
} => {
  const bucket = kind === "chat_attachment" || kind === "app_source"
    ? config.chatAttachmentS3Bucket
    : config.spaceUploadS3Bucket;
  if (!bucket) {
    const name = kind === "chat_attachment" || kind === "app_source" ? "CHAT_ATTACHMENT_S3_BUCKET" : "SPACE_UPLOAD_S3_BUCKET";
    throw new UserUploadConfigError(`${name} is required`);
  }
  if (!config.userUploadS3Endpoint) {
    throw new UserUploadConfigError("USER_UPLOAD_S3_ENDPOINT is required");
  }
  if (!config.userUploadS3AccessKeyId || !config.userUploadS3SecretAccessKey) {
    throw new UserUploadConfigError(
      "USER_UPLOAD_S3_ACCESS_KEY_ID and USER_UPLOAD_S3_SECRET_ACCESS_KEY are required",
    );
  }
  return {
    endpoint: config.userUploadS3Endpoint,
    publicEndpoint: config.userUploadS3Endpoint,
    region: config.userUploadS3Region,
    bucket,
    accessKeyId: config.userUploadS3AccessKeyId,
    secretAccessKey: config.userUploadS3SecretAccessKey,
    includeUnsignedPayloadQuery: true,
  };
};

export const createUserUploadPutUrl = (input: {
  kind: UserUploadBucket;
  objectKey: string;
  contentType?: string | null;
  cacheControl?: string | null;
  contentDisposition?: string | null;
  contentLength?: number;
}) => createPresignedPutObjectUrl(
  requireUserUploadStorage(input.kind),
  input.objectKey,
  input.contentType,
  input.cacheControl,
  input.contentDisposition,
  input.contentLength == null ? undefined : { contentLength: input.contentLength },
);

export const createUserUploadGetUrl = (kind: UserUploadBucket, objectKey: string) =>
  createPresignedGetObjectUrl(requireUserUploadStorage(kind), objectKey);

export const buildChatAttachmentPublicUrl = (objectKey: string) => {
  if (!config.chatAttachmentPublicBaseUrl) {
    throw new UserUploadConfigError("CHAT_ATTACHMENT_PUBLIC_BASE_URL is required");
  }
  const path = objectKey.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `${config.chatAttachmentPublicBaseUrl}/${path}`;
};
