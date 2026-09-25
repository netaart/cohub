import { randomUUID } from "node:crypto";
import { AVATAR_MAX_FILE_BYTES, UPLOAD_MAX_FILE_BYTES } from "@cohub/protocol";
import { config } from "./config.js";
import {
  buildChatAttachmentPublicUrl,
  createUserUploadPutUrl,
} from "./user-upload-storage.js";

const IMMUTABLE_PUBLIC_CACHE_CONTROL = "public, max-age=31536000, immutable";

export const PUBLIC_ASSET_PURPOSES = [
  "user_avatar",
  "space_avatar",
  "chat_attachment",
  "app_source",
  "generation_input",
] as const;
export type PublicAssetPurpose = (typeof PUBLIC_ASSET_PURPOSES)[number];

export function isPublicAssetPurpose(value: unknown): value is PublicAssetPurpose {
  return PUBLIC_ASSET_PURPOSES.includes(value as PublicAssetPurpose);
}
export type PublicAssetUploadProtocol = "presigned_put_v1";

export type CreatePublicAssetUploadInput = {
  purpose: PublicAssetPurpose;
  uploadProtocol: PublicAssetUploadProtocol;
  spaceId?: string;
  sessionId?: string;
  file: {
    size: number;
    mimeType: string;
    /** Optional original name — used only for chat_attachment object key extension. */
    filename?: string;
  };
};

type PublicAssetUploadBase = {
  purpose: PublicAssetPurpose;
  objectKey: string;
  publicUrl: string;
  uploadUrl: string;
  uploadMethod: "PUT";
  uploadHeaders?: Record<string, string>;
};

export type CreatePublicAssetUploadResponse = {
  expiresAt: string;
  asset: PublicAssetUploadBase;
};

export type CreateInternalPublicAssetUploadResponse = {
  expiresAt: string;
  asset: PublicAssetUploadBase & {
    uploadMethod: "PUT";
    uploadHeaders?: Record<string, string>;
  };
};

const IMAGE_MIME_TYPES = new Set(["image/webp", "image/jpeg", "image/png", "image/gif"]);
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
};

/** Common mime → extension for chat attachments (fallback when filename has no ext). */
const CHAT_MIME_EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/csv": "csv",
  "text/html": "html",
  "text/css": "css",
  "text/javascript": "js",
  "application/javascript": "js",
  "application/json": "json",
  "application/xml": "xml",
  "application/zip": "zip",
  "application/gzip": "gz",
  "application/octet-stream": "bin",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/webm": "webm",
};


export class PublicAssetConfigError extends Error {
  override name = "PublicAssetConfigError";
}

export class PublicAssetValidationError extends Error {
  override name = "PublicAssetValidationError";
}

const envPrefix = () => (config.env === "prod" ? "" : `${config.env}/`);

const safeExtensionFromFilename = (filename: string | undefined) => {
  if (!filename) return null;
  const base = filename.split(/[/\\]/).pop()?.trim() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{1,16}$/.test(ext)) return null;
  return ext;
};

const extensionForChatAttachment = (input: { mimeType: string; filename?: string }) => {
  const fromName = safeExtensionFromFilename(input.filename);
  if (fromName) return fromName;
  const fromMime = CHAT_MIME_EXTENSIONS[input.mimeType.toLowerCase()];
  if (fromMime) return fromMime;
  return "bin";
};

/** Active web content must not be served as navigable public assets. */
const ACTIVE_PUBLIC_MIME_TYPES = new Set([
  "text/html",
  "application/xhtml+xml",
  "image/svg+xml",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "text/css",
]);

