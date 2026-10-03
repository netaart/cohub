import type { Usage } from "@cohub/protocol/core";
import {
  resolveModelTaskApiKey,
  type ImageToTextConfig,
} from "@cohub/infra/config-runtime/model-tasks";
import type {
  Api,
  Context,
  ImageContent,
  Model,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { restoreRemoteImageUrls } from "@cohub/model-runtime/image-content";
import {
  loadTurnImageDescriptions,
  persistTurnImageDescription,
  type StoredImageDescription,
} from "../image-description-store.js";
import { logger } from "../logger.js";
import type { SessionManager } from "./local-session-manager.js";
import { createModelsFromRegistry } from "./pi-models-adapter.js";
import { prepareRemoteImagesForModel } from "./image-transport.js";

const CUSTOM_TYPE = "image_description.v1";
const DESCRIPTION_CONCURRENCY = 2;
const descriptionCache = new WeakMap<SessionManager, Map<string, StoredImageDescription>>();
const attemptedByTurn = new WeakMap<SessionManager, { turnId: string; sourceKeys: Set<string> }>();

export type AgentImageToTextCall = {
  sourceKey: string;
  provider: string;
  model: string;
  status: "succeeded" | "failed";
  usage: Usage | null;
  durationMs: number;
  error?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeUsage(value: unknown): Usage | null {
  const usage = asRecord(value);
  if (!usage) return null;
  const cost = asRecord(usage.cost);
  return {
    input: finiteOrZero(usage.input),
    output: finiteOrZero(usage.output),
    cacheRead: finiteOrZero(usage.cacheRead),
    cacheWrite: finiteOrZero(usage.cacheWrite),
    totalTokens: finiteOrZero(usage.totalTokens),
    cost: cost
      ? {
          input: finiteOrZero(cost.input),
          output: finiteOrZero(cost.output),
          cacheRead: finiteOrZero(cost.cacheRead),
          cacheWrite: finiteOrZero(cost.cacheWrite),
          total: finiteOrZero(cost.total),
        }
      : null,
  };
}

function toRuntimeModel(config: ImageToTextConfig): Model<Api> & Pick<ImageToTextConfig["model"], "requestProfile"> {
  const model = config.model;
  return {
    id: model.id,
    name: model.name?.trim() || model.id,
    api: model.api as Api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning ?? false,
    input: model.input ?? ["text", "image"],
    cost: {
      input: finiteOrZero(model.cost?.input),
      output: finiteOrZero(model.cost?.output),
      cacheRead: finiteOrZero(model.cost?.cacheRead),
      cacheWrite: finiteOrZero(model.cost?.cacheWrite),
    },
    contextWindow: model.contextWindow ?? 32_768,
    maxTokens: model.maxTokens ?? 2_048,
    headers: model.headers,
    compat: model.compat as Model<Api>["compat"],
    requestProfile: model.requestProfile,
  };
}

function createStandaloneRegistry(config: ImageToTextConfig, model: Model<Api>) {
  const apiKey = resolveModelTaskApiKey(config.model.apiKey);
  return {
    getAvailable: () => [model],
    getApiKey: (provider: string) => provider === model.provider ? apiKey : undefined,
    getHeaders: (provider: string, modelId?: string) =>
      provider === model.provider && (!modelId || modelId === model.id) ? model.headers : undefined,
  };
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    const record = asRecord(part);
    return record?.type === "text" && typeof record.text === "string" ? record.text : "";
  }).join("").trim();
}

async function describeImage(input: {
  config: ImageToTextConfig;
  image: ImageContent;
  signal?: AbortSignal;
}): Promise<StoredImageDescription> {
  const model = toRuntimeModel(input.config);
  const registry = createStandaloneRegistry(input.config, model);
  const models = createModelsFromRegistry(registry, model);
  const reasoning = input.config.model.reasoning
    ? input.config.model.defaultThinkingLevel as ThinkingLevel | undefined
    : undefined;
  const context = await prepareRemoteImagesForModel({
    systemPrompt: input.config.prompt,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "Describe this image." }, input.image],
      timestamp: Date.now(),
    }],
  }, model, { signal: input.signal });
  const content = context.messages[0]?.content;
  if (!Array.isArray(content) || !content.some((block) => block.type === "image")) {
    throw new Error("Image could not be loaded for description");
  }
  const response = await models.completeSimple(model, context, {
    apiKey: registry.getApiKey(model.provider),
    headers: model.headers,
    maxTokens: 1_200,
    reasoning,
    timeoutMs: 30_000,
    signal: input.signal,
    onPayload: restoreRemoteImageUrls,
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage?.trim() || "Image description request failed");
  }
  const text = extractAssistantText(response.content);
  if (!text) throw new Error("Image description model returned empty text");
  return {
    text,
    provider: model.provider,
    model: model.id,
    usage: normalizeUsage(response.usage),
    generatedAt: new Date().toISOString(),
  };
}

