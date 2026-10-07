import { buildFileReferencesText, buildImageReferencesText } from "@cohub/protocol";
import { IMAGE_UNAVAILABLE_TEXT, type ContentBlock } from "@cohub/protocol/core";
import type { GatewayInboundEvent } from "@cohub/protocol/gateway";
import { buildTraceHeaders } from "@cohub/infra/tracing";
import { createLogger } from "@cohub/infra/logging";
import { normalizeImage } from "@cohub/media";
import { readResponseBufferLimited, safeFetch } from "@cohub/infra/safe-fetch";
import { gatewayConfig } from "../config.js";
import { detectImageMimeType, imageExtensionFromMimeType, sanitizeFilename } from "./mime.js";
import { tempMediaBlob } from "./temp-media-file.js";

const logger = createLogger({ serviceName: "cohub-gateway" });

export type GatewayImageAttachmentPlan = {
  id: string;
  filename: string | null;
  objectKey: string;
  publicUrl: string;
  uploadMethod: "PUT";
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  expiresAt: string;
};

export type GatewayFileAttachmentPlan = {
  id: string;
  name: string;
  relativePath: string;
  objectKey: string;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  expiresAt: string;
};

export type GatewayAttachmentPlanResponse = {
  ok: true;
  spaceId: string;
  sessionId: string;
  userId: string;
  bindingKey: string;
  images: GatewayImageAttachmentPlan[];
  files: { uploadId: string | null; entries: GatewayFileAttachmentPlan[] };
};

export type InboundMediaSource = "qq" | "discord" | "wechat" | "feishu";

export type InboundDownloadedImage = {
  id: string;
  buffer: Buffer;
  mediaType: string;
  filename?: string | null;
  originalUrl?: string | null;
};

type InboundDownloadedFileBase = {
  id: string;
  mediaType?: string | null;
  name: string;
  relativePath?: string | null;
  originalUrl?: string | null;
};

export type InboundDownloadedFile = InboundDownloadedFileBase & (
  | { buffer: Buffer; filePath?: never; size?: never }
  | { buffer?: never; filePath: string; size: number }
);

export type IngestInboundMediaResult = {
  blocks: ContentBlock[];
  /** Per-image block in request order (uploaded image or failure text). Useful for preserving original message order. */
  imageBlocksById: Record<string, ContentBlock>;
  uploadedImageUrls: string[];
  uploadedFilePaths: string[];
  imageFailures: number;
  fileFailures: number;
};

export async function requestGatewayAttachmentPlan(input: {
  event: GatewayInboundEvent;
  images: Array<{ id: string; size: number; mimeType: string; filename?: string | null }>;
  files?: Array<{ id: string; name: string; relativePath?: string | null; size: number; mimeType?: string | null }>;
}) {
  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/attachments/plan`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": gatewayConfig.workerSecret,
      ...buildTraceHeaders({ requestId: input.event.eventId }),
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gateway attachment plan failed ${response.status}: ${text}`);
  }
  const data = await response.json().catch(() => null) as GatewayAttachmentPlanResponse | null;
  if (!data?.ok) throw new Error("Gateway attachment plan returned an invalid response");
  return data;
}

async function putPlannedAttachment(input: {
  body: BodyInit;
  mediaType?: string | null;
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  label: string;
}) {
  const response = await fetch(input.uploadUrl, {
    method: "PUT",
    headers: {
      ...(input.mediaType ? { "content-type": input.mediaType } : {}),
      ...(input.uploadHeaders ?? {}),
    },
    body: input.body,
  });
  if (!response.ok) throw new Error(`${input.label} upload failed ${response.status}`);
}

async function prepareDurableImage(image: InboundDownloadedImage, label: string): Promise<InboundDownloadedImage & { compressed: boolean }> {
  const normalized = await normalizeImage(image.buffer, image.mediaType).catch((error: unknown) => {
    logger.warn(`[InboundMedia:${label}] image kept uncompressed`, { id: image.id, error });
    return null;
  });
  if (!normalized?.changed) return { ...image, compressed: false };
  const stem = image.filename?.replace(/\.[^.]+$/, "") || image.id;
  return { ...image, buffer: normalized.data, mediaType: normalized.mimeType, filename: `${stem}.webp`, compressed: true };
}

