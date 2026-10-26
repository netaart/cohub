import { UPLOAD_MULTIPART_PART_BYTES } from "@cohub/protocol";
import type { MultipartUploadPlan, UploadProtocol } from "@cohub/protocol";
import type { HttpTransport } from "../transport.js";
import { UploadTask, type UploadSource, type UploadTaskOptions } from "../upload-task.js";

export type PublicAssetPurpose =
  | "user_avatar"
  | "space_avatar"
  | "chat_attachment"
  | "app_source"
  | "generation_input";
export type PublicAssetUploadProtocol = UploadProtocol;
/** Preprocessed chat images. General chat files and avatars may use any mime string. */
export type PublicAssetMimeType = "image/webp" | "image/jpeg";

export type CreatePublicAssetUploadInput = {
  purpose: PublicAssetPurpose;
  uploadProtocol: PublicAssetUploadProtocol;
  uploadRequestId?: string;
  spaceId?: string;
  sessionId?: string;
  file: {
    size: number;
    mimeType: string;
    filename?: string;
  };
};

export type PublicAssetUploadBase = {
  multipart?: MultipartUploadPlan;
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

export type UploadPublicAssetInput = {
  purpose: PublicAssetPurpose;
  spaceId?: string;
  sessionId?: string;
  file: Blob | UploadSource;
  mimeType: string;
  filename?: string;
  onProgress?: (progress: PublicAssetUploadProgress) => void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
};

export type PublicAssetUploadProgress = {
  loadedBytes: number;
  totalBytes: number;
  ratio: number;
};

export type UploadAppSourceInput = UploadChatAttachmentInput;

export type UploadChatAttachmentInput = {
  /** Optional association only; upload is user-scoped. */
  spaceId?: string;
  /** Optional association only; upload is user-scoped. */
  sessionId?: string;
  file: Blob | UploadSource;
  mimeType: string;
  filename?: string;
  onProgress?: (progress: PublicAssetUploadProgress) => void;
  signal?: AbortSignal;
  fetch?: typeof fetch;
};

/**
 * A local generation input: an image, video or audio file, or a GLB, glTF, OBJ, FBX or STL model whose `filename`
 * ends with the format's extension. Same shape as a chat attachment.
 */
export type UploadGenerationInputInput = UploadChatAttachmentInput;

/** @deprecated Prefer UploadChatAttachmentInput — images are a special case of chat attachments. */
export type UploadChatImageAttachmentInput = UploadChatAttachmentInput & {
  mimeType: PublicAssetMimeType;
};

export class PublicAssetsApi {
  constructor(private readonly transport: HttpTransport) {}

  createUpload(input: CreatePublicAssetUploadInput, options: { signal?: AbortSignal } = {}) {
    return this.transport.request<CreatePublicAssetUploadResponse>("/api/public-assets/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: options.signal,
    });
  }

  createUploadTask(input: UploadPublicAssetInput): UploadTask<PublicAssetUploadBase> {
    const uploadRequestId = crypto.randomUUID();
    const options: UploadTaskOptions = { signal: input.signal, onProgress: input.onProgress, fetch: input.fetch };
    return new UploadTask(this.transport, input.file, async (signal) => {
      const response = await this.createUpload({
        purpose: input.purpose,
        uploadProtocol: input.file.size > UPLOAD_MULTIPART_PART_BYTES ? "multipart_v1" : "presigned_put_v1",
        uploadRequestId,
        spaceId: input.spaceId,
        sessionId: input.sessionId,
        file: { size: input.file.size, mimeType: input.mimeType, filename: input.filename },
      }, { signal });
      return {
        plan: { uploadUrl: response.asset.uploadUrl, headers: response.asset.uploadHeaders, multipart: response.asset.multipart },
        result: response.asset,
      };
    }, options);
  }

  upload(input: UploadPublicAssetInput) {
    return this.createUploadTask(input).run();
  }

  /** Durable public upload for any chat attachment (image or file). No space required. */
  uploadAppSource(input: UploadAppSourceInput) {
    return this.upload({
      purpose: "app_source",
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      file: input.file,
      mimeType: input.mimeType,
      filename: input.filename,
      onProgress: input.onProgress,
      signal: input.signal,
      fetch: input.fetch,
    });
  }

  uploadChatAttachment(input: UploadChatAttachmentInput) {
    return this.upload({
      purpose: "chat_attachment",
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      file: input.file,
      mimeType: input.mimeType,
      filename: input.filename,
      onProgress: input.onProgress,
      signal: input.signal,
      fetch: input.fetch,
    });
  }

  /** Durable, unlisted URL for a local generation input (image, video, audio, or 3D model named with its extension). */
  uploadGenerationInput(input: UploadGenerationInputInput) {
    return this.upload({ ...input, purpose: "generation_input" });
  }

  /** Preprocessed chat image (webp/jpeg). Same durable path as uploadChatAttachment. */
  uploadChatImageAttachment(input: UploadChatImageAttachmentInput) {
    return this.uploadChatAttachment(input);
  }
}