function readCustomDescriptions(sessionManager: SessionManager): Map<string, StoredImageDescription> {
  const cached = descriptionCache.get(sessionManager);
  if (cached) return cached;
  const descriptions = new Map<string, StoredImageDescription>();
  for (const entry of sessionManager.getCustomEntries(CUSTOM_TYPE)) {
    const data = asRecord(entry.data);
    const sourceEntryId = typeof data?.sourceEntryId === "string" ? data.sourceEntryId : null;
    const imageIndex = typeof data?.imageIndex === "number" && Number.isInteger(data.imageIndex)
      ? data.imageIndex
      : null;
    const sourceKey = typeof data?.sourceKey === "string"
      ? data.sourceKey
      : sourceEntryId && imageIndex !== null
        ? `${sourceEntryId}:${imageIndex}`
        : null;
    const text = typeof data?.text === "string" ? data.text.trim() : "";
    if (!sourceKey || !text) continue;
    descriptions.set(sourceKey, {
      text,
      provider: typeof data?.provider === "string" ? data.provider : "unknown",
      model: typeof data?.model === "string" ? data.model : "unknown",
      usage: asRecord(data?.usage) as Usage | null,
      generatedAt: typeof data?.generatedAt === "string" ? data.generatedAt : new Date(0).toISOString(),
    });
  }
  descriptionCache.set(sessionManager, descriptions);
  return descriptions;
}

function isImage(value: unknown): value is ImageContent {
  const record = asRecord(value);
  return record?.type === "image" && typeof record.data === "string" && typeof record.mimeType === "string";
}

function imageDescriptionText(text: string) {
  return {
    type: "text" as const,
    text: `[Machine-generated description of the attached image]\n<image_description>\n${text}\n</image_description>`,
  };
}

type PendingImage = {
  messageIndex: number;
  blockIndex: number;
  imageIndex: number;
  image: ImageContent;
  sourceKey: string;
  sourceEntryId: string | null;
  turnId: string | null;
};

function collectImages(messages: Context["messages"], sessionManager: SessionManager): PendingImage[] {
  const images: PendingImage[] = [];
  for (const [messageIndex, message] of messages.entries()) {
    const record = message as unknown as Record<string, unknown>;
    if (!Array.isArray(record.content)) continue;
    const meta = asRecord(record.meta);
    const messageId = typeof meta?.messageId === "string"
      ? meta.messageId
      : typeof meta?.userMessageId === "string"
        ? meta.userMessageId
        : null;
    const turnId = typeof meta?.turnId === "string" ? meta.turnId : null;
    const directEntryId = typeof record.sessionEntryId === "string" ? record.sessionEntryId : null;
    const sourceEntryId = messageId ? sessionManager.findUserMessageEntryId(messageId) : directEntryId;
    let imageIndex = 0;
    for (const [blockIndex, block] of record.content.entries()) {
      if (!isImage(block)) continue;
      const sourceKey = sourceEntryId
        ? `${sourceEntryId}:${imageIndex}`
        : turnId
          ? `turn:${turnId}:${imageIndex}`
          : `request:${messageIndex}:${imageIndex}`;
      images.push({ messageIndex, blockIndex, imageIndex, image: block, sourceKey, sourceEntryId, turnId });
      imageIndex += 1;
    }
  }
  return images;
}

function projectDescribedImages(
  context: Context,
  images: PendingImage[],
  descriptions: Map<string, StoredImageDescription>,
): Context {
  const replacementsByMessage = new Map<number, Array<{ blockIndex: number; text: string }>>();
  for (const image of images) {
    const description = descriptions.get(image.sourceKey);
    if (!description) continue;
    let replacements = replacementsByMessage.get(image.messageIndex);
    if (!replacements) {
      replacements = [];
      replacementsByMessage.set(image.messageIndex, replacements);
    }
    replacements.push({ blockIndex: image.blockIndex, text: description.text });
  }
  if (replacementsByMessage.size === 0) return context;
  // Copy only the messages being modified so tool functions and other
  // non-cloneable runtime references on the context stay intact.
  return {
    ...context,
    messages: context.messages.map((message, messageIndex) => {
      const replacements = replacementsByMessage.get(messageIndex);
      if (!replacements) return message;
      const record = message as unknown as Record<string, unknown>;
      if (!Array.isArray(record.content)) return message;
      const content = [...record.content];
      for (const replacement of replacements) {
        content[replacement.blockIndex] = imageDescriptionText(replacement.text);
      }
      return { ...message, content } as Context["messages"][number];
    }),
  };
}

