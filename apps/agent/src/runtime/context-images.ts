import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import type { ContentBlock } from "@cohub/protocol/core";
import { contentBlockToPiImage, getRemoteImageUrl } from "@cohub/model-runtime/image-content";
import { normalizeImageContentBlock, type ImageNormalizationOptions } from "../image-normalizer.js";
import type { SessionManager } from "./local-session-manager.js";

const IMAGE_CONCURRENCY = 4;
const validatedImages = new WeakSet<ImageContent | ImageBlock>();
type Image = { data: Buffer; mimeType: string };
type ImageBlock = Extract<ContentBlock, { type: "image" }>;
type RecoveredBlock = Extract<ContentBlock, { type: "image" | "text" }>;
const imageSource = (block: ImageContent | ImageBlock): ImageBlock["source"] => {
  if ("source" in block) return block.source;
  const url = getRemoteImageUrl(block);
  return url ? { type: "url", url } : { type: "base64", data: block.data, media_type: block.mimeType };
};
const imageKey = (block: ImageContent | ImageBlock) => {
  const source = imageSource(block);
  return source.type === "url" ? source.url : source.data;
};
const isNativeUserMessage = (message: AgentMessage): message is UserMessage => message.role === "user"
  && (typeof message.content === "string" || message.content.every((block) => block.type === "text" || block.type === "image" && "data" in block));

/** Normalize the retained native projection, including entries already present before recovery. */
export async function hydrateSessionImages(manager: SessionManager, read: (url: string, signal?: AbortSignal) => Promise<Image | null>, options: ImageNormalizationOptions = {}): Promise<{ changed: boolean; messages: AgentMessage[] }> {
  options.signal?.throwIfAborted();
  const entries = manager.getRetainedMessageEntries();
  const images = new Map<string, ImageContent | ImageBlock>();
  for (const { message } of entries) {
    if (message.role !== "user" && message.role !== "toolResult" || typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "image" && !validatedImages.has(block)) images.set(imageKey(block), block);
    }
  }
  const pending = [...images.entries()];
  const resolved = new Map<string, RecoveredBlock>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, pending.length) }, async () => {
    while (cursor < pending.length) {
      options.signal?.throwIfAborted();
      const entry = pending[cursor++];
      if (!entry) continue;
      const [key, block] = entry;
      const normalized = await normalizeImageContentBlock({ type: "image", source: imageSource(block) }, { ...options, readUrlImage: read });
      if (normalized.type === "image" || normalized.type === "text") resolved.set(key, normalized);
    }
  }));
  options.signal?.throwIfAborted();
  const replacementFor = (block: ImageContent | ImageBlock, includeFailures: boolean) => {
    const replacement = resolved.get(imageKey(block));
    if (!replacement) return undefined;
    const transient = replacement._meta?.reason === "load_failed" || replacement._meta?.reason === "upload_failed";
    return transient && !includeFailures ? undefined : replacement;
  };
  const project = (message: AgentMessage, includeFailures: boolean): AgentMessage => {
    if (message.role !== "user" && message.role !== "toolResult" || typeof message.content === "string") return message;
    let changed = false;
    if (message.role === "toolResult" || isNativeUserMessage(message)) {
      const content = message.content.map((block): ImageContent | TextContent => {
        if (block.type !== "image") return block;
        const replacement = replacementFor(block, includeFailures);
        if (!replacement) return block;
        const image = replacement.type === "image" ? contentBlockToPiImage(replacement) : null;
        if (image) {
          const same = image.data === block.data && image.mimeType === block.mimeType;
          const result = same ? block : image;
          validatedImages.add(result);
          changed ||= !same;
          return result;
        }
        if (replacement.type === "text") { changed = true; return { type: "text", text: replacement.text }; }
        return block;
      });
      return changed ? { ...message, content } : message;
    }
    const content = message.content.map((block) => {
      if (block.type !== "image") return block;
      const replacement = replacementFor(block, includeFailures);
      if (!replacement) return block;
      if (replacement.type === "image") {
        const same = replacement.source.type === block.source.type && imageKey(replacement) === imageKey(block);
        const result = same ? block : replacement;
        validatedImages.add(result);
        changed ||= !same;
        return result;
      }
      changed = true;
      return replacement;
    });
    return changed ? { ...message, content } : message;
  };
  const replacements = new Map<string, AgentMessage>();
  const requestMessages = new Map<AgentMessage, AgentMessage>();
  for (const { id, message } of entries) {
    const persisted = project(message, false);
    if (persisted !== message) replacements.set(id, persisted);
    // Failed reads/uploads affect only this request; JSONL keeps the source for a later retry.
    const request = project(persisted, true);
    if (request !== persisted) requestMessages.set(persisted, request);
  }
  await manager.replaceMessages(replacements);
  return { changed: replacements.size > 0, messages: manager.buildSessionContext().messages.map((message) => requestMessages.get(message) ?? message) };
}