export async function uploadPlannedImageAttachment(input: {
  buffer: Buffer;
  mediaType: string;
  plan: GatewayImageAttachmentPlan;
  source: InboundMediaSource;
  originalUrl?: string | null;
  original?: { mediaType: string; size: number };
}): Promise<ContentBlock> {
  await putPlannedAttachment({
    body: new Uint8Array(input.buffer),
    mediaType: input.mediaType,
    uploadUrl: input.plan.uploadUrl,
    uploadHeaders: input.plan.uploadHeaders,
    label: "Gateway image attachment",
  });
  return {
    type: "image",
    source: { type: "url", url: input.plan.publicUrl },
    _meta: {
      filename: input.plan.filename,
      mediaType: input.mediaType,
      size: input.buffer.length,
      objectKey: input.plan.objectKey,
      source: input.source,
      originalUrl: input.originalUrl ?? null,
      ...(input.original ? { originalMediaType: input.original.mediaType, originalSize: input.original.size } : {}),
    },
  };
}

export async function uploadPlannedFileAttachments(input: {
  spaceId: string;
  uploadId: string | null;
  files: Array<{
    id: string;
    buffer?: Buffer;
    filePath?: string;
    mediaType: string | null;
  }>;
  plans: GatewayFileAttachmentPlan[];
}): Promise<{ paths: string[]; pathById: Map<string, string> }> {
  if (!input.uploadId || input.files.length === 0) {
    return { paths: [], pathById: new Map() };
  }
  const plansById = new Map(input.plans.map((plan) => [plan.id, plan]));
  const uploadedIds: string[] = [];
  for (const file of input.files) {
    const plan = plansById.get(file.id);
    if (!plan) continue;
    const body = file.buffer !== undefined
      ? new Uint8Array(file.buffer)
      : file.filePath
        ? await tempMediaBlob({ path: file.filePath }, file.mediaType ?? "application/octet-stream")
        : null;
    if (!body) continue;
    await putPlannedAttachment({
      body,
      mediaType: file.mediaType,
      uploadUrl: plan.uploadUrl,
      uploadHeaders: plan.uploadHeaders,
      label: "Gateway file attachment",
    });
    uploadedIds.push(file.id);
  }
  if (uploadedIds.length === 0) return { paths: [], pathById: new Map() };

  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/attachments/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": gatewayConfig.workerSecret,
      ...buildTraceHeaders(),
    },
    body: JSON.stringify({ spaceId: input.spaceId, uploadId: input.uploadId, entryIds: uploadedIds }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Gateway file attachment complete failed ${response.status}: ${text}`);
  }
  const data = await response.json().catch(() => null) as {
    ok?: boolean;
    uploaded?: Array<{ path?: string; name?: string }>;
  } | null;
  if (!data?.ok || !Array.isArray(data.uploaded)) throw new Error("Gateway file attachment complete returned an invalid response");

  // Match uploaded paths back to plan entries by relativePath/name (order is not guaranteed).
  const pathById = new Map<string, string>();
  const paths: string[] = [];
  const remaining = data.uploaded.filter((file): file is { path: string; name?: string } => Boolean(file.path));
  for (const file of remaining) paths.push(file.path);
  for (const id of uploadedIds) {
    const plan = plansById.get(id);
    if (!plan) continue;
    const index = remaining.findIndex(
      (file) =>
        file.path.endsWith(`/${plan.relativePath}`) ||
        file.path.endsWith(plan.relativePath) ||
        file.name === plan.name,
    );
    if (index < 0) continue;
    const matched = remaining[index];
    if (!matched?.path) continue;
    pathById.set(id, matched.path);
    remaining.splice(index, 1);
  }
  return { paths, pathById };
}


export async function materializeDurableAttachments(input: {
  spaceId: string;
  sessionId?: string | null;
  userId?: string | null;
  files: Array<{
    id?: string;
    name: string;
    relativePath: string;
    size: number;
    mimeType?: string | null;
    downloadUrl: string;
  }>;
}): Promise<{ paths: string[]; pathById: Map<string, string> }> {
  if (input.files.length === 0) return { paths: [], pathById: new Map() };
  const response = await fetch(`${gatewayConfig.apiBaseUrl}/internal/gateway/attachments/materialize`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-worker-secret": gatewayConfig.workerSecret,
      ...buildTraceHeaders(),
    },
    body: JSON.stringify({
      spaceId: input.spaceId,
      sessionId: input.sessionId ?? null,
      userId: input.userId ?? null,
      files: input.files,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Gateway materialize failed ${response.status}: ${detail}`);
  }
  const data = await response.json().catch(() => null) as {
    ok?: boolean;
    uploaded?: Array<{ path?: string }>;
    pathById?: Record<string, string>;
  } | null;
  if (!data?.ok || !Array.isArray(data.uploaded)) {
    throw new Error("Gateway materialize returned an invalid response");
  }
  const paths = data.uploaded.map((file) => file.path).filter((path): path is string => Boolean(path));
  const pathById = new Map<string, string>(Object.entries(data.pathById ?? {}));
  return { paths, pathById };
}

