import type { CompletionImageDescriptionFallback, CompletionMessage, CompletionUsage } from "@cohub/protocol";
import { imageBlockToPi, type ContentBlock } from "@cohub/protocol/core";
import type {
  Api,
  ImageContent,
  Model,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { ImageToTextConfig } from "@cohub/infra/config-runtime/model-tasks";
import { createModelsFromRegistry } from "./pi-models-adapter.js";
import type { RuntimeLlmModel } from "./completion-registry.js";

export type ImageToTextCall = CompletionImageDescriptionFallback;

export type PreparedImageToTextMessages = {
  messages: CompletionMessage[];
  projectedMessages: CompletionMessage[];
  calls: ImageToTextCall[];
};

type ImageDescription = {
  text: string;
  provider: string;
  model: string;
  generatedAt: string;
};

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toRuntimeModel(config: ImageToTextConfig): Model<Api> & Pick<ImageToTextConfig["model"], "requestProfile" | "imageUrlInput"> {
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
    imageUrlInput: model.imageUrlInput,
  };
}

function createStandaloneRegistry(config: ImageToTextConfig, model: Model<Api>) {
  const apiKey = config.model.apiKey;
  return {
    getAvailable: () => [model],
    getApiKey: (provider: string) => provider === model.provider ? apiKey : undefined,
    getHeaders: (provider: string, modelId?: string) =>
      provider === model.provider && (!modelId || modelId === model.id) ? model.headers : undefined,
  };
}

function normalizeUsage(value: unknown): CompletionUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : null;
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

function readDescription(block: Extract<ContentBlock, { type: "image" }>): ImageDescription | null {
  const cohub = block._meta?.cohub;
  if (!cohub || typeof cohub !== "object" || Array.isArray(cohub)) return null;
  const value = (cohub as Record<string, unknown>).imageDescription;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) return null;
  return {
    text,
    provider: typeof record.provider === "string" ? record.provider : "unknown",
    model: typeof record.model === "string" ? record.model : "unknown",
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : new Date(0).toISOString(),
  };
}

function withDescription(
  block: Extract<ContentBlock, { type: "image" }>,
  description: ImageDescription,
): Extract<ContentBlock, { type: "image" }> {
  const existingCohub = block._meta?.cohub;
  const cohub = existingCohub && typeof existingCohub === "object" && !Array.isArray(existingCohub)
    ? existingCohub as Record<string, unknown>
    : {};
  return {
    ...block,
    _meta: {
      ...(block._meta ?? {}),
      cohub: { ...cohub, imageDescription: description },
    },
  };
}

function descriptionText(text: string): ContentBlock {
  return {
    type: "text",
    text: `[Machine-generated description of the attached image]\n<image_description>\n${text}\n</image_description>`,
    _meta: { cohub: { imageDescriptionFallback: true } },
  };
}

function extractAssistantText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part && typeof part === "object" && (part as Record<string, unknown>).type === "text"
      ? String((part as Record<string, unknown>).text ?? "")
      : "")
    .join("")
    .trim();
}

async function describeImage(input: {
  config: ImageToTextConfig;
  image: ImageContent;
  signal?: AbortSignal;
}): Promise<{ description: ImageDescription; usage: CompletionUsage | null }> {
  const model = toRuntimeModel(input.config);
  const registry = createStandaloneRegistry(input.config, model);
  const models = createModelsFromRegistry(registry, model);
  const reasoning = input.config.model.reasoning
    ? input.config.model.defaultThinkingLevel as ThinkingLevel | undefined
    : undefined;
  const response = await models.completeSimple(model, {
    systemPrompt: input.config.prompt,
    messages: [{
      role: "user",
      content: [{ type: "text", text: "Describe this image." }, input.image],
      timestamp: Date.now(),
    }],
  }, {
    apiKey: registry.getApiKey(model.provider),
    headers: model.headers,
    maxTokens: 1_200,
    reasoning,
    timeoutMs: 30_000,
    signal: input.signal,
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage?.trim() || "Image description request failed");
  }
  const text = extractAssistantText(response.content);
  if (!text) throw new Error("Image description model returned empty text");
  return {
    description: {
      text,
      provider: model.provider,
      model: model.id,
      generatedAt: new Date().toISOString(),
    },
    usage: normalizeUsage(response.usage),
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

export async function prepareCompletionImagesForModel(input: {
  messages: CompletionMessage[];
  targetModel: RuntimeLlmModel;
  config: ImageToTextConfig | null;
  signal?: AbortSignal;
}): Promise<PreparedImageToTextMessages> {
  const messages = structuredClone(input.messages);
  if (!input.config || input.targetModel.input.includes("image")) {
    return { messages, projectedMessages: structuredClone(messages), calls: [] };
  }

  const pending: Array<{
    messageIndex: number;
    blockIndex: number;
    imageIndex: number;
    block: Extract<ContentBlock, { type: "image" }>;
  }> = [];
  for (const [messageIndex, message] of messages.entries()) {
    let imageIndex = 0;
    for (const [blockIndex, block] of message.content.entries()) {
      if (block.type !== "image") continue;
      if (!readDescription(block)) pending.push({ messageIndex, blockIndex, imageIndex, block });
      imageIndex += 1;
    }
  }

  const calls: ImageToTextCall[] = [];
  await mapWithConcurrency(pending, 2, async (item) => {
    const image = imageBlockToPi(item.block);
    if (!image) return;
    const startedAt = Date.now();
    try {
      const result = await describeImage({ config: input.config as ImageToTextConfig, image, signal: input.signal });
      const message = messages[item.messageIndex];
      if (message) message.content[item.blockIndex] = withDescription(item.block, result.description);
      calls.push({
        type: "image_description",
        messageIndex: item.messageIndex,
        imageIndex: item.imageIndex,
        provider: input.config?.model.provider ?? "unknown",
        model: input.config?.model.id ?? "unknown",
        status: "succeeded",
        description: result.description,
        usage: result.usage,
        durationMs: Math.max(0, Date.now() - startedAt),
      });
    } catch (error) {
      calls.push({
        type: "image_description",
        messageIndex: item.messageIndex,
        imageIndex: item.imageIndex,
        provider: input.config?.model.provider ?? "unknown",
        model: input.config?.model.id ?? "unknown",
        status: "failed",
        usage: null,
        durationMs: Math.max(0, Date.now() - startedAt),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  calls.sort((a, b) => a.messageIndex - b.messageIndex || a.imageIndex - b.imageIndex);
  const projectedMessages = structuredClone(messages);
  for (const message of projectedMessages) {
    message.content = message.content.map((block) => {
      if (block.type !== "image") return block;
      const description = readDescription(block);
      return description ? descriptionText(description.text) : block;
    });
  }
  return { messages, projectedMessages, calls };
}
