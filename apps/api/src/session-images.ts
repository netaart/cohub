import { createLogger } from "@cohub/infra/logging";
import { fetchRemoteImage } from "@cohub/infra/safe-fetch";
import { normalizeImage } from "@cohub/media";
import { IMAGE_UNAVAILABLE_TEXT, type ContentBlock, type ImageBlock } from "@cohub/protocol/core";
import { createInternalPublicAssetUploadPlan, isAllowedPublicAssetDownloadUrl } from "./public-asset-storage.js";

const logger = createLogger({ serviceName: "cohub-api" });

const MAX_HOSTED_IMAGES = 16;
const HOST_CONCURRENCY = 2;
const REMOTE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const UPLOAD_TIMEOUT_MS = 30_000;

type Scope = { userUuid: string; spaceId: string; sessionId?: string | null };

const needsHosting = (block: ContentBlock): block is ImageBlock =>
  block.type === "image" && (block.source.type === "base64" || !isAllowedPublicAssetDownloadUrl(block.source.url));

async function upload(scope: Scope, data: Buffer, mimeType: string) {
  const { asset } = createInternalPublicAssetUploadPlan({
    purpose: "session_image",
    userUuid: scope.userUuid,
    spaceId: scope.spaceId,
    sessionId: scope.sessionId ?? undefined,
    file: { size: data.byteLength, mimeType },
    endpoint: "internal",
  });
  const response = await fetch(asset.uploadUrl, { method: "PUT", headers: asset.uploadHeaders, body: new Uint8Array(data), signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new Error(`Session image upload failed ${response.status}`);
  return asset.publicUrl;
}

const unhosted = (block: ImageBlock): ContentBlock => block.source.type === "base64"
  ? block
  : { type: "text", text: IMAGE_UNAVAILABLE_TEXT, _meta: { ...block._meta, originalUrl: block.source.url } };

async function hostImage(scope: Scope, block: ImageBlock): Promise<ContentBlock> {
  const received = block.source.type === "base64"
    ? { data: Buffer.from(block.source.data, "base64"), mimeType: block.source.media_type }
    : await fetchRemoteImage({ url: block.source.url, maxBytes: REMOTE_IMAGE_MAX_BYTES });
  const image = await normalizeImage(received.data, received.mimeType);
  const [url, original] = await Promise.all([
    upload(scope, image.data, image.mimeType),
    image.changed
      ? upload(scope, received.data, image.original.mimeType ?? received.mimeType).catch((error: unknown) => {
          logger.warn("[SessionImages] original image upload failed", { spaceId: scope.spaceId, error });
          return null;
        })
      : null,
  ]);
  return {
    type: "image",
    source: { type: "url", url },
    _meta: {
      ...block._meta,
      mediaType: image.mimeType,
      size: image.data.byteLength,
      width: image.width,
      height: image.height,
      ...(block.source.type === "url" ? { originalUrl: block.source.url } : {}),
      ...(original ? { original: { url: original, mediaType: image.original.mimeType, size: image.original.size } } : {}),
    },
  };
}

export async function hostPromptImages(content: ContentBlock[], scope: Scope): Promise<ContentBlock[]> {
  const pending = content.flatMap((block, index) => needsHosting(block) ? [index] : []);
  if (pending.length === 0) return content;
  const hosted = [...content];
  for (const index of pending.slice(MAX_HOSTED_IMAGES)) hosted[index] = unhosted(content[index] as ImageBlock);
  const hostable = pending.slice(0, MAX_HOSTED_IMAGES);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(HOST_CONCURRENCY, hostable.length) }, async () => {
    for (let index = hostable[cursor++]; index !== undefined; index = hostable[cursor++]) {
      const block = content[index] as ImageBlock;
      hosted[index] = await hostImage(scope, block).catch((error: unknown) => {
        logger.warn("[SessionImages] image could not be hosted", { spaceId: scope.spaceId, source: block.source.type, error });
        return unhosted(block);
      });
    }
  }));
  return hosted;
}
