import { extname } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import {
  BillingAccessBlockedError,
  billingOperations,
  createBillingUsageGate,
  COHUB_BILLING_TOKEN_TYPES,
  COHUB_BILLING_USAGE_TYPES,
  normalizePositiveUsd,
  serializeBillingBlocked,
} from "@cohub/billing";
import type {
  CompletionMessage,
  CreateSpaceCompletionInput,
  SpaceCompletionResult,
  SpaceCompletionStreamEvent,
} from "@cohub/protocol";
import { normalizeContentBlocksSafe } from "@cohub/core/content/normalize";
import { createLogger } from "@cohub/infra/logging";
import { authzDenied, requireValidId, useAuth } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import { getSpaceById } from "../../space-sessions.js";
import {
  readSpaceFile,
  SpaceFsError,
  spaceFsJsonError,
} from "../../space-fs-backend.js";
import { archiveCompletionBestEffort, createCompletionId } from "../../completion-object-storage.js";
import { resolveCompletionModel } from "../../llm/models.js";
import { loadImageToTextConfig } from "../../llm/image-to-text-config.js";
import {
  runCompletion,
  streamCompletionEvents,
  type RunCompletionOutcome,
} from "../../llm/stream-completion.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

const billingUsageGate = createBillingUsageGate({
  operations: billingOperations,
  onEvaluationError: (error, gateInput) => {
    logger.warn("[BillingGate] fail-open after completion billing evaluation error", { error, gateInput });
  },
});

const MAX_SYSTEM_PROMPT_CHARS = 500_000;
const ALLOWED_SYSTEM_PROMPT_EXTENSIONS = [".md", ".markdown", ".txt", ".prompt"] as const;
const ALLOWED_SYSTEM_PROMPT_EXTENSION_SET = new Set<string>(ALLOWED_SYSTEM_PROMPT_EXTENSIONS);

const contentBlockSchema = z.object({
  type: z.string().min(1),
}).passthrough();

const completionMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string().min(1), z.array(contentBlockSchema).min(1)]),
});

const createCompletionSchema = z.object({
  provider: z.string().trim().min(1).nullish(),
  model: z.string().trim().min(1).nullish(),
  systemPromptPath: z.string().trim().nullish(),
  // No hard cap on message count: long adventure / chat histories are expected.
  // Callers and the upstream model context window remain the real limits.
  messages: z.array(completionMessageSchema).min(1),
  temperature: z.number().finite().nullish(),
  maxTokens: z.number().finite().positive().nullish(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).nullish(),
  stream: z.boolean().nullish(),
});

type ErrorStatus = 400 | 401 | 402 | 403 | 404 | 413 | 500 | 502 | 503;

type ZodIssueDetail = {
  path: string;
  message: string;
  code: string;
};

class CompletionRequestError extends Error {
  readonly status: ErrorStatus;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: ErrorStatus, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "CompletionRequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function completionError(
  c: Parameters<typeof useAuth>[0],
  status: ErrorStatus,
  code: string,
  message: string,
  details?: unknown,
) {
  return c.json({ error: { code, message, ...(details === undefined ? {} : { details }) }, message }, status);
}

function formatIssueList(items: string[], limit = 3): string {
  if (items.length === 0) return "";
  const shown = items.slice(0, limit);
  const more = items.length > limit ? ` (+${items.length - limit} more)` : "";
  return `${shown.join("; ")}${more}`;
}

function zodDetails(error: z.ZodError): ZodIssueDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
    code: issue.code,
  }));
}

function formatZodMessage(details: ZodIssueDetail[]): string {
  if (details.length === 0) return "Invalid request.";
  return formatIssueList(
    details.map((detail) => (detail.path ? `${detail.path}: ${detail.message}` : detail.message)),
  );
}

