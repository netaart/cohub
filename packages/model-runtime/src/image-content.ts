import { IMAGE_UNAVAILABLE_TEXT, IMAGE_URL_MIME_TYPE, isImageUrlContent } from "@cohub/protocol/core";
import { fetchRemoteImage } from "@cohub/infra/safe-fetch";
import { createLogger } from "@cohub/infra/logging";
import {
  lazyStream,
  type Api,
  type ImageContent,
  type Message,
  type Model,
  type ProviderStreams,
  type StreamOptions,
  type TextContent,
  type TranscriptContext,
} from "@earendil-works/pi-ai";

const logger = createLogger({ serviceName: "cohub-model-runtime" });

const IMAGE_URL_APIS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
  "openai-codex-responses",
]);

const MARKER_DATA_URL_PREFIX = `data:${IMAGE_URL_MIME_TYPE};base64,`;
const INLINE_CONCURRENCY = 4;
const INLINE_TIMEOUT_MS = 15_000;
const INLINE_MAX_BYTES = 20 * 1024 * 1024;

export type ImageInputModel = Model<Api> & { imageUrlInput?: boolean };

export const acceptsImageUrls = (model: Model<Api>) =>
  (model as ImageInputModel).imageUrlInput !== false && IMAGE_URL_APIS.has(model.api);

const contentOf = (message: Message) =>
  (message.role === "user" || message.role === "toolResult") && Array.isArray(message.content) ? message.content : null;

const hasImageUrls = (messages: readonly Message[]) =>
  messages.some((message) => contentOf(message)?.some(isImageUrlContent));

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

export function restoreImageUrls(payload: unknown): unknown {
  if (typeof payload === "string") {
    if (payload.startsWith(MARKER_DATA_URL_PREFIX)) return payload.slice(MARKER_DATA_URL_PREFIX.length);
    if (payload === IMAGE_URL_MIME_TYPE) throw new Error("Remote image URL reached a payload without URL support");
    return payload;
  }
  if (Array.isArray(payload)) {
    let changed = false;
    const items = payload.map((item) => {
      const next = restoreImageUrls(item);
      if (next !== item) changed = true;
      return next;
    });
    return changed ? items : payload;
  }
  if (!isPlainRecord(payload)) return payload;

  const source = payload.source;
  if (payload.type === "image" && isPlainRecord(source) && source.media_type === IMAGE_URL_MIME_TYPE && typeof source.data === "string") {
    return { ...payload, source: { type: "url", url: source.data } };
  }
  let next: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(payload)) {
    const restored = restoreImageUrls(value);
    if (restored === value) continue;
    next ??= { ...payload };
    next[key] = restored;
  }
  return next ?? payload;
}

const omittedImage = (): TextContent => ({ type: "text", text: IMAGE_UNAVAILABLE_TEXT });

async function inlineImageUrls(context: TranscriptContext, signal?: AbortSignal): Promise<TranscriptContext> {
  const urls = [...new Set(context.messages.flatMap((message) => contentOf(message)?.filter(isImageUrlContent).map((image) => image.data) ?? []))];
  const images = new Map<string, ImageContent | TextContent>();
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(INLINE_CONCURRENCY, urls.length) }, async () => {
    for (let url = urls[cursor++]; url !== undefined; url = urls[cursor++]) {
      const image = await fetchRemoteImage({ url, maxBytes: INLINE_MAX_BYTES, timeoutMs: INLINE_TIMEOUT_MS, signal }).catch((error: unknown) => {
        logger.warn("[ImageInput] failed to inline remote image", { url, error });
        return null;
      });
      images.set(url, image ? { type: "image", data: image.data.toString("base64"), mimeType: image.mimeType } : omittedImage());
    }
  }));
  const messages = context.messages.map((message) => {
    const content = contentOf(message);
    if (!content?.some(isImageUrlContent)) return message;
    return { ...message, content: content.map((block) => isImageUrlContent(block) ? images.get(block.data) ?? omittedImage() : block) } as Message;
  });
  return { ...context, messages } as TranscriptContext;
}

export function withImageInputs(streams: ProviderStreams): ProviderStreams {
  const wrap = <O extends StreamOptions>(call: (model: Model<Api>, context: TranscriptContext, options?: O) => ReturnType<ProviderStreams["stream"]>) =>
    (model: Model<Api>, context: TranscriptContext, options?: O) => {
      if (!hasImageUrls(context.messages)) return call(model, context, options);
      if (!acceptsImageUrls(model)) {
        return lazyStream(model, async () => call(model, await inlineImageUrls(context, options?.signal), options));
      }
      const onPayload = options?.onPayload;
      return call(model, context, {
        ...options,
        onPayload: async (payload: unknown, payloadModel: Model<Api>) =>
          restoreImageUrls(onPayload ? (await onPayload(payload, payloadModel)) ?? payload : payload),
      } as O);
    };
  return {
    ...streams,
    stream: wrap((model, context, options) => streams.stream(model, context, options)),
    streamSimple: wrap((model, context, options) => streams.streamSimple(model, context, options)),
  };
}
