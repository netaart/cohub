import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { recordJobFailure } from "@cohub/infra/bullmq";
import { getAgentTracer, wrapToolCall } from "@cohub/infra/tracing/agent";
import {
  buildRunCommandToolContent,
  buildRunCommandRunningProgress,
  type RunCommandTermination,
  MAX_RUN_COMMAND_TIMEOUT_SECONDS,
  RUN_COMMAND_TIMEOUT_SECONDS,
  RUN_COMMAND_TOOL_NAME,
} from "@cohub/core/commands";
import type { AgentRunCommandJobResult } from "./queue.js";
import { createSandboxCodingTools } from "./sandbox/tools.js";
import { runWithToolExecutionContext } from "./tool-context.js";
import { logger } from "./logger.js";
import type { AgentRunCommandJobData } from "./queue.js";
import { createAgentExecutionToken } from "./execution-grants.js";
import { normalizePermissionScopes } from "@cohub/core/permissions";
import { getAbortEvent } from "./abort.js";
import { clearActiveAbortController, setActiveAbortController, setActiveAbortEvent } from "./active-turns.js";
import { loadSpaceEnvSnapshot } from "./runtime/env-cache.js";

const tools = createSandboxCodingTools();
const tracer = getAgentTracer();

function extractToolResultText(result: unknown) {
  if (!result || typeof result !== "object") return "";
  const record = result as Record<string, unknown>;
  const details = record.details && typeof record.details === "object" && !Array.isArray(record.details)
    ? record.details as Record<string, unknown>
    : null;
  if (typeof details?.rawOutput === "string") return details.rawOutput;
  const content = record.content;
  if (!Array.isArray(content)) return typeof content === "string" ? content : "";
  return content
    .map((item) => item && typeof item === "object" && (item as { type?: unknown }).type === "text"
      ? String((item as { text?: unknown }).text ?? "")
      : "")
    .join("");
}

function getExitCode(result: unknown) {
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const exitCode = (details as { exitCode?: unknown }).exitCode;
  return typeof exitCode === "number" ? exitCode : null;
}

function getTermination(result: unknown): RunCommandTermination | null {
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return null;
  const termination = (details as { termination?: unknown }).termination;
  if (!termination || typeof termination !== "object" || Array.isArray(termination)) return null;
  const reason = (termination as { reason?: unknown }).reason;
  if (reason !== "exited" && reason !== "timed_out" && reason !== "aborted") return null;
  const exitCode = (termination as { exitCode?: unknown }).exitCode;
  const timeoutSecs = (termination as { timeoutSecs?: unknown }).timeoutSecs;
  const message = (termination as { message?: unknown }).message;
  const outputTruncated = (termination as { outputTruncated?: unknown }).outputTruncated;
  return {
    reason: reason as RunCommandTermination["reason"],
    exitCode: typeof exitCode === "number" ? exitCode : null,
    ...(typeof timeoutSecs === "number" ? { timeoutSecs } : {}),
    ...(typeof message === "string" ? { message } : {}),
    ...(typeof outputTruncated === "boolean" ? { outputTruncated } : {}),
  };
}

function getOutputTruncation(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const record = result as { outputTruncated?: unknown; details?: unknown };
  if (record.outputTruncated === true) return true;
  const details = record.details;
  if (!details || typeof details !== "object") return false;
  return Boolean((details as { truncation?: unknown }).truncation);
}

function getTransportOutputTruncation(result: unknown) {
  if (!result || typeof result !== "object") return false;
  const record = result as { outputTruncated?: unknown; details?: unknown };
  if (record.outputTruncated === true) return true;
  const details = record.details;
  return Boolean(details && typeof details === "object" && (details as { outputTruncated?: unknown }).outputTruncated === true);
}

function getFailureDetails(result: unknown) {
  if (!result || typeof result !== "object") return null;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object" || Array.isArray(details)) return null;
  return (details as { isError?: unknown }).isError === true ? (details as Record<string, unknown>) : null;
}

function clampTimeout(timeout: unknown) {
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return RUN_COMMAND_TIMEOUT_SECONDS;
  return Math.min(Math.floor(timeout), MAX_RUN_COMMAND_TIMEOUT_SECONDS);
}

