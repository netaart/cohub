import type { HttpTransport } from "../transport.js";

export type PublicAssetPurpose =
  | "user_avatar"
  | "space_avatar"
  | "chat_attachment"
  | "app_source"
  | "generation_input";
export type PublicAssetUploadProtocol = "presigned_put_v1";
/** Preprocessed chat images. General chat files and avatars may use any mime string. */
export type PublicAssetMimeType = "image/webp" | "image/jpeg";

export type CreatePublicAssetUploadInput = {
  purpose: PublicAssetPurpose;
  uploadProtocol: PublicAssetUploadProtocol;
  spaceId?: string;
  sessionId?: string;
  file: {
    size: number;
    mimeType: string;
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

export type UploadPublicAssetInput = {
  purpose: PublicAssetPurpose;
  spaceId?: string;
  sessionId?: string;
  file: Blob;
  mimeType: string;
  filename?: string;
  onProgress?: (progress: PublicAssetUploadProgress) => void;
  signal?: AbortSignal;
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
  file: Blob;
  mimeType: string;
  filename?: string;
  onProgress?: (progress: PublicAssetUploadProgress) => void;
  signal?: AbortSignal;
};

/** A local generation input (image, video, or audio); same shape as a chat attachment. */
export type UploadGenerationInputInput = UploadChatAttachmentInput;

/** @deprecated Prefer UploadChatAttachmentInput — images are a special case of chat attachments. */
export type UploadChatImageAttachmentInput = UploadChatAttachmentInput & {
  mimeType: PublicAssetMimeType;
};

function createAbortError() {
  if (typeof DOMException === "function") return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function uploadWithProgress(input: {
  method: "PUT";
  url: string;
  headers?: Record<string, string>;
  body: Blob;
  fileBytes: number;
  onProgress: (progress: PublicAssetUploadProgress) => void;
  signal?: AbortSignal;
}) {
  return new Promise<void>((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const xhr = new XMLHttpRequest();
    let settled = false;
    let lastRatio = 0;
    const handleSignalAbort = () => xhr.abort();
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      input.signal?.removeEventListener("abort", handleSignalAbort);
      callback();
    };
    const emitProgress = (loaded: number, total: number) => {
      const ratio = Math.max(lastRatio, Math.min(1, total > 0 ? loaded / total : 0));
      lastRatio = ratio;
      try {
        input.onProgress({
          loadedBytes: Math.round(input.fileBytes * ratio),
          totalBytes: input.fileBytes,
          ratio,
        });
      } catch {
        // Observers must not be able to interrupt the upload request.
      }
    };

    try {
      xhr.open(input.method, input.url);
      for (const [key, value] of Object.entries(input.headers ?? {})) {
        if (/[\r\n\0]/.test(value)) continue;
        xhr.setRequestHeader(key, value);
      }
      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) emitProgress(event.loaded, event.total);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          emitProgress(1, 1);
          finish(resolve);
          return;
        }
        const detail = xhr.responseText?.trim();
        finish(() => reject(new Error(
          `Public asset upload failed: HTTP ${xhr.status}${detail ? ` — ${detail}` : ""}`,
        )));
      };
      xhr.onerror = () => finish(() => reject(new Error("Public asset upload failed")));
      xhr.onabort = () => finish(() => reject(createAbortError()));
      input.signal?.addEventListener("abort", handleSignalAbort, { once: true });
      xhr.send(input.body);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

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

  async upload(input: UploadPublicAssetInput) {
    if (input.signal?.aborted) throw createAbortError();
    const plan = await this.createUpload({
      purpose: input.purpose,
      uploadProtocol: "presigned_put_v1",
      spaceId: input.spaceId,
      sessionId: input.sessionId,
      file: {
        size: input.file.size,
        mimeType: input.mimeType,
        filename: input.filename,
      },
    }, { signal: input.signal });
    if (input.signal?.aborted) throw createAbortError();
    let response: Response;
    if (input.onProgress && typeof XMLHttpRequest === "function") {
      await uploadWithProgress({
        method: "PUT",
        url: plan.asset.uploadUrl,
        headers: plan.asset.uploadHeaders,
        body: input.file,
        fileBytes: input.file.size,
        onProgress: input.onProgress,
        signal: input.signal,
      });
      return plan.asset;
    }
    response = await fetch(plan.asset.uploadUrl, {
      method: "PUT",
      headers: plan.asset.uploadHeaders,
      body: input.file,
      signal: input.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(`Public asset upload failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
    }
    return plan.asset;
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
    });
  }

  /** Durable, unlisted URL for a local generation input (image, video, or audio). */
  uploadGenerationInput(input: UploadGenerationInputInput) {
    return this.upload({ ...input, purpose: "generation_input" });
  }

  /** Preprocessed chat image (webp/jpeg). Same durable path as uploadChatAttachment. */
  uploadChatImageAttachment(input: UploadChatImageAttachmentInput) {
    return this.uploadChatAttachment(input);
  }
}
