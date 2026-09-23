import { billingOperations, createBillingUsageGate } from "@cohub/billing";
import { COHUB_AGENT_TURNS_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { getCurrentRequestId, getOrCreateRequestId } from "@cohub/infra/tracing";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import { createSessionServices, HarnessUnavailableError, ModelUnavailableError } from "@cohub/core/sessions";
import { assignSessionParticipantSystemLabels } from "@cohub/core/labels/session-user";
import { createSandboxLifecycleController, getSandboxPromptRecoveryReason } from "@cohub/sandbox-controller";
import { isLocalHarness } from "@cohub/protocol";
import { db } from "./db/index.js";
import { config } from "./config.js";
import { redisCommandClient } from "./redis.js";
import { expandPromptTemplate, type LoadPromptTemplatesOptions, type ExpandedPromptTemplate } from "./prompt-templates.js";
import { expandSkillCommand, type ExpandedSkill, type LoadSkillsOptions } from "./skills.js";
import { ensureSpaceSandbox, recoverSpaceSandbox } from "./space-sandboxes.js";
import { getSpaceSessionById, getSpaceById } from "./space-sessions.js";
import { touchSpaceActivity } from "./space-activity.js";
import { dispatchLabelAssignmentsUpdated, dispatchSessionUpdated, dispatchTurnCreated } from "./realtime-events.js";
import { dispatchTurnUpdated } from "./session-output.js";
import { hydrateTurnAuthorProfiles } from "./session-turns.js";
import { createLogger } from "@cohub/infra/logging";
import { validatePromptModel } from "./llm/models.js";
import { getRuntimeRegistration } from "./runtime.js";


const logger = createLogger({ serviceName: "cohub-api" });
const AGENT_TURN_JOB_NAME = "agent_turns";

export type PromptTemplateService = {
  expand(text: string, options?: LoadPromptTemplatesOptions): Promise<ExpandedPromptTemplate | null>;
};

export type SkillService = {
  expand(text: string, options?: LoadSkillsOptions): Promise<ExpandedSkill | null>;
};

const defaultPromptTemplateService: PromptTemplateService = {
  expand: expandPromptTemplate,
};

const defaultSkillService: SkillService = {
  expand: expandSkillCommand,
};

const agentTurnQueue = createBullmqQueue<{
  spaceId: string;
  sessionId: string;
  reason?: "prompt" | "steer" | "drain" | "retry" | "recovery";
  requestId?: string | null;
  trace?: Record<string, unknown>;
}>(COHUB_AGENT_TURNS_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-api-agent-turns",
});

const sandboxLifecycle = createSandboxLifecycleController({ db, infra: null });
const billingUsageGate = createBillingUsageGate({
  operations: billingOperations,
  onEvaluationError: (error, gateInput) => {
    logger.warn("[BillingGate] fail-open after billing evaluation error", { error, gateInput });
  },
});

let defaultSessionDomainServices: ReturnType<typeof createSessionServices> | null = null;

export function getSessionDomainServices(input?: {
  promptTemplateService?: PromptTemplateService;
  skillService?: SkillService;
}) {
  if (!input?.promptTemplateService && !input?.skillService && defaultSessionDomainServices) {
    return defaultSessionDomainServices;
  }

  const services = createSessionServices({
    db,
    redis: redisCommandClient,
    promptTemplateService: input?.promptTemplateService ?? defaultPromptTemplateService,
    skillService: input?.skillService ?? defaultSkillService,
    billingUsageGate,
    validateLocalHarness: async (prompt) => {
      const harness = prompt.harness;
      if (!isLocalHarness(harness)) throw new HarnessUnavailableError();
      const capabilities = (await getRuntimeRegistration(prompt.spaceId))?.capabilities;
      if (!capabilities?.harnesses.includes(harness)) throw new HarnessUnavailableError();
      if (prompt.model && !capabilities.models.some((model) => model.harness === harness && model.id === prompt.model && (!prompt.provider || model.provider === prompt.provider))) throw new ModelUnavailableError(prompt.provider ?? harness, prompt.model);
    },
    validatePromptModel: ({ userId, provider, model }) => validatePromptModel({ userId, provider, model }),
    sandboxRecovery: {
      maybeRecoverForPrompt: async ({ spaceId, userId, source }) => {
        const sandbox = await sandboxLifecycle.getSandbox(spaceId);
        const reason = getSandboxPromptRecoveryReason(sandbox);
        if (!reason) return;

        const space = await getSpaceById(spaceId);
        if (!space) return;
        if (reason === "missing") {
          await ensureSpaceSandbox({ spaceId, status: "pending", runtimeStatus: "unknown" });
        }

        void recoverSpaceSandbox({
          spaceId,
          userUuid: userId,
          ownerUserUuid: space.userUuid,
          reason,
          source,
          verify: false,
        }).catch((error) => {
          logger.warn(`[SandboxResume] failed to resume sandbox for prompt spaceId=${spaceId} reason=${reason}:`, error);
        });
      },
    },
    injectTrace,
    getRequestId: getCurrentRequestId,
    onSessionTurnCreated: async ({ spaceId, turn: turnRecord }) => {
      const [turn = turnRecord] = await hydrateTurnAuthorProfiles([turnRecord]);
      await dispatchTurnCreated({ spaceId, sessionId: turn.sessionId, turn });
    },
    onSessionTurnUpdated: async ({ spaceId, turn: turnRecord }) => {
      const [turn = turnRecord] = await hydrateTurnAuthorProfiles([turnRecord]);
      await dispatchTurnUpdated({ spaceId, sessionId: turn.sessionId, turn });
    },
    onSessionActivityUpdated: async ({ sessionId, changed }) => {
      const session = await getSpaceSessionById(sessionId);
      if (!session) return;
      await touchSpaceActivity(session.spaceId, session.lastMessageAt ?? new Date()).catch((error) => {
        logger.warn("[SpaceActivity] failed to touch after session activity update", error);
      });
      await dispatchSessionUpdated({ session, changed });
    },
    onSessionParticipantsUpdated: async ({ spaceId, sessionId, userUuids }) => {
      const affectedLabelIds = await assignSessionParticipantSystemLabels({ db, spaceId, sessionId, userUuids });
      await dispatchLabelAssignmentsUpdated({
        spaceId,
        resourceType: "session",
        resourceRef: sessionId,
        sessionId,
        affectedLabelIds,
      });
    },
    agentTurnQueue: {
      enqueue: (job) => agentTurnQueue.add(AGENT_TURN_JOB_NAME, {
        spaceId: job.spaceId,
        sessionId: job.sessionId,
        reason: job.reason,
        requestId: getOrCreateRequestId(job.requestId),
        trace: job.trace,
      }, {
        jobId: job.jobId ?? `agent-session-wakeup-${job.sessionId}`,
        attempts: 2,
        backoff: { type: "fixed", delay: 1000 },
        removeOnComplete: true,
        removeOnFail: defaultJobRetention.removeOnFail,
      }),
    },
    logger: console,
  });

  if (!input?.promptTemplateService) {
    defaultSessionDomainServices = services;
  }
  return services;
}