export async function processRunCommandJob(job: Job<AgentRunCommandJobData>): Promise<AgentRunCommandJobResult> {
  const data = job.data;
  if (!data.spaceId || !data.taskRunId || !data.command || !data.cwd) {
    throw new Error("Invalid run_command job payload");
  }

  const bashTool = tools.find((tool) => tool.name === "bash");
  if (!bashTool) throw new Error("bash tool is not available");

  const toolCallId = `run_command_${randomUUID()}`;
  const timeout = clampTimeout(data.timeout);
  const contextSessionId = data.origin?.sessionId ?? data.sessionId ?? "";
  const actorUserId = data.userId?.trim();
  const executionScopes = normalizePermissionScopes(data.executionScopes ?? []);
  const executionToken = actorUserId
    ? await createAgentExecutionToken({
        actorUserId,
        viewerUserId: data.viewerUserId ?? null,
        appId: data.appId ?? null,
        appVersionId: data.appVersionId ?? null,
        action: data.action ?? null,
        taskRunId: data.taskRunId,
        spaceId: data.spaceId,
        sessionId: contextSessionId || null,
        turnId: data.origin?.turnId ?? null,
        source: data.source?.trim() || "run_command",
        scopes: executionScopes,
      })
    : null;
  const spaceEnv = await loadSpaceEnvSnapshot(data.spaceId);
  let latestOutput = "";
  let lastProgressAt = 0;
  let lastProgressSignature = "";
  const originTurnId = data.origin?.turnId?.trim() || null;
  const abortController = new AbortController();
  if (originTurnId) {
    setActiveAbortController(originTurnId, abortController);
    const pendingAbortEvent = await getAbortEvent(originTurnId);
    if (pendingAbortEvent?.reason === "abort") {
      setActiveAbortEvent(pendingAbortEvent);
      abortController.abort();
    }
  }

  const startAt = Date.now();
  const pushProgress = async (phase: "queued" | "running", done = false, exitCode: number | null = null, durationMs = 0, termination?: RunCommandTermination | null): Promise<void> => {
    const progress = done
      ? {
          kind: "run_command" as const,
          phase,
          content: buildRunCommandToolContent({
            toolCallId,
            command: data.command,
            cwd: data.cwd,
            output: latestOutput,
            status: "done",
            exitCode,
            termination,
            durationMs,
          }),
        }
      : buildRunCommandRunningProgress({
          toolCallId,
          command: data.command,
          cwd: data.cwd,
          output: latestOutput,
        });
    const signature = JSON.stringify(progress);
    const now = Date.now();
    if (!done && signature === lastProgressSignature && now - lastProgressAt < 750) return;
    lastProgressSignature = signature;
    lastProgressAt = now;
    await job.updateProgress(progress);
  };

  try {
    return await runWithToolExecutionContext({
      spaceId: data.spaceId,
      sessionId: contextSessionId,
      turnId: data.origin?.turnId,
      actorUserId: data.userId ?? null,
      executionToken,
      executionScopes,
      sourceClientId: data.sourceClientId ?? null,
      model: data.model ?? null,
      generationPolicy: data.generationPolicy ?? null,
      spaceEnv,
      env: data.env ?? null,
      llmRound: 0,
      toolCallId,
      requestId: data.requestId ?? undefined,
      abortSignal: abortController.signal,
    }, async () => wrapToolCall(tracer, {
      toolName: RUN_COMMAND_TOOL_NAME,
      input: { command: data.command, cwd: data.cwd, taskRunId: data.taskRunId },
      spaceId: data.spaceId,
      sessionId: contextSessionId,
      llmRound: 0,
      toolCallId,
      requestId: data.requestId ?? undefined,
    }, async () => {
    await pushProgress("queued");
    try {
      const result = await bashTool.execute(
        toolCallId,
        { command: data.command, timeout } as never,
        abortController.signal,
        (partial: unknown) => {
          const text = extractToolResultText(partial);
          if (text) latestOutput = text;
          void pushProgress("running");
        },
      );
      const failure = getFailureDetails(result);
      if (failure) {
        throw new Error(typeof failure.message === "string" ? failure.message : "Command infrastructure failure");
      }
      latestOutput = extractToolResultText(result) || latestOutput;
      const exitCode = getExitCode(result);
      const terminationBase = getTermination(result) ?? { reason: "exited" as const, exitCode };
      const outputTruncated = getTransportOutputTruncation(result) || terminationBase.outputTruncated === true;
      const termination = outputTruncated && !terminationBase.outputTruncated
        ? { ...terminationBase, outputTruncated: true }
        : terminationBase;
      const truncated = getOutputTruncation(result) || outputTruncated;
      const durationMs = Date.now() - startAt;
      const content = buildRunCommandToolContent({
        toolCallId,
        command: data.command,
        cwd: data.cwd,
        output: latestOutput,
        status: "done",
        exitCode,
        termination,
        durationMs,
      });
      await pushProgress("running", true, exitCode, durationMs, termination);
      return {
        ok: true,
        exitCode,
        termination,
        durationMs,
        output: latestOutput,
        truncated,
        outputTruncated,
        content,
      } satisfies AgentRunCommandJobResult;
    } catch (error) {
      if (abortController.signal.aborted) {
        const durationMs = Date.now() - startAt;
        const termination: RunCommandTermination = { reason: "aborted", exitCode: null, message: "Command aborted." };
        const content = buildRunCommandToolContent({
          toolCallId,
          command: data.command,
          cwd: data.cwd,
          output: latestOutput,
          status: "done",
          exitCode: null,
          termination,
          durationMs,
        });
        await pushProgress("running", true, null, durationMs, termination);
        return {
          ok: true,
          exitCode: null,
          termination,
          durationMs,
          output: latestOutput,
          truncated: false,
          content,
        } satisfies AgentRunCommandJobResult;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      await recordJobFailure(job, error, {
        reason: "run_command_failed",
        meta: {
          spaceId: data.spaceId,
          taskRunId: data.taskRunId,
          cwd: data.cwd,
          outputTail: latestOutput.slice(-2000),
        },
      });
      logger.warn(`[RunCommand] infrastructure failure spaceId=${data.spaceId} taskRunId=${data.taskRunId}: ${errorMessage}`);
      throw error;
    }
    }));
  } finally {
    if (originTurnId) clearActiveAbortController(originTurnId, abortController);
  }
}
