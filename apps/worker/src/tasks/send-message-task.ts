import type { ContentBlock } from "@cohub/protocol/core";
import type { GenerationPolicy } from "@cohub/protocol/generation";
import type { TaskPayload } from "@cohub/protocol/task";
import { registerTask } from "./registry.js";
import { assignLabelsToSession } from "@cohub/core/labels";
import { assignSessionSourceSystemLabel } from "@cohub/core/labels/session-source";
import { parsePromptEnv, type PromptAccessMode, type PromptAuthContext, type PromptEnv, type SubmitSessionPromptContext } from "@cohub/core/sessions";
import { resolveDelegatedAppScopesAtUseTime } from "@cohub/core/apps";
import { createDrizzlePermissionStore, type Permission } from "@cohub/core/permissions";
import { assertTaskPromptAccess, sanitizeTaskPromptAuth } from "./send-message-auth.js";
import { normalizeSessionTurnOrigin, type SessionTurnIntent } from "@cohub/protocol/model";
import { normalizeRequestSource } from "@cohub/protocol/provenance";
import { getPromptTemplateService } from "../prompt-templates.js";
import { getSkillService } from "../skills.js";
import { getSessionDomainServices } from "../session-services.js";
import { createLogger } from "@cohub/infra/logging";
import { db } from "../db.js";
import { dispatchLabelAssignmentsUpdated } from "../label-events.js";
import { UnrecoverableError } from "bullmq";
import { validatePromptModel } from "../models.js";

const MAX_TASK_SOURCE_LENGTH = 255;

const normalizeTaskSource = (value: unknown) => {
  if (typeof value !== "string") return "scheduled_task";
  const source = value.trim();
  if (!source) return "scheduled_task";
  return source.length > MAX_TASK_SOURCE_LENGTH ? source.slice(0, MAX_TASK_SOURCE_LENGTH) : source;
};

const logger = createLogger({ serviceName: "cohub-worker" });

const sessionPromptService = getSessionDomainServices({
  promptTemplateService: getPromptTemplateService(),
  skillService: getSkillService(),
});

const sendMessageHandler = async (job: import("bullmq").Job, context?: { taskRunId: string }) => {
  const payload = job.data as TaskPayload;
  const requestSource = normalizeRequestSource(payload.data?.requestSource);
  const origin = normalizeSessionTurnOrigin(payload.data?.origin);
  const spaceId = payload.spaceId;
  const { content, sessionId, title, source: payloadSource, model, provider, thinkingLevel, clientMessageId, generationPolicy, accessMode: payloadAccessMode, intent, labelIds, auth, env } = (payload.data ?? {}) as {
    content?: ContentBlock[];
    sessionId?: string;
    title?: string;
    source?: unknown;
    model?: string;
    provider?: string;
    thinkingLevel?: string | null;
    clientMessageId?: string;
    generationPolicy?: GenerationPolicy | null;
    accessMode?: PromptAccessMode | null;
    intent?: SessionTurnIntent | null;
    labelIds?: string[];
    auth?: PromptAuthContext | null;
    env?: PromptEnv | null;
  };

  if (!spaceId) throw new Error("spaceId is required for send_message task");
  if (!content || content.length === 0) throw new Error("content (ContentBlock[]) is required for send_message task");

  const userId = payload.userId?.trim();
  if (!userId) throw new Error("userId is required for send_message task");

  const taskRunId = (context?.taskRunId ?? String(job.id ?? "")).trim();
  if (!taskRunId) throw new Error("taskRunId is required for send_message task");

  const promptEnv = parsePromptEnv(env);
  const modelId = model?.trim();
  const providerId = provider?.trim() || "cohub";
  if (modelId && !(await validatePromptModel({ userId, provider: providerId, model: modelId }))) {
    throw new UnrecoverableError(`Requested model is not available: ${providerId}/${modelId}`);
  }
  const source = normalizeTaskSource(payloadSource);
  const targetSessionId = sessionId?.trim() || null;
  // Consent re-validation runs before any side effect — a dead grant must not
  // create a session, assign labels, or spend the viewer's quota.
  const accessMode = payloadAccessMode ?? "full_access";
  const promptPermission: Permission = accessMode === "read_only" ? "session.prompt.readonly" : "session.prompt.fullaccess";
  const sanitizedAuth = await sanitizeTaskPromptAuth(
    auth ?? null,
    { spaceId, userId, promptPermission },
    (reference) => resolveDelegatedAppScopesAtUseTime({ db, ...reference }),
  );
  await assertTaskPromptAccess(
    { spaceId, sessionId: targetSessionId, userId, promptPermission, auth: sanitizedAuth },
    createDrizzlePermissionStore(db),
  );
  const createdSession = targetSessionId ? null : await sessionPromptService.registerCronjobSession(spaceId, { source, title: title ?? null, userUuid: userId, origin, requestSource });
  const promptSessionId = targetSessionId ?? createdSession?.id;
  if (!promptSessionId) throw new Error("sessionId is required for send_message task");
  const promptClientMessageId = payload.cronJobId?.trim()
    ? `cron:${payload.cronJobId.trim()}:run:${taskRunId}`
    : clientMessageId?.trim() || `taskrun:${taskRunId}`;

  if (labelIds && labelIds.length > 0) {
    await assignLabelsToSession({ db, spaceId, sessionId: promptSessionId, labelIds, userId });
  }
  if (createdSession) {
    await assignSessionSourceSystemLabel({ db, spaceId, sessionId: promptSessionId, source }).then(() =>
      dispatchLabelAssignmentsUpdated({ spaceId, resourceType: "session", resourceRef: promptSessionId, sessionId: promptSessionId }),
    ).catch((error) => {
      logger.warn("[SessionSourceLabel] failed to assign scheduled task source label", error);
    });
  }

  const result = await sessionPromptService.submitPrompt({
    spaceId,
    sessionId: promptSessionId,
    userId,
    clientMessageId: promptClientMessageId,
    content,
    source,
    origin,
    requestSource,
    sourceClientId: requestSource?.clientId,
    model: model ?? null,
    provider: provider ?? null,
    thinkingLevel: thinkingLevel ?? null,
    generationPolicy: generationPolicy ?? null,
    accessMode,
    env: promptEnv,
    intent: intent ?? null,
    context: {
      kind: "scheduled_task",
      taskRunId,
      cronJobId: payload.cronJobId ?? null,
      auth: sanitizedAuth,
    } satisfies SubmitSessionPromptContext,
  });

  return {
    sessionId: promptSessionId,
    spaceId,
    turnId: result.turnId,
    userMessageId: result.userMessageId,
    messageSent: true,
  };
};

registerTask("send_message", sendMessageHandler);
