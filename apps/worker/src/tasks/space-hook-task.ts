import { QueueEvents } from "bullmq";
import {
  COHUB_AGENT_TURNS_QUEUE,
  createBullmqConnectionOptions,
} from "@cohub/infra/bullmq";
import {
  createAgentTurnsQueue,
  enqueueAgentRunCommandJob,
  type AgentRunCommandJobResult,
} from "@cohub/infra/agent-queue";
import {
  buildHookRunCommand,
  buildSpaceHookDefinitionFingerprint,
  buildSpaceHookEnv,
  buildSpaceHookPromptText,
  loadSpaceHookDefinitions,
  mergeSpaceHookExecutionEnv,
  partitionSpaceHooksForEvent,
  spaceHookMatchesEvent,
  type SpaceHookDefinition,
  type SpaceHookRunResult,
} from "@cohub/core/hooks";
import { resolveSessionTurnOrigin } from "@cohub/core/sessions";
import { turnEventRequestSource } from "@cohub/protocol/model";
import { buildAppActionCommand } from "@cohub/core/apps";
import { SPACE_HOOK_TASK_TYPE, type SpaceHookEventEnvelope } from "@cohub/protocol";
import { APP_ACTION_EXECUTION_SOURCE } from "@cohub/protocol/task";
import type { TaskPayload } from "@cohub/protocol/task";
import type { Job } from "bullmq";
import { and, eq } from "drizzle-orm";
import { apps, spaces, spaceSessions, taskRuns, userProfiles } from "@cohub/db";
import { assignLabelsToSession, assignSessionSourceSystemLabel } from "@cohub/core/labels";
import { createLogger } from "@cohub/infra/logging";
import { config } from "../config.js";
import { db } from "../db.js";
import { getSpaceWorkspaceDir } from "../git.js";
import { redisCommandClient } from "../redis.js";
import { getPromptTemplateService } from "../prompt-templates.js";
import { getSkillService } from "../skills.js";
import { getSessionDomainServices } from "../session-services.js";
import { registerTask } from "./registry.js";

const logger = createLogger({ serviceName: "cohub-worker" });
const agentQueue = createAgentTurnsQueue(config.bullmqRedisUrl, "cohub-worker-space-hook");
let agentQueueEvents: QueueEvents | null = null;
let agentQueueEventsReady: Promise<void> | null = null;
const DEFAULT_TIMEOUT_SECS = 10 * 60;
const MAX_OUTPUT_CHARS = 32 * 1024;

async function getAgentQueueEvents() {
  if (!agentQueueEvents) {
    agentQueueEvents = new QueueEvents(COHUB_AGENT_TURNS_QUEUE, {
      connection: createBullmqConnectionOptions(config.bullmqRedisUrl),
    });
    agentQueueEventsReady = agentQueueEvents.waitUntilReady().then(() => undefined);
  }
  await agentQueueEventsReady;
  return agentQueueEvents;
}