async function mapWithConcurrency<T>(items: T[], concurrency: number, mapper: (item: T) => Promise<void>): Promise<void> {
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      const item = items[index];
      if (item !== undefined) await mapper(item);
    }
  }));
}

export async function prepareAgentImagesForModel(input: {
  context: Context;
  targetModel: Model<Api>;
  config: ImageToTextConfig | null;
  sessionManager: SessionManager;
  sessionId: string;
  executionTurnId?: string | null;
  signal?: AbortSignal;
}): Promise<{ context: Context; calls: AgentImageToTextCall[] }> {
  input.signal?.throwIfAborted();
  if (!input.config || input.targetModel.input.includes("image")) {
    return { context: input.context, calls: [] };
  }

  const images = collectImages(input.context.messages, input.sessionManager);
  if (images.length === 0) return { context: input.context, calls: [] };
  const descriptions = readCustomDescriptions(input.sessionManager);
  const missingTurnIds = images
    .filter((image) => image.turnId && !descriptions.has(image.sourceKey))
    .map((image) => image.turnId as string);
  const stored = await loadTurnImageDescriptions(missingTurnIds).catch((error) => {
    logger.warn("[ImageToText] failed to load stored descriptions; continuing with session cache", error);
    return new Map<string, StoredImageDescription>();
  });
  for (const image of images) {
    if (descriptions.has(image.sourceKey) || !image.turnId) continue;
    const description = stored.get(`${image.turnId}:${image.imageIndex}`);
    if (description) descriptions.set(image.sourceKey, description);
  }

  const calls: AgentImageToTextCall[] = [];
  const executionTurnId = input.executionTurnId ?? "unknown";
  const previousAttempts = attemptedByTurn.get(input.sessionManager);
  const attempted = previousAttempts?.turnId === executionTurnId
    ? previousAttempts.sourceKeys
    : new Set<string>();
  attemptedByTurn.set(input.sessionManager, { turnId: executionTurnId, sourceKeys: attempted });
  const pending = images.filter((image) => !descriptions.has(image.sourceKey) && !attempted.has(image.sourceKey));
  await mapWithConcurrency(pending, DESCRIPTION_CONCURRENCY, async (image) => {
    input.signal?.throwIfAborted();
    attempted.add(image.sourceKey);
    const startedAt = Date.now();
    let description: StoredImageDescription;
    try {
      description = await describeImage({ config: input.config as ImageToTextConfig, image: image.image, signal: input.signal });
      input.signal?.throwIfAborted();
    } catch (error) {
      input.signal?.throwIfAborted();
      calls.push({
        sourceKey: image.sourceKey,
        provider: input.config?.model.provider ?? "unknown",
        model: input.config?.model.id ?? "unknown",
        status: "failed",
        usage: null,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    descriptions.set(image.sourceKey, description);
    input.sessionManager.appendCustomEntry(CUSTOM_TYPE, {
      sourceKey: image.sourceKey,
      sourceEntryId: image.sourceEntryId,
      turnId: image.turnId,
      imageIndex: image.imageIndex,
      text: description.text,
      provider: description.provider,
      model: description.model,
      usage: description.usage,
      generatedAt: description.generatedAt,
    });
    if (image.turnId) {
      await persistTurnImageDescription({
        sessionId: input.sessionId,
        turnId: image.turnId,
        imageIndex: image.imageIndex,
        description,
      }).then((persisted) => {
        if (!persisted) logger.warn(`[ImageToText] source turn image was not found turnId=${image.turnId} imageIndex=${image.imageIndex}`);
      }).catch((error) => {
        logger.warn(`[ImageToText] failed to persist source turn metadata turnId=${image.turnId} imageIndex=${image.imageIndex}`, error);
      });
    }
    calls.push({
      sourceKey: image.sourceKey,
      provider: description.provider,
      model: description.model,
      status: "succeeded",
      usage: description.usage,
      durationMs: Math.max(0, Date.now() - startedAt),
    });
  });

  input.signal?.throwIfAborted();
  return { context: projectDescribedImages(input.context, images, descriptions), calls };
}
