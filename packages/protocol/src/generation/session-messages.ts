import type { ContentBlock } from "../core/content.js";
import type { GenerationContentBlock } from "@neta-art/generation";

export const GENERATION_MESSAGE_VERSION = 1 as const;

export type GenerationMessageKind = "request" | "result";

export type GenerationMessageMeta = {
  schemaVersion: typeof GENERATION_MESSAGE_VERSION;
  taskId: string;
  kind: GenerationMessageKind;
  model: string;
  provider?: string | null;
  parameters: Record<string, unknown>;
};

function imageBlocks(content: unknown[], attachmentKind: "generation-input" | "generation-output") {
  return content.flatMap((item): ContentBlock[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const block = item as Partial<GenerationContentBlock>;
    if (block.type !== "image" || !block.source || block.source.type !== "url") return [];
    return [{
      type: "image",
      source: { type: "url", url: block.source.url },
      _meta: { attachmentKind },
    }];
  });
}

function stringifyMessage(value: Record<string, unknown>) {
  return JSON.stringify(value, null, 2);
}

export function buildGenerationRequestMessage(input: {
  taskId: string;
  model: string;
  provider?: string | null;
  parameters?: Record<string, unknown>;
  content: GenerationContentBlock[];
}): { content: ContentBlock[]; meta: GenerationMessageMeta } {
  const parameters = input.parameters ?? {};
  const message = {
    version: GENERATION_MESSAGE_VERSION,
    type: "generation.request",
    taskId: input.taskId,
    model: input.model,
    ...(input.provider ? { provider: input.provider } : {}),
    parameters,
    content: input.content,
  };
  return {
    content: [
      {
        type: "text",
        text: stringifyMessage(message),
        _meta: { attachmentKind: "generation-input" },
      },
      ...imageBlocks(input.content, "generation-input"),
    ],
    meta: {
      schemaVersion: GENERATION_MESSAGE_VERSION,
      taskId: input.taskId,
      kind: "request",
      model: input.model,
      provider: input.provider ?? null,
      parameters,
    },
  };
}

export function buildGenerationResultMessage(input: {
  taskId: string;
  model: string;
  provider?: string | null;
  parameters?: Record<string, unknown>;
  status: "queued" | "running" | "completed" | "failed";
  result?: unknown;
  error?: { code?: string | null; message: string; requestId?: string; upstreamRequestIds?: string[] } | null;
}): { content: ContentBlock[]; meta: GenerationMessageMeta } {
  const parameters = input.parameters ?? {};
  const message = {
    version: GENERATION_MESSAGE_VERSION,
    type: "generation.result",
    taskId: input.taskId,
    status: input.status,
    model: input.model,
    ...(input.provider ? { provider: input.provider } : {}),
    parameters,
    ...(input.status === "completed" ? { result: input.result ?? null } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
  const resultContent = Array.isArray(input.result) ? input.result : [];
  return {
    content: [
      {
        type: "text",
        text: stringifyMessage(message),
        _meta: { attachmentKind: "generation-output" },
      },
      ...imageBlocks(resultContent, "generation-output"),
    ],
    meta: {
      schemaVersion: GENERATION_MESSAGE_VERSION,
      taskId: input.taskId,
      kind: "result",
      model: input.model,
      provider: input.provider ?? null,
      parameters,
    },
  };
}
