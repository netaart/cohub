import type { Api, Context, ImageContent, Model, TextContent } from "@earendil-works/pi-ai";
import { getRemoteImageUrl, isUrlMarkerImage, supportsRemoteImageUrls, urlToPiImage } from "@cohub/model-runtime/image-content";
import { AGENT_IMAGE_MAX_EDGE, AGENT_IMAGE_MAX_OUTPUT_BYTES, imageOmittedText, normalizeAgentImage, type NormalizedImage } from "../image-normalizer.js";
import { uploadPublicAssetImage } from "../image-upload.js";
import { readPublicAssetImageUrl } from "../public-asset-storage.js";
import { RemoteImageCache } from "./image-cache.js";

type ReadImage = (url: string, signal?: AbortSignal) => Promise<{ data: Buffer; mimeType: string } | null>;
const imageCache = new RemoteImageCache();

export function clearRemoteImageCache(owner: object): void {
  imageCache.retain(owner, new Set());
}

/** Resolve only the request copy: history must remain usable after switching providers. */
export async function prepareRemoteImagesForModel(
  context: Context,
  model: Model<Api>,
  options: { read?: ReadImage; writeImage?: (image: NormalizedImage) => Promise<string>; userId?: string | null; cacheKey?: object; signal?: AbortSignal } = {},
): Promise<Context> {
  const signal = options.signal;
  signal?.throwIfAborted();
  const read = options.read ?? readPublicAssetImageUrl;
  const cacheKey = options.cacheKey;
  let imageCount = 0;
  for (const message of context.messages) {
    if ((message.role === "user" || message.role === "toolResult") && Array.isArray(message.content)) {
      imageCount += message.content.filter((block) => block.type === "image").length;
    }
  }
  const maxEdge = model.api === "anthropic-messages" && imageCount > 20 ? 2000 : undefined;
  // Converse documents 3.75 MB per image; use decimal bytes to stay within either unit convention.
  const maxBytes = model.api === "bedrock-converse-stream" ? 3_750_000 : AGENT_IMAGE_MAX_OUTPUT_BYTES;
  const remoteUrls = supportsRemoteImageUrls(model.api);
  if (!model.input.includes("image") || remoteUrls && !maxEdge) {
    if (cacheKey) clearRemoteImageCache(cacheKey);
    return context;
  }

  const urls = new Set<string>();
  for (const message of context.messages) {
    if (message.role !== "user" && message.role !== "toolResult" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "image") continue;
      const url = getRemoteImageUrl(block);
      if (url) urls.add(url);
    }
  }
  // Match cache lifetime to retained history, so compaction also releases decoded image bytes.
  const imageKey = (url: string) => `${maxEdge ?? AGENT_IMAGE_MAX_EDGE}:${maxBytes}:${url}`;
  if (cacheKey) imageCache.retain(cacheKey, new Set([...urls].map(imageKey)));

  const omitted: TextContent = { type: "text", text: imageOmittedText("image could not be loaded or processed") };
  const resolved = new Map<string, ImageContent | TextContent>();
  const pending = [...urls];
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (cursor < pending.length) {
      signal?.throwIfAborted();
      const url = pending[cursor++];
      if (url === undefined) continue;
      const cached = cacheKey ? imageCache.get(cacheKey, imageKey(url)) : undefined;
      if (cached) { resolved.set(url, cached); continue; }
      const image = await read(url, signal).catch(() => {
        signal?.throwIfAborted();
        return null;
      });
      signal?.throwIfAborted();
      const normalized = image && await normalizeAgentImage({
        ...image, sourceKind: "public_asset", originalSource: "url", originalUrl: url, maxEdge, maxBytes,
      });
      signal?.throwIfAborted();
      if (normalized) {
        try {
          let requestImage: ImageContent;
          if (remoteUrls) {
            const remoteUrl = normalized.data === image?.data ? url : await (options.writeImage ?? ((image) => uploadPublicAssetImage(image, options.userId, signal)))(normalized);
            requestImage = urlToPiImage(remoteUrl);
          } else {
            requestImage = { type: "image", data: normalized.data.toString("base64"), mimeType: normalized.mimeType };
          }
          signal?.throwIfAborted();
          if (cacheKey) imageCache.set(cacheKey, imageKey(url), requestImage);
          resolved.set(url, requestImage);
        } catch {
          signal?.throwIfAborted();
          resolved.set(url, omitted);
        }
      } else {
        resolved.set(url, omitted);
      }
    }
  }));
  signal?.throwIfAborted();

  return {
    ...context,
    messages: context.messages.map((message) => {
      if (message.role !== "user" && message.role !== "toolResult" || typeof message.content === "string") return message;
      return {
        ...message,
        content: message.content.map((block) => block.type === "image" && isUrlMarkerImage(block.mimeType)
          ? resolved.get(getRemoteImageUrl(block) ?? "") ?? omitted
          : block),
      };
    }),
  };
}