const sessionPromptService = getSessionDomainServices({
  promptTemplateService: getPromptTemplateService(),
  skillService: getSkillService(),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getJobId(job: Job) {
  if (!job.id) throw new Error("Task job has no id");
  return job.id;
}

function clampOutput(value: string) {
  if (value.length <= MAX_OUTPUT_CHARS) return { text: value, truncated: false };
  return {
    text: `${value.slice(0, MAX_OUTPUT_CHARS)}\n… output truncated …`,
    truncated: true,
  };
}

function parseEvent(data: Record<string, unknown>): SpaceHookEventEnvelope {
  const event = isRecord(data.event) ? data.event : null;
  if (!event) throw new Error("space_hook task requires data.event");
  const id = asString(event.id);
  const type = asString(event.type);
  const spaceId = asString(event.spaceId);
  if (!id || !type || !spaceId) throw new Error("space_hook event is missing id/type/spaceId");
  return {
    id,
    type,
    timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
    spaceId,
    sessionId: asString(event.sessionId),
    payload: isRecord(event.payload) ? event.payload : {},
  };
}

async function runPromptHook(input: {
  spaceId: string;
  userId: string;
  taskRunId: string;
  hook: SpaceHookDefinition;
  event: SpaceHookEventEnvelope;
  eventActorUserId: string | null;
  hookEnv: Record<string, string>;
}): Promise<SpaceHookRunResult> {
  if (input.hook.action !== "prompt" || !input.hook.prompt) {
    return {
      path: input.hook.path,
      action: "prompt",
      status: "failed",
      error: "prompt action is missing prompt definition",
    };
  }

  const startedAt = Date.now();
  const prompt = input.hook.prompt;
  const requestSource = turnEventRequestSource(input.event);
  const origin = await resolveSessionTurnOrigin(db, requestSource, "hook");
  let sessionId = prompt.sessionId?.trim() || asString(input.event.sessionId) || null;

  // Validate session belongs to this space to prevent cross-space injection.
  if (sessionId) {
    const [session] = await db
      .select({ spaceId: spaceSessions.spaceId })
      .from(spaceSessions)
      .where(eq(spaceSessions.id, sessionId))
      .limit(1);
    if (!session || session.spaceId !== input.spaceId) {
      return {
        path: input.hook.path,
        action: "prompt",
        status: "failed",
        durationMs: Date.now() - startedAt,
        error: `session ${sessionId} does not belong to space ${input.spaceId}`,
      };
    }
  }

  if (!sessionId) {
    const created = await sessionPromptService.registerCronjobSession(input.spaceId, {
      source: "space_hook",
      title: prompt.title ?? `Hook ${input.hook.path}`,
      userUuid: input.userId,
      requestSource,
      origin,
    });
    sessionId = created.id;
    await assignSessionSourceSystemLabel({ db, spaceId: input.spaceId, sessionId, source: "space_hook" }).catch((error) => {
      logger.warn("[SpaceHooks] failed to assign source label", error);
    });
  }

  if (prompt.labelRefs && prompt.labelRefs.length > 0) {
    await assignLabelsToSession({ db, spaceId: input.spaceId, sessionId, labelIds: prompt.labelRefs, userId: input.userId }).catch((error) => {
      logger.warn("[SpaceHooks] failed to assign label refs", error);
    });
  }

  try {
    const result = await sessionPromptService.submitPrompt({
      spaceId: input.spaceId,
      sessionId,
      userId: input.userId,
      clientMessageId: `space-hook:${input.taskRunId}:${input.hook.path}`,
      content: [{
        type: "text",
        text: buildSpaceHookPromptText({
          promptText: prompt.text,
          env: input.hookEnv,
        }),
      }],
      source: "space_hook",
      requestSource,
      origin,
      model: prompt.model ?? null,
      provider: prompt.provider ?? null,
      thinkingLevel: prompt.thinkingLevel ?? null,
      accessMode: prompt.accessMode ?? "full_access",
      intent: prompt.intent ?? "followup",
      // User-declared hook env only — system COHUB_HOOK_* rides on context.env.
      env: input.hook.env ?? null,
      context: {
        kind: "space_hook",
        taskRunId: input.taskRunId,
        hookPath: input.hook.path,
        eventId: input.event.id,
        eventType: input.event.type,
        ...(input.eventActorUserId ? { eventActorUserId: input.eventActorUserId } : {}),
        env: input.hookEnv,
      },
    });

    return {
      path: input.hook.path,
      action: "prompt",
      status: "completed",
      durationMs: Date.now() - startedAt,
      sessionId,
      turnId: result.turnId ?? null,
      userMessageId: result.userMessageId ?? null,
    };
  } catch (error) {
    logger.warn("[SpaceHooks] prompt hook failed", {
      path: input.hook.path,
      spaceId: input.spaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      path: input.hook.path,
      action: "prompt",
      status: "failed",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type ResolvedUsesCommand = {
  command: string;
  appId: string;
  appVersionId: string;
  action: string;
};

/** Resolve `uses` to the published App version it should run. */
async function resolveUsesCommand(hook: SpaceHookDefinition): Promise<ResolvedUsesCommand | { error: string }> {
  const uses = hook.uses;
  if (!uses) return { error: "uses action is missing app reference" };
  const [row] = await db
    .select({
      id: apps.id,
      status: apps.status,
      targetType: apps.targetType,
      currentVersionId: apps.currentVersionId,
    })
    .from(userProfiles)
    .innerJoin(spaces, and(eq(spaces.userUuid, userProfiles.userUuid), eq(spaces.slug, uses.spaceSlug)))
    .innerJoin(apps, and(eq(apps.spaceId, spaces.id), eq(apps.slug, uses.appSlug)))
    .where(eq(userProfiles.username, uses.username))
    .limit(1);
  const ref = `${uses.username}/${uses.spaceSlug}/${uses.appSlug}`;
  if (!row) return { error: `app not found: ${ref}` };
  if (row.status !== "published" || !row.currentVersionId) return { error: `app is not published: ${ref}` };
  if (row.targetType !== "directory") return { error: `app actions require a directory app: ${ref}` };
  return {
    command: buildAppActionCommand({
      appId: row.id,
      appVersionId: row.currentVersionId,
      action: uses.action,
      actionInput: hook.with ?? null,
    }),
    appId: row.id,
    appVersionId: row.currentVersionId,
    action: uses.action,
  };
}

async function runCommandHook(input: {
  spaceId: string;
  userId: string;
  taskRunId: string;
  /** Parent BullMQ job id (`space-hook-*`); child run_command ids derive from this. */
  parentJobId: string;
  hook: SpaceHookDefinition;
  event: SpaceHookEventEnvelope;
  hookEnv: Record<string, string>;
}): Promise<SpaceHookRunResult> {
  const action = input.hook.action === "uses" ? "uses" : "run";
  const startedAt = Date.now();
  const resolved = action === "uses"
    ? await resolveUsesCommand(input.hook)
    : input.hook.run
      ? { command: buildHookRunCommand(input.hook.run) }
      : { error: "run action is missing run command" };
  if ("error" in resolved) {
    return { path: input.hook.path, action, status: "failed", durationMs: Date.now() - startedAt, error: resolved.error };
  }

  const timeout = input.hook.timeoutSecs ?? DEFAULT_TIMEOUT_SECS;
  // Derive from the parent job id (`space-hook-*`), not the DB UUID, so
  // isReentrantSpaceHookEvent can recognize hook-spawned run_command children.
  const childTaskRunId = `${input.parentJobId}__${input.hook.path.replace(/[^a-zA-Z0-9._-]+/g, "_")}`;
  const uses = "appId" in resolved ? resolved : null;

  try {
    const agentJob = await enqueueAgentRunCommandJob(agentQueue, {
      spaceId: input.spaceId,
      sessionId: input.event.sessionId ?? null,
      taskRunId: childTaskRunId,
      command: resolved.command,
      cwd: "/workspace",
      timeout,
      userId: input.userId,
      ...(uses
        ? {
            source: APP_ACTION_EXECUTION_SOURCE,
            appId: uses.appId,
            appVersionId: uses.appVersionId,
            action: uses.action,
            viewerUserId: input.userId,
          }
        : {}),
      env: mergeSpaceHookExecutionEnv({
        userEnv: input.hook.env,
        hookEnv: input.hookEnv,
      }),
    });
    const queueEvents = await getAgentQueueEvents();
    const result = await agentJob.waitUntilFinished(
      queueEvents,
      (timeout + 60) * 1000,
    ) as AgentRunCommandJobResult;
    const output = clampOutput(result.output ?? "");
    const failed = (result.exitCode ?? 1) !== 0
      || result.outputTruncated === true
      || result.termination?.reason === "timed_out"
      || result.termination?.reason === "aborted";
    return {
      path: input.hook.path,
      action,
      status: failed ? "failed" : "completed",
      exitCode: result.exitCode,
      durationMs: result.durationMs ?? Date.now() - startedAt,
      output: output.text,
      truncated: output.truncated || result.truncated,
      taskRunId: childTaskRunId,
      ...(failed
        ? {
            error: result.termination?.message
              ?? (result.outputTruncated
                ? "hook output was truncated"
                : result.exitCode == null ? "hook command failed" : `exit code ${result.exitCode}`),
          }
        : {}),
    };
  } catch (error) {
    return {
      path: input.hook.path,
      action,
      status: "failed",
      durationMs: Date.now() - startedAt,
      taskRunId: childTaskRunId,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function resolveTaskRunRecordId(jobId: string) {
  const [run] = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(eq(taskRuns.jobId, jobId))
    .limit(1);
  return run?.id ?? null;
}

type MatchedHookReference = {
  path: string;
  fingerprint: string | null;
};

function parseMatchedHooks(data: Record<string, unknown>): MatchedHookReference[] | null {
  if (!Array.isArray(data.matchedHooks)) return null;
  const matched: MatchedHookReference[] = [];
  for (const value of data.matchedHooks) {
    if (!isRecord(value)) return [];
    const path = asString(value.path);
    const fingerprint = asString(value.fingerprint);
    if (!path || !fingerprint || !/^[0-9a-f]{64}$/.test(fingerprint)) return [];
    matched.push({ path, fingerprint });
  }
  return matched;
}

function parseMatchedPaths(data: Record<string, unknown>): string[] | null {
  if (!Array.isArray(data.matchedPaths)) return null;
  const paths = data.matchedPaths
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
  return paths.length > 0 ? paths : [];
}

/** User-visible execution task, enqueued after dispatch matches at least one hook. */
registerTask(SPACE_HOOK_TASK_TYPE, async (job, context) => {
  const payload = job.data as TaskPayload;
  const spaceId = payload.spaceId;
  if (!spaceId) throw new Error("spaceId is required for space_hook task");

  const data = isRecord(payload.data) ? payload.data : {};
  const event = parseEvent(data);
  const eventActorUserId = asString(data.eventActorUserId);
  const ownerUserId = asString(payload.userId);
  const jobId = getJobId(job);
  // Prefer the DB task_runs.id so clients can resolve via GET /api/tasks/:id.
  const taskRunId = context?.taskRunId
    ?? await resolveTaskRunRecordId(jobId)
    ?? jobId;

  if (!ownerUserId) {
    return {
      eventId: event.id,
      eventType: event.type,
      hooks: [] as SpaceHookRunResult[],
      definitionsCount: 0,
      matchedCount: 0,
      skipped: "missing_space_owner",
    };
  }

  const matchedHooks = parseMatchedHooks(data);
  const matchedPaths = matchedHooks === null ? parseMatchedPaths(data) : null;
  if ((matchedHooks && matchedHooks.length === 0) || (matchedPaths && matchedPaths.length === 0)) {
    return {
      eventId: event.id,
      eventType: event.type,
      hooks: [] as SpaceHookRunResult[],
      definitionsCount: 0,
      matchedCount: 0,
      skipped: "no_matched_paths",
    };
  }

  const loaded = await loadSpaceHookDefinitions({
    spaceId,
    workspaceDir: getSpaceWorkspaceDir(spaceId),
    redis: redisCommandClient,
  });
  const byPath = new Map(loaded.definitions.map((definition) => [definition.path, definition]));
  const legacyPartition = matchedHooks === null && matchedPaths === null
    ? partitionSpaceHooksForEvent(loaded.definitions, event)
    : null;
  const references: MatchedHookReference[] = matchedHooks
    ?? matchedPaths?.map((path) => ({ path, fingerprint: null }))
    ?? legacyPartition?.matched.map((definition) => ({ path: definition.path, fingerprint: null }))
    ?? [];

  const toRun: SpaceHookDefinition[] = [];
  const preflight: SpaceHookRunResult[] = legacyPartition?.skipped.map((item) => ({
    ...item,
    status: "skipped",
  })) ?? [];
  for (const reference of references) {
    const definition = byPath.get(reference.path);
    if (!definition) {
      preflight.push({
        path: reference.path,
        status: "failed",
        error: "hook definition no longer available",
      });
      continue;
    }
    if (
      reference.fingerprint
      && buildSpaceHookDefinitionFingerprint(definition) !== reference.fingerprint
    ) {
      preflight.push({
        path: reference.path,
        action: definition.action,
        status: "failed",
        error: "hook definition changed after dispatch",
      });
      continue;
    }
    const match = spaceHookMatchesEvent(definition, event);
    if (!match.matched) {
      preflight.push({
        path: reference.path,
        action: definition.action,
        status: "skipped",
        reason: match.reason ?? "not_matched",
      });
      continue;
    }
    toRun.push(definition);
  }

  // Per-hook try/catch already isolates failures; never throw here so BullMQ
  // does not retry and re-execute successful sibling hooks.
  const executed = await Promise.all(
    toRun.map((definition) => {
      const hookEnv = buildSpaceHookEnv({
        event,
        hookPath: definition.path,
        taskRunId,
        eventActorUserId,
        executionUserId: ownerUserId,
      });
      return definition.action === "prompt"
        ? runPromptHook({
            spaceId,
            userId: ownerUserId,
            taskRunId,
            hook: definition,
            event,
            eventActorUserId,
            hookEnv,
          })
        : runCommandHook({
            spaceId,
            userId: ownerUserId,
            taskRunId,
            parentJobId: jobId,
            hook: definition,
            event,
            hookEnv,
          });
    }),
  );

  const hooks = [...preflight, ...executed];
  const failed = hooks.filter((item) => item.status === "failed");
  if (failed.length > 0) {
    logger.warn("[SpaceHooks] hook failures recorded in result", {
      spaceId,
      eventId: event.id,
      eventType: event.type,
      failures: failed.map((item) => ({ path: item.path, error: item.error })),
    });
  }

  return {
    eventId: event.id,
    eventType: event.type,
    hooks,
    definitionsCount: loaded.definitions.length,
    matchedCount: references.length,
    cache: loaded.cache,
  };
});
