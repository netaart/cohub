import { sanitizePostgresJsonValue } from "@cohub/core/content/sanitize";
import {
  normalizeSessionTitle,
  readSessionTitleSource,
  setSessionTitleMeta,
} from "@cohub/core/sessions";
import { sessionMessages, spaceSessions } from "@cohub/db";
import {
  resolveModelTaskApiKey,
  type ModelTaskConfig,
  type ModelTaskModelConfig,
} from "@cohub/infra/config-runtime/model-tasks";
import {
  SESSION_TITLE_GENERATE_JOB,
  type SessionTitleGenerateJobData,
} from "@cohub/protocol";
import type { ContentBlock } from "@cohub/protocol/core";
import type { Api, ImageContent, Model } from "@earendil-works/pi-ai";
import type { Job } from "bullmq";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db.js";
import { createModelsFromRegistry } from "@cohub/model-runtime/pi-models-adapter";
import { loadModelTasksConfig } from "../../../model-tasks.js";
import { scheduleSessionSnapshot } from "../../../realtime-events.js";
import { buildSessionTitleContent } from "../../../session-title-content.js";
import { registerSystemJob } from "../../registry.js";

function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function toRuntimeModel(config: ModelTaskModelConfig): Model<Api> & Pick<ModelTaskModelConfig, "requestProfile" | "imageUrlInput"> {
  return {
    id: config.id,
    name: config.name?.trim() || config.id,
    api: config.api as Api,
    provider: config.provider,
    baseUrl: config.baseUrl,
    reasoning: config.reasoning ?? false,
    input: config.input ?? ["text"],
    cost: {
      input: finiteOrZero(config.cost?.input),
      output: finiteOrZero(config.cost?.output),
      cacheRead: finiteOrZero(config.cost?.cacheRead),
      cacheWrite: finiteOrZero(config.cost?.cacheWrite),
    },
    contextWindow: config.contextWindow ?? 128_000,
    maxTokens: config.maxTokens ?? 16_384,
    headers: config.headers,
    compat: config.compat as Model<Api>["compat"],
    requestProfile: config.requestProfile,
    imageUrlInput: config.imageUrlInput,
  };
}

function createTaskRegistry(task: ModelTaskConfig, model: Model<Api>) {
  const apiKey = resolveModelTaskApiKey(task.model.apiKey);
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
    if (!part || typeof part !== "object" || Array.isArray(part)) return "";
    const record = part as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? record.text : "";
  }).join("").trim();
}

async function completeTask(task: ModelTaskConfig, content: Array<{ type: "text"; text: string } | ImageContent>) {
  const model = toRuntimeModel(task.model);
  const registry = createTaskRegistry(task, model);
  const models = createModelsFromRegistry(registry, model);
  const response = await models.completeSimple(model, {
    systemPrompt: task.prompt,
    messages: [{ role: "user", content, timestamp: Date.now() }],
  }, {
    apiKey: registry.getApiKey(model.provider),
    headers: model.headers,
    maxTokens: 256,
    timeoutMs: 30_000,
  });
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw new Error(response.errorMessage?.trim() || "Model task request failed");
  }
  const text = extractAssistantText(response.content);
  if (!text) throw new Error("Model task returned empty text");
  return { text, usage: response.usage };
}

async function generateTitle(input: {
  task: ModelTaskConfig;
  imageToText?: ModelTaskConfig;
  content: ContentBlock[];
}) {
  const titleModel = toRuntimeModel(input.task.model);
  const supportsImages = titleModel.input.includes("image");
  const { parts: content, hasImages } = buildSessionTitleContent(input.content, supportsImages);
  let imageUsage: unknown = null;

  if (hasImages && !supportsImages && input.imageToText) {
    const images = buildSessionTitleContent(input.content, true).parts
      .filter((part): part is ImageContent => part.type === "image");
    if (images.length > 0) {
      const description = await completeTask(input.imageToText, [
        { type: "text", text: "Describe the images." },
        ...images,
      ]);
      content.push({ type: "text", text: description.text });
      imageUsage = description.usage;
    }
  }
  if (content.length === 0) return null;
  const title = await completeTask(input.task, content);
  return {
    rawOutput: title.text,
    title: normalizeSessionTitle(title.text),
    usage: { title: title.usage, ...(imageUsage ? { imageToText: imageUsage } : {}) },
  };
}

export async function runSessionTitleGenerateJob(data: SessionTitleGenerateJobData) {
  const [context] = await db.select({ session: spaceSessions, message: sessionMessages })
    .from(spaceSessions)
    .innerJoin(sessionMessages, and(
      eq(sessionMessages.id, data.messageId),
      eq(sessionMessages.sessionId, spaceSessions.id),
    ))
    .where(eq(spaceSessions.id, data.sessionId))
    .limit(1);
  if (!context) return { ok: true, skipped: "missing_context" };
  if (context.message.role !== "user") return { ok: true, skipped: "not_user_message" };
  if (readSessionTitleSource(context.session.meta) !== "fallback") {
    return { ok: true, skipped: "title_not_fallback" };
  }

  const config = await loadModelTasksConfig(data.userId ?? context.session.userUuid);
  const titleTask = config.sessionTitle;
  if (!titleTask) return { ok: true, skipped: "disabled" };
  const generated = await generateTitle({
    task: titleTask,
    imageToText: config.imageToText,
    content: context.message.content as ContentBlock[],
  });
  if (!generated?.title) return { ok: true, skipped: "empty_content" };

  const updated = await db.transaction(async (tx) => {
    const [session] = await tx.select().from(spaceSessions)
      .where(eq(spaceSessions.id, data.sessionId))
      .for("update")
      .limit(1);
    if (!session || readSessionTitleSource(session.meta) !== "fallback") return null;
    const [next] = await tx.update(spaceSessions).set({
      title: generated.title,
      meta: sanitizePostgresJsonValue(setSessionTitleMeta(session.meta, {
        source: "generated",
        model: `${titleTask.model.provider}/${titleTask.model.id}`,
        configRevision: config.revision,
        generatedAt: new Date().toISOString(),
        rawOutput: generated.rawOutput,
        usage: generated.usage,
      })),
      updatedAt: new Date(),
    }).where(eq(spaceSessions.id, data.sessionId)).returning();
    return next ?? null;
  });
  if (!updated) return { ok: true, skipped: "title_changed" };

  void scheduleSessionSnapshot(data.sessionId);
  return { ok: true, title: generated.title };
}

registerSystemJob(SESSION_TITLE_GENERATE_JOB, async (job: Job<SessionTitleGenerateJobData>) =>
  runSessionTitleGenerateJob(job.data));