function summarizeMessagesShape(raw: unknown): {
  messageCount: number | null;
  emptyContentCount: number | null;
  invalidRoleCount: number | null;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { messageCount: null, emptyContentCount: null, invalidRoleCount: null };
  }
  const messages = (raw as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) {
    return { messageCount: null, emptyContentCount: null, invalidRoleCount: null };
  }
  let emptyContentCount = 0;
  let invalidRoleCount = 0;
  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      invalidRoleCount += 1;
      continue;
    }
    const role = (message as { role?: unknown }).role;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      invalidRoleCount += 1;
    }
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string" ? !content : !Array.isArray(content) || content.length === 0) {
      emptyContentCount += 1;
    }
  }
  return {
    messageCount: messages.length,
    emptyContentCount,
    invalidRoleCount,
  };
}

function normalizeMessages(raw: z.infer<typeof createCompletionSchema>["messages"]): CompletionMessage[] {
  return raw.map((message) => ({
    role: message.role,
    content: typeof message.content === "string"
      ? [{ type: "text" as const, text: message.content }]
      : normalizeContentBlocksSafe(message.content, {
          onInvalid: (issue) => logger.warn("[Completion] dropped unreadable content block", { message: issue.message }),
        }),
  })).filter((message) => message.content.length > 0);
}

async function loadSystemPrompt(spaceId: string, systemPromptPath: string | null | undefined): Promise<{ path: string | null; text: string }> {
  const path = systemPromptPath?.trim() || null;
  if (!path) return { path: null, text: "" };

  const extension = extname(path).toLowerCase();
  if (extension && !ALLOWED_SYSTEM_PROMPT_EXTENSION_SET.has(extension)) {
    throw new CompletionRequestError(
      400,
      "system_prompt_invalid",
      `System prompt must be ${ALLOWED_SYSTEM_PROMPT_EXTENSIONS.join("/")} (got ${extension}).`,
      {
        path,
        extension,
        allowedExtensions: [...ALLOWED_SYSTEM_PROMPT_EXTENSIONS],
      },
    );
  }

  try {
    const file = await readSpaceFile(spaceId, path, { visibility: "full" });
    if (!("content" in file) || typeof file.content !== "string") {
      throw new CompletionRequestError(
        503,
        "system_prompt_preparing",
        `System prompt not ready: ${path}`,
        { path },
      );
    }
    if (file.delivery === "url" || file.kind === "binary") {
      throw new CompletionRequestError(
        400,
        "system_prompt_unsupported",
        `System prompt is binary or too large for inline load: ${path}`,
        {
          path,
          kind: file.kind,
          delivery: file.delivery,
        },
      );
    }
    if (file.content.length > MAX_SYSTEM_PROMPT_CHARS) {
      throw new CompletionRequestError(
        413,
        "system_prompt_too_large",
        `System prompt exceeds ${MAX_SYSTEM_PROMPT_CHARS} characters (${file.content.length}).`,
        {
          path,
          charCount: file.content.length,
          maxChars: MAX_SYSTEM_PROMPT_CHARS,
        },
      );
    }
    return { path, text: file.content };
  } catch (error) {
    if (error instanceof CompletionRequestError) throw error;
    if (error instanceof SpaceFsError) {
      if (error.code === "path_not_found" || error.status === 404) {
        throw new CompletionRequestError(
          404,
          "system_prompt_not_found",
          `System prompt not found: ${path}`,
          { path, causeCode: error.code },
        );
      }
      throw new CompletionRequestError(
        error.status as ErrorStatus,
        error.code.startsWith("system_prompt_") ? error.code : `system_prompt_${error.code}`,
        `System prompt load failed (${path}): ${error.message}`,
        { path, causeCode: error.code },
      );
    }
    const { status, body: errBody } = spaceFsJsonError(error);
    throw new CompletionRequestError(
      status as ErrorStatus,
      errBody.code.startsWith("system_prompt_") ? errBody.code : `system_prompt_${errBody.code}`,
      `System prompt load failed (${path}): ${errBody.message}`,
      { path, causeCode: errBody.code },
    );
  }
}

