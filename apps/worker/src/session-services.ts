import { billingOperations, createBillingUsageGate } from "@cohub/billing";
import { COHUB_AGENT_TURNS_QUEUE, createBullmqQueue, defaultJobRetention } from "@cohub/infra/bullmq";
import { injectTrace } from "@cohub/infra/tracing/propagator";
import { createSessionServices } from "@cohub/core/sessions";
import { assignSessionParticipantSystemLabels } from "@cohub/core/labels/session-user";
import { db } from "./db.js";
import { redisCommandClient } from "./redis.js";
import { config } from "./config.js";
import type { PromptTemplateService } from "./prompt-templates.js";
import type { SkillService } from "./skills.js";
import { dispatchLabelAssignmentsUpdated } from "./label-events.js";
import { enqueueReferences } from "./reference-index-queue.js";
import { dispatchTurnCreated, dispatchTurnUpdated } from "./realtime-events.js";

const AGENT_TURN_JOB_NAME = "agent_turns";

const billingUsageGate = createBillingUsageGate({
  operations: billingOperations,
  onEvaluationError: (error, gateInput) => {
    console.warn("[BillingGate] fail-open after worker prompt billing evaluation error", { error, gateInput });
  },
});

const agentTurnQueue = createBullmqQueue<{
  spaceId: string;
  sessionId: string;
  reason?: "prompt" | "steer" | "drain" | "retry" | "recovery" | "generation_complete" | "generation_failed";
  requestId?: string | null;
  trace?: Record<string, unknown>;
}>(COHUB_AGENT_TURNS_QUEUE, {
  redisUrl: config.bullmqRedisUrl,
  telemetryServiceName: "cohub-worker-agent-turns",
});

export async function wakeAgentSession(spaceId: string, sessionId: string, reason: "generation_complete" | "generation_failed" = "generation_complete") {
  await agentTurnQueue.add(AGENT_TURN_JOB_NAME, { spaceId, sessionId, reason }, {
    jobId: `agent-generation-wakeup-${sessionId}-${crypto.randomUUID()}`,
    attempts: 2,
    backoff: { type: "fixed", delay: 1000 },
    removeOnComplete: true,
    removeOnFail: defaultJobRetention.removeOnFail,
  });
}

export function getSessionDomainServices(input: {
  promptTemplateService: PromptTemplateService;
  skillService?: SkillService;
}) {
  return createSessionServices({
    db,
    enqueueReferences,
    redis: redisCommandClient,
    promptTemplateService: input.promptTemplateService,
    skillService: input.skillService,
    billingUsageGate,
    injectTrace,
    getRequestId: () => null,
    onSessionTurnCreated: dispatchTurnCreated,
    onSessionTurnUpdated: dispatchTurnUpdated,
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
        requestId: job.requestId,
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
}