export function buildUploadedFileReferencesBlock(paths: string[]): ContentBlock | null {
  const text = buildFileReferencesText(paths);
  return text ? { type: "text", text } : null;
}

export function buildUploadedImageReferencesBlock(urls: string[]): ContentBlock | null {
  const text = buildImageReferencesText(urls);
  return text ? { type: "text", text } : null;
}

export async function downloadInboundUrl(input: {
  url: string;
  maxBytes: number;
  label: string;
  allowedHosts?: string[];
  headers?: Record<string, string>;
  timeoutMs?: number;
  allowHttp?: boolean;
}) {
  const response = await safeFetch({
    url: input.url,
    label: input.label,
    allowedHosts: input.allowedHosts,
    timeoutMs: input.timeoutMs,
    allowHttp: input.allowHttp,
    init: {
      headers: {
        "User-Agent": "CohubGateway/1.0",
        ...(input.headers ?? {}),
      },
    },
  });
  if (!response.ok) throw new Error(`${input.label} download failed ${response.status}`);
  const buffer = await readResponseBufferLimited(response, input.maxBytes, input.label);
  const mediaType = response.headers.get("content-type")?.split(";")[0]?.trim() || "application/octet-stream";
  return { buffer, mediaType };
}

export async function ingestInboundMedia(input: {
  event: GatewayInboundEvent;
  source: InboundMediaSource;
  images?: InboundDownloadedImage[];
  files?: InboundDownloadedFile[];
  label?: string;
}): Promise<IngestInboundMediaResult> {
  const images = input.images ?? [];
  const files = input.files ?? [];
  const label = input.label ?? input.source;
  const empty: IngestInboundMediaResult = {
    blocks: [],
    imageBlocksById: {},
    uploadedImageUrls: [],
    uploadedFilePaths: [],
    imageFailures: 0,
    fileFailures: 0,
  };
  if (images.length === 0 && files.length === 0) return empty;

  try {
    // Ordinary files: private upload once.
    // Images: try durable public once; on failure fall back to private file slot planned upfront.
    // Successful durable images: server materialize from public URL (no second gateway PUT).
    const usedRelativePaths = new Set<string>();
    const uniqueRelativePath = (raw: string, fallback: string) => {
      const base = sanitizeFilename(raw || fallback, fallback);
      if (!usedRelativePaths.has(base)) {
        usedRelativePaths.add(base);
        return base;
      }
      const dot = base.lastIndexOf(".");
      const stem = dot > 0 ? base.slice(0, dot) : base;
      const ext = dot > 0 ? base.slice(dot) : "";
      let index = 2;
      let candidate = `${stem}-${index}${ext}`;
      while (usedRelativePaths.has(candidate)) {
        index += 1;
        candidate = `${stem}-${index}${ext}`;
      }
      usedRelativePaths.add(candidate);
      return candidate;
    };

    const plannedFiles = files.map((file) => {
      const name = sanitizeFilename(file.name, file.id);
      const relativePath = uniqueRelativePath(file.relativePath ?? name, name);
      return {
        id: file.id,
        name: relativePath.split("/").at(-1) ?? name,
        relativePath,
        size: file.buffer !== undefined ? file.buffer.length : file.size,
        mimeType: file.mediaType ?? null,
        buffer: file.buffer,
        filePath: file.filePath,
      };
    });

    const durableImages = new Map(await Promise.all(images.map(async (image) => [image.id, await prepareDurableImage(image, label)] as const)));
    const durableImageOf = (image: InboundDownloadedImage) => durableImages.get(image.id) ?? { ...image, compressed: false };

    // Reserve private file slots for every image so durable failures can demote without re-plan.
    const imageFileSlots = images.map((image) => {
      const fallback = `${image.id}.${imageExtensionFromMimeType(image.mediaType)}`;
      const name = uniqueRelativePath(image.filename ?? fallback, fallback);
      return {
        id: `imgfile-${image.id}`,
        imageId: image.id,
        name,
        relativePath: name,
        size: image.buffer.length,
        mimeType: image.mediaType,
        buffer: image.buffer,
      };
    });

    const plan = await requestGatewayAttachmentPlan({
      event: input.event,
      images: images.map((image) => {
        const durable = durableImageOf(image);
        return {
          id: image.id,
          size: durable.buffer.length,
          mimeType: durable.mediaType,
          filename: durable.filename ?? `${image.id}.${imageExtensionFromMimeType(durable.mediaType)}`,
        };
      }),
      files: [
        ...plannedFiles.map((file) => ({
          id: file.id,
          name: file.name,
          relativePath: file.relativePath,
          size: file.size,
          mimeType: file.mimeType,
        })),
        ...imageFileSlots.map((file) => ({
          id: file.id,
          name: file.name,
          relativePath: file.relativePath,
          size: file.size,
          mimeType: file.mimeType,
        })),
      ],
    });

    const blocks: ContentBlock[] = [];
    const imageBlocksById: Record<string, ContentBlock> = {};
    const uploadedImageUrls: string[] = [];
    const demotedImageIds = new Set<string>();
    let imageFailures = 0;
    const plansById = new Map(plan.images.map((image) => [image.id, image]));
    const durableImageById = new Map<string, { publicUrl: string; filename: string; size: number; mediaType: string }>();

    for (const image of images) {
      const imagePlan = plansById.get(image.id);
      const slot = imageFileSlots.find((item) => item.imageId === image.id);
      const fallbackName = slot?.name ?? sanitizeFilename(
        image.filename ?? `${image.id}.${imageExtensionFromMimeType(image.mediaType)}`,
        image.id,
      );
      if (!imagePlan) {
        demotedImageIds.add(image.id);
        imageFailures += 1;
        logger.warn(`[InboundMedia:${label}] image durable plan missing; demoted to file`, { id: image.id });
        continue;
      }
      const durable = durableImageOf(image);
      try {
        const imageBlock = await uploadPlannedImageAttachment({
          buffer: durable.buffer,
          mediaType: durable.mediaType,
          plan: imagePlan,
          source: input.source,
          originalUrl: image.originalUrl,
          original: durable.compressed ? { mediaType: image.mediaType, size: image.buffer.length } : undefined,
        });
        imageBlocksById[image.id] = imageBlock;
        blocks.push(imageBlock);
        uploadedImageUrls.push(imagePlan.publicUrl);
        if (durable.compressed) continue;
        durableImageById.set(image.id, {
          publicUrl: imagePlan.publicUrl,
          filename: fallbackName,
          size: image.buffer.length,
          mediaType: image.mediaType,
        });
      } catch (error) {
        demotedImageIds.add(image.id);
        imageFailures += 1;
        logger.warn(`[InboundMedia:${label}] image durable upload demoted to file`, { id: image.id, error });
      }
    }

    let uploadedFilePaths: string[] = [];
    let fileFailures = 0;

    // Private upload: ordinary files + demoted or compressed images (pre-reserved slots).
    const privateUploadFiles = [
      ...plannedFiles.map((file) => ({
        id: file.id,
        buffer: file.buffer,
        filePath: file.filePath,
        mediaType: file.mimeType,
      })),
      ...imageFileSlots
        .filter((slot) => demotedImageIds.has(slot.imageId) || durableImages.get(slot.imageId)?.compressed)
        .map((slot) => ({
          id: slot.id,
          buffer: slot.buffer,
          mediaType: slot.mimeType,
        })),
    ];

    if (privateUploadFiles.length > 0) {
      try {
        const sandboxUpload = await uploadPlannedFileAttachments({
          spaceId: plan.spaceId,
          uploadId: plan.files.uploadId,
          files: privateUploadFiles,
          plans: plan.files.entries,
        });
        uploadedFilePaths = sandboxUpload.paths;
        for (const slot of imageFileSlots) {
          if (!demotedImageIds.has(slot.imageId)) continue;
          const path = sandboxUpload.pathById.get(slot.id);
          if (!path) continue;
          imageBlocksById[slot.imageId] = {
            type: "text",
            text: `File: \`${path}\``,
            _meta: {
              source: input.source,
              attachmentKind: "file",
              demotedFrom: "image",
              path,
            },
          };
        }
      } catch (error) {
        fileFailures = files.length + demotedImageIds.size;
        logger.warn(`[InboundMedia:${label}] file upload failed`, error);
        for (const file of files) {
          blocks.push({
            type: "text",
            text: `[File upload failed: ${sanitizeFilename(file.name)}]`,
            _meta: { source: input.source, originalUrl: file.originalUrl ?? null, reason: "upload_failed" },
          });
        }
      }
    }

    // Successful durable images: materialize from public URL (no second gateway upload).
    if (durableImageById.size > 0) {
      try {
        const imageMaterialize = await materializeDurableAttachments({
          spaceId: plan.spaceId,
          sessionId: plan.sessionId,
          userId: plan.userId,
          files: [...durableImageById.entries()].map(([id, meta]) => {
            // Prefer pre-reserved relative path for stable naming when available.
            const slot = imageFileSlots.find((item) => item.imageId === id);
            const relativePath = slot?.relativePath ?? uniqueRelativePath(meta.filename, meta.filename);
            return {
              id: `imgfile-${id}`,
              name: relativePath.split("/").at(-1) ?? meta.filename,
              relativePath,
              size: meta.size,
              mimeType: meta.mediaType,
              downloadUrl: meta.publicUrl,
            };
          }),
        });
        uploadedFilePaths = [...uploadedFilePaths, ...imageMaterialize.paths];
      } catch (error) {
        logger.warn(`[InboundMedia:${label}] image materialize skipped`, error);
      }
    }

    // Demoted images that still have no sandbox path.
    for (const image of images) {
      if (!demotedImageIds.has(image.id)) continue;
      if (imageBlocksById[image.id]) continue;
      const failureBlock: ContentBlock = {
        type: "text",
        text: IMAGE_UNAVAILABLE_TEXT,
        _meta: { source: input.source, originalUrl: image.originalUrl ?? null, reason: "demote_file_upload_failed" },
      };
      imageBlocksById[image.id] = failureBlock;
      blocks.push(failureBlock);
    }

    const fileReferences = buildUploadedFileReferencesBlock(uploadedFilePaths);
    if (fileReferences) blocks.push(fileReferences);
    else {
      const imageReferences = buildUploadedImageReferencesBlock(uploadedImageUrls);
      if (imageReferences) blocks.push(imageReferences);
    }

    if (plannedFiles.length > 0 && uploadedFilePaths.length < plannedFiles.length && fileFailures === 0) {
      fileFailures = Math.max(0, plannedFiles.length - uploadedFilePaths.length);
      for (let i = 0; i < fileFailures; i += 1) {
        blocks.push({ type: "text", text: "[File upload unavailable]", _meta: { source: input.source, reason: "plan_or_complete_partial" } });
      }
    }

    logger.info(`[InboundMedia:${label}] ingested`, {
      images: images.length,
      files: files.length,
      uploadedImages: uploadedImageUrls.length,
      uploadedFiles: uploadedFilePaths.length,
      imageFailures,
      fileFailures,
    });

    return { blocks, imageBlocksById, uploadedImageUrls, uploadedFilePaths, imageFailures, fileFailures };
  } catch (error) {
    logger.warn(`[InboundMedia:${label}] attachment plan failed`, error);
    const imageBlocksById: Record<string, ContentBlock> = {};
    const imageFailureBlocks = images.map((image) => {
      const block: ContentBlock = {
        type: "text",
        text: "[Image upload failed]",
        _meta: { source: input.source, originalUrl: image.originalUrl ?? null, reason: "plan_failed" },
      };
      imageBlocksById[image.id] = block;
      return block;
    });
    return {
      blocks: [
        ...imageFailureBlocks,
        ...files.map((file) => ({
          type: "text" as const,
          text: `[File upload failed: ${sanitizeFilename(file.name)}]`,
          _meta: { source: input.source, originalUrl: file.originalUrl ?? null, reason: "plan_failed" },
        })),
      ],
      imageBlocksById,
      uploadedImageUrls: [],
      uploadedFilePaths: [],
      imageFailures: images.length,
      fileFailures: files.length,
    };
  }
}

export function ensureImageMediaType(buffer: Buffer, fallback?: string | null) {
  return detectImageMimeType(buffer) ?? (fallback?.startsWith("image/") ? fallback : null) ?? "image/jpeg";
}