async function recordCompletionBilling(input: {
  completionId: string;
  userId: string;
  provider: string;
  model: string;
  usage: RunCompletionOutcome["usage"];
  aborted: boolean;
  error: RunCompletionOutcome["error"];
}) {
  if (!billingOperations.status.configured) return;
  if (input.aborted || input.error) return;
  const amountUsd = normalizePositiveUsd(input.usage?.cost?.total);
  if (amountUsd <= 0) return;

  try {
    const result = await billingOperations.recordUsage({
      userId: input.userId,
      amountUsd,
      tokenType: COHUB_BILLING_TOKEN_TYPES.usdMicroCent,
      usageType: COHUB_BILLING_USAGE_TYPES.generationLlmRaw,
      sourceId: input.completionId,
      operationId: `raw_completion:${input.completionId}`,
      reason: `Raw LLM completion ${input.provider}/${input.model}`,
    });
    if (result.status === "overage") {
      logger.warn("[Billing] raw completion usage recorded as overage", {
        userId: input.userId,
        completionId: input.completionId,
        amountUsd,
        provider: input.provider,
        model: input.model,
      });
    }
  } catch (error) {
    logger.warn("[Billing] failed to record raw completion usage", {
      userId: input.userId,
      completionId: input.completionId,
      amountUsd,
      provider: input.provider,
      model: input.model,
      error,
    });
  }
}

function encodeSse(event: SpaceCompletionStreamEvent) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

