import { rename, rm, stat } from "node:fs/promises";
import { recordJobFailure } from "@cohub/infra/bullmq";
import { extractTrace, runInActiveSpan } from "@cohub/infra/tracing/propagator";
import { getAgentTracer } from "@cohub/infra/tracing/agent";
import { sessionMessages, sessionTurns, sessionTurnSegments } from "@cohub/db";
import { and, asc, eq, gte, lte, or, sql } from "drizzle-orm";
import { db } from "./db.js";
import { appendTerminalGenerationMessages } from "./generation-session-sync.js";
import { getAgentSessionFilePath, getAgentSpaceSessionsPath, getAgentWorkspacePath } from "./runtime/paths.js";
import { SessionManager } from "./runtime/local-session-manager.js";
import type { AgentSessionForkJobData } from "./queue.js";

const tracer = getAgentTracer();

async function appendVisibleGenerationMessages(input: {
  sessionId: string;
  anchorSequence: number;
  sessionManager: SessionManager;
}) {
  const segments = await db.select().from(sessionTurnSegments)
    .where(eq(sessionTurnSegments.sessionId, input.sessionId))
    .orderBy(asc(sessionTurnSegments.ordinal));
  const rangePredicates = segments.flatMap((segment) => {
    const toSequence = Math.min(segment.toSequence ?? input.anchorSequence, input.anchorSequence);
    if (toSequence < segment.fromSequence) return [];
    return [and(
      eq(sessionMessages.sessionId, segment.sourceSessionId),
      eq(sessionTurns.sessionId, segment.sourceSessionId),
      gte(sessionTurns.sequence, segment.fromSequence),
      lte(sessionTurns.sequence, toSequence),
    )];
  });
  const visibleRange = or(...rangePredicates);
  if (!visibleRange) return;

  const rows = await db.select({ message: sessionMessages }).from(sessionMessages)
    .innerJoin(sessionTurns, eq(sessionMessages.turnId, sessionTurns.id))
    .where(and(
      eq(sessionTurns.executionKind, "direct_generation"),
      sql`${sessionMessages.meta}->>'messageKind' in ('generation_request', 'generation_result')`,
      visibleRange,
    ))
    .orderBy(asc(sessionTurns.sequence), asc(sessionMessages.sequence));

  await appendTerminalGenerationMessages(rows.map((row) => row.message), input.sessionManager);
}

async function provisionForkFile(data: AgentSessionForkJobData) {
  const parentSessionFile = getAgentSessionFilePath(data.spaceId, data.parentSessionId);
  const childSessionFile = getAgentSessionFilePath(data.spaceId, data.sessionId);
  const workingSessionFile = `${childSessionFile}.forking`;
  const sessionsDir = getAgentSpaceSessionsPath(data.spaceId);
  const errors: unknown[] = [];
  let parentManager: SessionManager | null = null;
  let sessionManager: SessionManager | null = null;
  let result: { sessionId: string; branchFile: string } | null = null;

  if (data.anchorEntryId && !(await stat(parentSessionFile).then(() => true, () => false))) {
    return { sessionId: data.sessionId, branchFile: childSessionFile };
  }

  try {
    await rm(workingSessionFile, { force: true });
    if (data.anchorEntryId) {
      parentManager = await SessionManager.open(parentSessionFile, sessionsDir);
      const branchFile = await parentManager.createBranchedSession(data.anchorEntryId, {
        id: data.sessionId,
        filePath: workingSessionFile,
        parentSession: parentSessionFile,
      });
      if (!branchFile) throw new Error("Failed to create forked session file");
      sessionManager = await SessionManager.open(branchFile, sessionsDir);
    } else {
      sessionManager = SessionManager.create(getAgentWorkspacePath(data.spaceId), sessionsDir);
      sessionManager.newSession({ id: data.sessionId, parentSession: parentSessionFile });
      sessionManager.setSessionFile(workingSessionFile);
    }

    await appendVisibleGenerationMessages({
      sessionId: data.sessionId,
      anchorSequence: data.anchorSequence,
      sessionManager,
    });
    result = { sessionId: data.sessionId, branchFile: childSessionFile };
  } catch (error) {
    errors.push(error);
  } finally {
    for (const manager of [sessionManager, parentManager]) {
      if (!manager) continue;
      try {
        await manager.close();
      } catch (error) {
        errors.push(error);
      }
    }
  }

  if (errors.length === 0) {
    try {
      await rename(workingSessionFile, childSessionFile);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    try {
      await rm(workingSessionFile, { force: true });
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Failed to provision fork session file");
  if (!result) throw new Error("Failed to provision fork session file");
  return result;
}

export async function processSessionForkJob(job: import("bullmq").Job<AgentSessionForkJobData>) {
  const data = job.data;
  const queueWaitMs = getQueueWaitMs(job);
  const parentCtx = extractTrace((data.trace ?? data) as Record<string, unknown>);
  return runInActiveSpan(tracer, "agent.session_fork.process", {
    attributes: {
      "cohub.request_id": data.requestId ?? "",
      "cohub.space_id": data.spaceId,
      "cohub.session_id": data.sessionId,
      "agent.parent_session_id": data.parentSessionId,
      "agent.anchor_turn_id": data.anchorTurnId,
      "agent.anchor_sequence": data.anchorSequence,
      "agent.anchor_entry_id": data.anchorEntryId ?? "",
      "job.id": job.id ?? "",
      "job.attempt": job.attemptsMade ?? 0,
      ...(job.timestamp ? { "agent.queue.enqueued_at_ms": job.timestamp } : {}),
      ...(job.processedOn ? { "agent.queue.processed_on_ms": job.processedOn } : {}),
      ...(job.delay ? { "agent.queue.delay_ms": job.delay } : {}),
      ...(queueWaitMs != null ? { "agent.queue.wait_ms": queueWaitMs } : {}),
    },
  }, parentCtx, async () => {
    try {
      return await provisionForkFile(data);
    } catch (error) {
      await recordJobFailure(job, error, {
        reason: "session_fork_failed",
        meta: {
          spaceId: data.spaceId,
          sessionId: data.sessionId,
          parentSessionId: data.parentSessionId,
          anchorTurnId: data.anchorTurnId,
          anchorEntryId: data.anchorEntryId,
        },
      });
      throw error;
    }
  });
}

function getQueueWaitMs(job: { timestamp?: number; processedOn?: number }) {
  if (!job.timestamp) return null;
  const processedAt = job.processedOn && job.processedOn >= job.timestamp ? job.processedOn : Date.now();
  return Math.max(0, processedAt - job.timestamp);
}