const normalizeChatMimeType = (mimeType: unknown) => {
  if (typeof mimeType !== "string") throw new PublicAssetValidationError("invalid mime type");
  const value = mimeType.trim().toLowerCase();
  if (!value || value.length > 255) throw new PublicAssetValidationError("invalid mime type");
  // Basic type/subtype check; allow +suffix (e.g. application/ld+json).
  if (!/^[a-z0-9!#$&\-^_.+]{1,127}\/[a-z0-9!#$&\-^_.+]{1,127}$/i.test(value)) {
    throw new PublicAssetValidationError("invalid mime type");
  }
  // Force non-executable content-type for active formats (still stored; not rendered inline).
  if (ACTIVE_PUBLIC_MIME_TYPES.has(value)) return "application/octet-stream";
  return value;
};

/** Generation inputs are media a provider fetches by URL; active types were already neutralized. */
const normalizeGenerationInputMimeType = (mimeType: unknown) => {
  const value = normalizeChatMimeType(mimeType);
  if (!/^(image|video|audio)\//.test(value)) {
    throw new PublicAssetValidationError("generation inputs must be image, video, or audio");
  }
  return value;
};

const normalizeUploadMimeType = (purpose: PublicAssetPurpose, mimeType: string) => {
  if (purpose === "chat_attachment") return normalizeChatMimeType(mimeType);
  if (purpose === "generation_input") return normalizeGenerationInputMimeType(mimeType);
  return mimeType;
};

const chatAttachmentContentDisposition = (filename?: string) => {
  const raw = (filename ?? "attachment").split(/[/\\]/).pop()?.trim() || "attachment";
  const safe = raw.replace(/[\r\n"]/g, "_").slice(0, 180) || "attachment";
  const fallback = safe.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(safe).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
};

export const buildPublicAssetObjectKey = (input: {
  purpose: PublicAssetPurpose;
  userUuid: string;
  mimeType: string;
  spaceId?: string;
  sessionId?: string;
  filename?: string;
}) => {
  if (input.purpose === "user_avatar" || input.purpose === "space_avatar") {
    const extension = IMAGE_EXTENSIONS[input.mimeType];
    if (!extension) throw new PublicAssetValidationError("avatar images must be WebP, JPEG, PNG, or GIF");
    const assetId = randomUUID();
    if (input.purpose === "user_avatar") {
      return `${envPrefix()}avatars/users/${input.userUuid}/${assetId}.${extension}`;
    }
    if (!input.spaceId) throw new PublicAssetValidationError("spaceId is required for space avatar uploads");
    return `${envPrefix()}avatars/spaces/${input.spaceId}/${assetId}.${extension}`;
  }
  if (input.purpose === "app_source") {
    if (!input.sessionId) throw new PublicAssetValidationError("sessionId is required for app source uploads");
    return `${envPrefix()}app-sources/${input.userUuid}/${input.sessionId}/${randomUUID()}`;
  }
  // Chat attachments and generation inputs are user-scoped; spaceId/sessionId
  // are optional association only.
  const extension = extensionForChatAttachment({
    mimeType: input.mimeType,
    filename: input.filename,
  });
  const folder = input.purpose === "generation_input" ? "generation-inputs" : "chat-attachments";
  return `${envPrefix()}${folder}/${input.userUuid}/${randomUUID()}.${extension}`;
};

const tryParseOrigin = (value: string | undefined) => {
  if (!value) return null;
  try {
    return new URL(value.replace(/\/+$/, "")).origin;
  } catch {
    return null;
  }
};

/** Trusted legacy and current origins clients may pass as durable chat download URLs. */
export const listPublicAssetClientOrigins = () => {
  const origins = new Set<string>();
  const legacyCdn = tryParseOrigin(config.publicAssetCdnBaseUrl);
  if (legacyCdn) origins.add(legacyCdn);
  const chatCdn = tryParseOrigin(config.chatAttachmentPublicBaseUrl);
  if (chatCdn) origins.add(chatCdn);
  if (config.publicAssetOssBucket) {
    const publicEndpoint =
      config.publicAssetOssPublicEndpoint ??
      config.publicAssetOssEndpoint?.replace("-internal.", ".");
    if (publicEndpoint) {
      try {
        const parsed = new URL(publicEndpoint.replace(/\/+$/, ""));
        if (!parsed.hostname.startsWith(`${config.publicAssetOssBucket}.`)) {
          parsed.hostname = `${config.publicAssetOssBucket}.${parsed.hostname}`;
        }
        origins.add(parsed.origin);
      } catch {
        // ignore invalid config
      }
    }
  }
  return origins;
};

export const isAllowedPublicAssetDownloadUrl = (value: string) => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  const origins = listPublicAssetClientOrigins();
  return origins.size > 0 && origins.has(url.origin);
};

export const assertPublicAssetUploadFile = (input: {
  purpose: PublicAssetPurpose;
  file: CreatePublicAssetUploadInput["file"];
}) => {
  const { file } = input;
  if (!file || typeof file !== "object") throw new PublicAssetValidationError("file is required");
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new PublicAssetValidationError("invalid file size");

  if (input.purpose === "chat_attachment" || input.purpose === "app_source" || input.purpose === "generation_input") {
    normalizeUploadMimeType(input.purpose, file.mimeType);
    if (file.filename != null && (typeof file.filename !== "string" || file.filename.length > 255)) {
      throw new PublicAssetValidationError("invalid filename");
    }
    if (file.size > UPLOAD_MAX_FILE_BYTES) {
      throw new PublicAssetValidationError(`${input.purpose === "generation_input" ? "generation input" : "chat attachment"} is too large`);
    }
    return;
  }

  if (!IMAGE_MIME_TYPES.has(file.mimeType)) {
    throw new PublicAssetValidationError("avatar images must be WebP, JPEG, PNG, or GIF");
  }
  if (file.size > AVATAR_MAX_FILE_BYTES) throw new PublicAssetValidationError("avatar image is too large");
};

/**
 * Attachments download under their name. Avatars and generation inputs are
 * served inline: they render as images and providers fetch inputs by URL; the
 * input's extension still comes from its filename via the object key.
 */
const servesAsAttachment = (purpose: PublicAssetPurpose) =>
  purpose === "chat_attachment" || purpose === "app_source";

type PublicAssetPlanInput = {
  purpose: PublicAssetPurpose;
  userUuid: string;
  spaceId?: string;
  sessionId?: string;
  file: CreatePublicAssetUploadInput["file"];
};

const createPutPlan = (input: PublicAssetPlanInput): CreateInternalPublicAssetUploadResponse => {
  assertPublicAssetUploadFile({ purpose: input.purpose, file: input.file });
  const mimeType = normalizeUploadMimeType(input.purpose, input.file.mimeType);
  const objectKey = buildPublicAssetObjectKey({
    purpose: input.purpose,
    userUuid: input.userUuid,
    spaceId: input.spaceId,
    sessionId: input.sessionId,
    mimeType,
    filename: input.file.filename,
  });
  const signed = createUserUploadPutUrl({
    kind: "chat_attachment",
    objectKey,
    contentType: mimeType,
    cacheControl: IMMUTABLE_PUBLIC_CACHE_CONTROL,
    ...(servesAsAttachment(input.purpose)
      ? { contentDisposition: chatAttachmentContentDisposition(input.file.filename) }
      : {}),
  });
  return {
    expiresAt: signed.expiresAt,
    asset: {
      purpose: input.purpose,
      objectKey,
      publicUrl: buildChatAttachmentPublicUrl(objectKey),
      uploadMethod: "PUT",
      uploadUrl: signed.uploadUrl,
      uploadHeaders: signed.headers,
    },
  };
};

export const createPublicAssetUploadPlan = (
  input: PublicAssetPlanInput & { uploadProtocol: PublicAssetUploadProtocol },
): CreatePublicAssetUploadResponse => createPutPlan(input);

export const createInternalPublicAssetUploadPlan = (
  input: PublicAssetPlanInput,
): CreateInternalPublicAssetUploadResponse => createPutPlan(input);