router.post("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;

  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) {
    return completionError(c, 404, "space_not_found", "Space not found.");
  }

  if (!(await hasPermission(user, "session.prompt.readonly", { spaceId }))) {
    return authzDenied(c);
  }

  const space = await getSpaceById(spaceId);
  if (!space) return completionError(c, 404, "space_not_found", "Space not found.");

  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return completionError(
      c,
      400,
      "invalid_completion_request",
      "Body must be valid JSON.",
      { reason: "invalid_json" },
    );
  }

  const parsed = createCompletionSchema.safeParse(rawBody);
  if (!parsed.success) {
    const details = zodDetails(parsed.error);
    const shape = summarizeMessagesShape(rawBody);
    return completionError(
      c,
      400,
      "invalid_completion_request",
      formatZodMessage(details),
      {
        issues: details,
        messageCount: shape.messageCount,
        emptyContentCount: shape.emptyContentCount,
        invalidRoleCount: shape.invalidRoleCount,
      },
    );
  }

  const body = parsed.data as CreateSpaceCompletionInput;
  const rawMessageCount = parsed.data.messages.length;
  const messages = normalizeMessages(parsed.data.messages);
  if (messages.length === 0) {
    return completionError(
      c,
      400,
      "messages_required",
      `No valid message content blocks (received ${rawMessageCount}).`,
      {
        messageCount: rawMessageCount,
        normalizedMessageCount: 0,
        reason: "no_valid_content_blocks",
      },
    );
  }

  const stream = Boolean(body.stream);
  const completionId = createCompletionId();
  const startedAt = new Date();

  let systemPromptPath: string | null = null;
  let systemPrompt = "";
  try {
    const loaded = await loadSystemPrompt(spaceId, body.systemPromptPath);
    systemPromptPath = loaded.path;
    systemPrompt = loaded.text;
  } catch (error) {
    if (error instanceof CompletionRequestError) {
      return completionError(c, error.status, error.code, error.message, error.details);
    }
    throw error;
  }

  const resolved = await resolveCompletionModel({
    userId: user.uuid,
    provider: body.provider,
    model: body.model,
  }).catch((error) => {
    logger.error("[Completion] failed to resolve model", error);
    return null;
  });
  if (!resolved) {
    return completionError(c, 502, "models_unavailable", "Models catalog unavailable.");
  }
  if (!resolved.model) {
    const requested = [body.provider, body.model].filter(Boolean).join("/") || "default";
    return completionError(
      c,
      404,
      "model_not_found",
      resolved.error ?? `Model not found: ${requested}`,
      {
        provider: body.provider ?? null,
        model: body.model ?? null,
      },
    );
  }

  const model = resolved.model;
  const registry = resolved.registry;
  const imageToTextConfig = await loadImageToTextConfig(user.uuid).catch((error) => {
    logger.warn("[Completion] image-to-text config unavailable; continuing without fallback", { error });
    return null;
  });

  // Pre-check balance before spending tokens. Fail-open if credit lookup errors.
  const decision = await billingUsageGate.evaluate({
    userId: user.uuid,
    usageKind: "llm.raw_completion",
    source: "raw_completion",
    model: model.id,
    provider: model.provider,
    spaceId,
  });
  if (decision.status === "blocked") {
    const blocked = new BillingAccessBlockedError(decision);
    return c.json(serializeBillingBlocked(blocked), 402);
  }

  const runInput = {
    completionId,
    registry,
    model,
    systemPrompt,
    messages,
    temperature: body.temperature,
    maxTokens: body.maxTokens,
    thinkingLevel: body.thinkingLevel,
    userId: user.uuid,
    spaceId,
    imageToTextConfig,
    signal: c.req.raw.signal,
  };

  const finalize = async (outcome: RunCompletionOutcome) => {
    const completedAt = new Date();
    await recordCompletionBilling({
      completionId,
      userId: user.uuid,
      provider: model.provider,
      model: model.id,
      usage: outcome.usage,
      aborted: outcome.aborted,
      error: outcome.error,
    });
    await Promise.all(outcome.imageToTextCalls.map((call, index) => call.status === "succeeded"
      ? recordCompletionBilling({
          completionId: `${completionId}:image-to-text:${call.messageIndex}:${call.imageIndex}:${index}`,
          userId: user.uuid,
          provider: call.provider,
          model: call.model,
          usage: call.usage,
          aborted: false,
          error: null,
        })
      : Promise.resolve()));
    archiveCompletionBestEffort({
      completionId,
      spaceId,
      userId: user.uuid,
      provider: model.provider,
      model: model.id,
      systemPromptPath,
      systemPrompt,
      request: {
        messages: outcome.archivedMessages,
        contextFallbacks: outcome.imageToTextCalls,
        temperature: body.temperature ?? null,
        maxTokens: body.maxTokens ?? null,
        thinkingLevel: body.thinkingLevel ?? null,
        stream,
      },
      response: {
        message: outcome.message,
        usage: outcome.usage,
        stopReason: outcome.message.stopReason,
        errorMessage: outcome.message.errorMessage ?? null,
      },
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      clientAborted: outcome.aborted,
      error: outcome.error,
    });
  };

  if (!stream) {
    const outcome = await runCompletion(runInput);
    await finalize(outcome);
    if (outcome.error && !outcome.aborted) {
      return completionError(c, 502, outcome.error.code, outcome.error.message);
    }
    const result: SpaceCompletionResult = {
      completionId,
      provider: model.provider,
      model: model.id,
      systemPromptPath,
      message: outcome.message,
      usage: outcome.usage,
      ...(outcome.imageToTextCalls.length > 0 ? { contextFallbacks: outcome.imageToTextCalls } : {}),
    };
    return c.json(result);
  }

  const encoder = new TextEncoder();
  let settled = false;
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (event: SpaceCompletionStreamEvent) => {
        controller.enqueue(encoder.encode(encodeSse(event)));
      };

      // Override meta with actual systemPromptPath.
      push({
        type: "meta",
        completionId,
        provider: model.provider,
        model: model.id,
        systemPromptPath,
      });

      const iterator = streamCompletionEvents(runInput);
      let outcome: RunCompletionOutcome | null = null;
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) {
            outcome = next.value;
            break;
          }
          // Skip the internal meta event; we already sent a corrected one.
          if (next.value.type === "meta") continue;
          push(next.value);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        push({
          type: "error",
          code: "llm_error",
          message,
          completionId,
        });
        outcome = {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            stopReason: "error",
            errorMessage: message,
          },
          usage: null,
          totalUsage: null,
          imageToTextCalls: [],
          archivedMessages: messages,
          raw: null,
          aborted: Boolean(c.req.raw.signal.aborted),
          error: { code: "llm_error", message },
        };
      } finally {
        if (outcome && !settled) {
          settled = true;
          await finalize(outcome);
        }
        controller.close();
      }
    },
    cancel() {
      // Abort is observed via c.req.raw.signal.
    },
  });

  return new Response(readable, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

export default router;
