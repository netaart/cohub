import { randomUUID } from "node:crypto";
import {
  createBashTool,
  createToolFailure,
  createThrottledTextToolUpdate,
  DEFAULT_MAX_BYTES,
  createEditTool,
  createFindTool,
  createGrepToolDefinition,
  createLsTool,
  createReadTool,
  createWriteTool,
  applyEditsToContent,
  type BashOperations,
  type BashExecutionResult,
  type EditOperations,
  type FindOperations,
  type GrepToolInput,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "../runtime/tools/index.js";
import {
  detectUnsupportedReadImageMimeType,
  isSupportedReadImageMimeType,
  unsupportedReadImageMimeTypeMessage,
} from "../runtime/tools/read-file-types.js";
import {
  createLocalCrossSpaceFindTool,
  createLocalCrossSpaceGrepTool,
  createLocalCrossSpaceLsTool,
  createLocalCrossSpaceReadTool,
} from "../runtime/tools/local-cross-space-query-tools.js";
import { formatRgJsonGrepResult } from "../runtime/tools/grep-json-format.js";
import {
  chunkGrepFileArgs,
  extractRequiredGrepLiterals,
  filterGrepCandidatesByGlob,
  joinGrepCandidatePath,
} from "../runtime/tools/grep-index-candidates.js";


import { encodeGenerationPolicy, GENERATION_POLICY_ENV_KEY } from "@cohub/protocol/generation";
import type { TaskPayload } from "@cohub/protocol/task";
import { RUN_COMMAND_TASK_TYPE } from "@cohub/core/commands";
import { enqueueTaskRun } from "@cohub/core/tasks";
import { COHUB_TASKS_QUEUE, createBullmqQueue } from "@cohub/infra/bullmq";
import type { RpcMethod, RpcRequestMap } from "@cohub/protocol/sandbox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { wrapToolCall, wrapSandboxRpc, getAgentTracer } from "@cohub/infra/tracing/agent";
import { createSandboxLifecycleController } from "@cohub/sandbox-controller";
import {
  getAgentPlatformAgentsPath,
  getAgentPlatformConfigPath,
  getAgentWorkspacePath,
  SANDBOX_PLATFORM_AGENTS_PATH,
  SANDBOX_WORKSPACE_PATH,
} from "../runtime/paths.js";
import { getCurrentSessionExecutionAuth } from "../runtime/session-execution-auth.js";
import { getCurrentToolExecutionContext, runWithToolExecutionContext, type TurnTelemetryMetrics } from "../tool-context.js";
import { resolveSpaceFileVisibility } from "../runtime/cross-space-query-access.js";
import { createWorkspaceVisibilityFilter, type AgentFileVisibility, type AgentWorkspaceVisibilityFilter } from "../runtime/workspace-visibility.js";
import {
  createSpaceAwareFindTool,
  createSpaceAwareGrepTool,
  createSpaceAwareLsTool,
  createSpaceAwareReadTool,
} from "../runtime/tools/space-aware-query-tools.js";
import { type SandboxConnection, disconnectSandboxWsClient } from "@cohub/sandbox-client";
import {
  getSandboxRpcFailurePresentation,
  isSandboxRpcError,
  SANDBOX_NOT_READY_MESSAGE,
  SandboxRpcError,
  type SandboxRpcDiagnostics,
} from "@cohub/sandbox-client";

import { ensureSandboxConnection, pruneSandboxConnections } from "../sandbox-pool.js";
import { getSpaceSandbox, recoverSpaceSandbox } from "../api.js";
import { classifySandboxInfrastructureError, type SandboxInfrastructureError } from "@cohub/sandbox-client";
import { logger } from "../logger.js";
import { registerActiveAbortHandle } from "../active-turns.js";
import { db } from "../db.js";
import { dispatchTaskCreated } from "../realtime-events.js";
import { env as agentEnv } from "../env.js";

const taskQueue = createBullmqQueue(COHUB_TASKS_QUEUE, {
  redisUrl: agentEnv.BULLMQ_REDIS_URL,
  telemetryServiceName: "cohub-agent-background-bash",
});

const sandboxLifecycle = createSandboxLifecycleController({ db, infra: null });
const SANDBOX_PROVIDER_CACHE_TTL_MS = 30_000;
const sandboxProviderCache = new Map<string, { provider: "cloud" | "local"; expiresAt: number }>();

type ToolRpcContext = {
  spaceId: string;
  sessionId?: string | null;
  turnId?: string | null;
  turnSeq?: number | null;
  llmRound?: number | null;
  toolCallId?: string | null;
  requestId?: string | null;
};

type ToolTraceContext = {
  spaceId?: string;
  sessionId?: string;
  turnId?: string;
  turnSeq?: number;
  llmRound?: number;
  toolCallId?: string;
  requestId?: string;
};

type TracedRpcOptions = {
  onEvent?: (event: import("@cohub/protocol/sandbox").RpcEventPayload) => void;
  context?: ToolRpcContext;
};

function getCurrentTraceContext(): ToolTraceContext {
  const ctx = getCurrentToolExecutionContext();
  return {
    spaceId: ctx?.spaceId,
    sessionId: ctx?.sessionId ?? undefined,
    turnId: ctx?.turnId ?? undefined,
    turnSeq: ctx?.turnSeq ?? undefined,
    llmRound: ctx?.llmRound ?? undefined,
    toolCallId: ctx?.toolCallId ?? undefined,
    requestId: ctx?.requestId ?? undefined,
  };
}

function captureToolRpcContext(overrides: Partial<ToolRpcContext> & { spaceId?: string } = {}): ToolRpcContext {
  const ctx = getCurrentToolExecutionContext();
  const spaceId = overrides.spaceId ?? ctx?.spaceId;
  if (!spaceId) throw new Error("Tool execution context is missing spaceId");
  return {
    spaceId,
    sessionId: overrides.sessionId ?? ctx?.sessionId ?? null,
    turnId: overrides.turnId ?? ctx?.turnId ?? null,
    turnSeq: overrides.turnSeq ?? ctx?.turnSeq ?? null,
    llmRound: overrides.llmRound ?? ctx?.llmRound ?? null,
    toolCallId: overrides.toolCallId ?? ctx?.toolCallId ?? null,
    requestId: overrides.requestId ?? ctx?.requestId ?? null,
  };
}

function incrementToolCallCount(metrics: TurnTelemetryMetrics | undefined) {
  if (!metrics) return;
  metrics.toolCallCount += 1;
}

function getEffectiveAbortSignal(signal?: AbortSignal) {
  const turnSignal = getCurrentToolExecutionContext()?.abortSignal;
  if (signal && turnSignal) return AbortSignal.any([signal, turnSignal]);
  return signal ?? turnSignal;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
}

function truncateLogValue(value: string, limit = 500) {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function formatDiagnostics(diagnostics: SandboxRpcDiagnostics | undefined) {
  if (!diagnostics) return "";
  const entries = Object.entries(diagnostics).filter(([, value]) => value != null);
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ");
}

function formatTraceContextForLog() {
  const ctx = getCurrentTraceContext();
  return [
    ctx.spaceId ? `spaceId=${ctx.spaceId}` : null,
    ctx.sessionId ? `sessionId=${ctx.sessionId}` : null,
    ctx.turnId ? `turnId=${ctx.turnId}` : null,
    ctx.toolCallId ? `toolCallId=${ctx.toolCallId}` : null,
    ctx.requestId ? `requestId=${ctx.requestId}` : null,
  ].filter(Boolean).join(" ");
}

function getCurrentSpaceId() {
  const ctx = getCurrentToolExecutionContext();
  if (!ctx?.spaceId) {
    throw new Error("Tool execution context is missing spaceId");
  }
  return ctx.spaceId;
}

function getSpaceWorkspaceDir(spaceId: string) {
  return getAgentWorkspacePath(spaceId);
}

function toPosixPath(value: string) {
  return value.replace(/\\/g, "/");
}

function mapLocalAbsolutePathToSandboxPath(absolutePath: string) {
  const normalized = toPosixPath(absolutePath);
  const workspaceRoot = toPosixPath(getSpaceWorkspaceDir(getCurrentSpaceId()));
  const platformAgentsRoot = toPosixPath(getAgentPlatformAgentsPath());
  const platformRoot = toPosixPath(getAgentPlatformConfigPath());

  if (normalized === workspaceRoot) {
    return SANDBOX_WORKSPACE_PATH;
  }
  if (normalized.startsWith(`${workspaceRoot}/`)) {
    const relativePath = normalized.slice(workspaceRoot.length + 1);
    return `${SANDBOX_WORKSPACE_PATH}/${relativePath}`;
  }

  if (normalized === platformAgentsRoot) {
    return SANDBOX_PLATFORM_AGENTS_PATH;
  }
  if (normalized.startsWith(`${platformAgentsRoot}/`)) {
    const relativePath = normalized.slice(platformAgentsRoot.length + 1);
    return `${SANDBOX_PLATFORM_AGENTS_PATH}/${relativePath}`;
  }

  if (normalized === platformRoot || normalized.startsWith(`${platformRoot}/`)) {
    throw new Error(`Platform path is not tool-visible in sandbox: ${absolutePath}`);
  }

  if (normalized.startsWith("/")) {
    return normalized;
  }

  throw new Error(`Unable to map non-absolute path into sandbox: ${absolutePath}`);
}

function mapSandboxInputPath(path: string | undefined) {
  // grep path comes directly from model input and should follow sandbox path semantics:
  // relative paths resolve from the tool cwd (/workspace by default), while absolute
  // paths are interpreted inside the sandbox as-is.
  if (!path || path.trim() === "") return ".";
  if (path === ".") return ".";
  if (path.startsWith("/")) return path;
  return path;
}

async function getCurrentConnection(method: RpcMethod | string = "sandbox.connect") {
  const spaceId = getCurrentSpaceId();
  try {
    return await ensureSandboxConnection(spaceId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn(`[SandboxWS] unavailable while waiting for connection spaceId=${spaceId}:`, error);
    throw new SandboxRpcError(SANDBOX_NOT_READY_MESSAGE, {
      method,
      rpcErrorCode: "IO_ERROR",
      retryable: true,
      transportReason: `connect_failed: ${message}`,
    });
  }
}

async function waitForRecoveredSandboxConnection(spaceId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError: unknown = null;

  while (Date.now() < deadline) {
    try {
      return await ensureSandboxConnection(spaceId, { timeoutMs: Math.min(15_000, Math.max(1_000, deadline - Date.now())) });
    } catch (error) {
      lastError = error;
      attempt += 1;
      if (Date.now() >= deadline) break;
      const delayMs = Math.min(1_000 * 2 ** Math.min(attempt, 4), 5_000);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Timed out waiting for recovered sandbox connection for ${spaceId}`);
}

async function recoverAndRetryAfterInfraError<T>(spaceId: string, error: SandboxInfrastructureError, retry: () => Promise<T>) {
  logger.warn(`[SandboxRecovery] ${error.code} detected spaceId=${spaceId} mount=${error.mountPath ?? "unknown"}; triggering recovery`);
  disconnectSandboxWsClient(spaceId, `sandbox recovery requested: ${error.code}`);
  const result = await recoverSpaceSandbox({ spaceId, reason: error.code, source: "agent" });
  if (!result?.ok) {
    throw new Error(`Sandbox recovery failed after ${error.code}: ${result?.message ?? error.message}`);
  }
  await waitForRecoveredSandboxConnection(spaceId);
  return retry();
}

export async function tracedRpc<M extends RpcMethod>(
  connection: SandboxConnection,
  method: M,
  params: RpcRequestMap[M]["params"],
  options?: TracedRpcOptions,
  retryInfraError = true,
): Promise<RpcRequestMap[M]["result"]> {
  const tracer = getAgentTracer();
  const traceCtx = options?.context ?? captureToolRpcContext();
  const spaceId = traceCtx.spaceId;
  const execute = () => wrapSandboxRpc(tracer, {
    method,
    sandboxId: connection.sandboxId,
    spaceId,
    sessionId: traceCtx.sessionId ?? undefined,
    turnId: traceCtx.turnId ?? undefined,
    turnSeq: traceCtx.turnSeq ?? undefined,
    llmRound: traceCtx.llmRound ?? undefined,
    toolCallId: traceCtx.toolCallId ?? undefined,
    params: params as Record<string, unknown>,
  }, async () => {
    await sandboxLifecycle.recordActivity({ spaceId, reason: "rpc", rpcMethod: method }).catch((error) => {
      logger.warn(`[SandboxActivity] failed to record rpc activity spaceId=${spaceId} method=${method}: ${error instanceof Error ? error.message : String(error)}`);
    });
    return connection.request(method, params, {
      requestId: randomUUID(),
      spaceId,
      sandboxId: connection.sandboxId,
      onEvent: options?.onEvent,
    });
  });

  try {
    try {
      return await execute();
    } catch (error) {
      const classified = classifySandboxInfrastructureError(error instanceof Error ? error.message : String(error));
      if (!classified || !retryInfraError) throw error;
      return recoverAndRetryAfterInfraError(spaceId, classified, async () => {
        const freshConnection = await ensureSandboxConnection(spaceId);
        return tracedRpc(freshConnection, method, params, options, false);
      });
    }
  } finally {
    try {
      pruneSandboxConnections();
    } catch (error) {
      logger.warn(`[SandboxPool] prune failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function createRemoteReadOperations(): ReadOperations {
  const tracer = getAgentTracer();
  return {
    async readFile(absolutePath) {
      const spaceId = getCurrentSpaceId();
      const toolCtx = getCurrentToolExecutionContext();
      incrementToolCallCount(toolCtx?.metrics);
      const toolCallId = randomUUID();
      return runWithToolExecutionContext({
        spaceId: toolCtx?.spaceId ?? spaceId,
        sessionId: toolCtx?.sessionId ?? "",
        turnId: toolCtx?.turnId,
        toolCallId,
      }, async () => wrapToolCall(tracer, {
        toolName: "read",
        input: { path: absolutePath },
        ...getCurrentTraceContext(),
      }, async () => {
        const connection = await getCurrentConnection();
        const path = mapLocalAbsolutePathToSandboxPath(absolutePath);
        await assertSandboxPathVisible(path);
        logger.debug(`[Tool:read] path=${path}`);
        // Use binary mode so sandbox detects MIME type and returns base64 for binary files.
        const result = await tracedRpc(connection, "fs.read", { path, binary: true });
        if (result.contentBase64) {
          return Buffer.from(result.contentBase64, "base64");
        }
        return Buffer.from(result.content, "utf8");
      }));
    },
    async access(absolutePath) {
      const connection = await getCurrentConnection();
      const path = mapLocalAbsolutePathToSandboxPath(absolutePath);
      await assertSandboxPathVisible(path);
      await tracedRpc(connection, "fs.read", { path, offset: 1, limit: 1 });
    },
    async detectImageMimeType(absolutePath) {
      const connection = await getCurrentConnection();
      const path = mapLocalAbsolutePathToSandboxPath(absolutePath);
      await assertSandboxPathVisible(path);
      const result = await tracedRpc(connection, "fs.read", { path, binary: true });
      const mimeType = typeof result.mimeType === "string" ? result.mimeType : null;
      // Only return supported raster image MIME types. The upstream read tool
      // treats any truthy return value here as an image.
      return isSupportedReadImageMimeType(mimeType) ? mimeType : null;
    },
    async detectUnsupportedImageMimeType(absolutePath) {
      const connection = await getCurrentConnection();
      const path = mapLocalAbsolutePathToSandboxPath(absolutePath);
      await assertSandboxPathVisible(path);
      const result = await tracedRpc(connection, "fs.read", { path, binary: true });
      const mimeType = typeof result.mimeType === "string" ? result.mimeType : null;
      return detectUnsupportedReadImageMimeType(mimeType);
    },
    unsupportedImageMimeTypeMessage: unsupportedReadImageMimeTypeMessage,
  };
}

function createRemoteWriteOperations(): WriteOperations {
  const tracer = getAgentTracer();
  return {
    async writeFile(absolutePath, content) {
      const spaceId = getCurrentSpaceId();
      const toolCtx = getCurrentToolExecutionContext();
      incrementToolCallCount(toolCtx?.metrics);
      const toolCallId = randomUUID();
      return runWithToolExecutionContext({
        spaceId: toolCtx?.spaceId ?? spaceId,
        sessionId: toolCtx?.sessionId ?? "",
        turnId: toolCtx?.turnId,
        toolCallId,
      }, async () => wrapToolCall(tracer, {
        toolName: "write",
        input: { path: absolutePath, bytes: content.length },
        ...getCurrentTraceContext(),
      }, async () => {
        const path = mapLocalAbsolutePathToSandboxPath(absolutePath);
        logger.debug(`[Tool:write] path=${path} bytes=${content.length}`);
        const connection = await getCurrentConnection();
        await tracedRpc(connection, "fs.write", { path, content });
      }));
    },
    async mkdir(_dir) {
      // sandbox fs.write already creates parent directories recursively
    },
  };
}

function createRemoteEditOperations(): EditOperations {
  const tracer = getAgentTracer();
  const readOps = createRemoteReadOperations();
  const writeOps = createRemoteWriteOperations();
  return {
    readFile: readOps.readFile,
    access: async (absolutePath) => {
      await readOps.access(absolutePath);
    },
    writeFile: writeOps.writeFile,
    // fs.edit runs the read-apply-write atomically inside the sandbox's
    // per-path lock, so edits always apply to the latest content. Infra
    // retries are disabled: an edit that succeeded but lost its response must
    // not be replayed (the oldText would no longer match).
    async applyEdits(absolutePath, edits) {
      const spaceId = getCurrentSpaceId();
      const toolCtx = getCurrentToolExecutionContext();
      incrementToolCallCount(toolCtx?.metrics);
      const toolCallId = randomUUID();
      return runWithToolExecutionContext({
        spaceId: toolCtx?.spaceId ?? spaceId,
        sessionId: toolCtx?.sessionId ?? "",
        turnId: toolCtx?.turnId,
        toolCallId,
      }, async () => wrapToolCall(tracer, {
        toolName: "edit",
        input: { path: absolutePath, edits: edits.length },
        ...getCurrentTraceContext(),
      }, async () => {
        const path = mapLocalAbsolutePathToSandboxPath(absolutePath);
        const connection = await getCurrentConnection();
        if (connection.capabilities?.fsEdit !== true) {
          // Older sandboxes (e.g. a pinned local sandboxd) do not support
          // fs.edit: fall back to the plain read-modify-write cycle, matching
          // the pre-fs.edit behavior.
          let content = (await readOps.readFile(absolutePath)).toString("utf-8");
          content = applyEditsToContent(content, edits, absolutePath);
          await writeOps.writeFile(absolutePath, content);
          return edits.length;
        }
        const result = await tracedRpc(connection, "fs.edit", { path, edits }, undefined, false);
        return result.applied;
      }));
    },
  };
}

function createRemoteBashOperations(): BashOperations {
  const tracer = getAgentTracer();
  return {
    exec({ command, cwd, onData, signal, timeout, env }) {
      let outputPreview = "";
      return new Promise((resolve, reject) => {
        let processId: string | null = null;
        let settled = false;
        let aborting = false;
        const cmdSummary = command.trim().slice(0, 80);

        const finish = (fn: () => void) => {
          if (settled) return;
          settled = true;
          fn();
        };

        void (async () => {
          try {
            const spaceId = getCurrentSpaceId();
            const toolCtx = getCurrentToolExecutionContext();
            incrementToolCallCount(toolCtx?.metrics);
            const toolCallId = randomUUID();
            await runWithToolExecutionContext({
              spaceId: toolCtx?.spaceId ?? spaceId,
              sessionId: toolCtx?.sessionId ?? "",
              turnId: toolCtx?.turnId,
              actorUserId: toolCtx?.actorUserId,
              executionToken: toolCtx?.executionToken,
              executionScopes: toolCtx?.executionScopes,
              sourceClientId: toolCtx?.sourceClientId,
              generationPolicy: toolCtx?.generationPolicy,
              env: toolCtx?.env,
              toolCallId,
            }, async () => wrapToolCall(tracer, {
              toolName: "bash",
              input: { command: cmdSummary, cwd },
              ...getCurrentTraceContext(),
            }, async () => {
              const connection = await getCurrentConnection();
              const sandboxCwd = mapLocalAbsolutePathToSandboxPath(cwd);
              const ctx = getCurrentToolExecutionContext();
              const sessionExecutionAuth = ctx?.sessionId && ctx.turnId ? getCurrentSessionExecutionAuth(ctx.sessionId, ctx.turnId) : null;
              const actorUserId = ctx?.actorUserId ?? sessionExecutionAuth?.actorUserId ?? null;
              const executionToken = ctx?.executionToken ?? sessionExecutionAuth?.executionToken ?? null;
              const injectedEnv: Record<string, string> = {
                ...(ctx?.spaceEnv ?? {}),
                ...(env ?? {}),
                ...(ctx?.env ?? {}),
                ...(ctx?.generationPolicy ? { [GENERATION_POLICY_ENV_KEY]: encodeGenerationPolicy(ctx.generationPolicy) } : {}),
                ...(ctx?.model ? {
                  COHUB_MODEL_PROVIDER: ctx.model.provider,
                  COHUB_MODEL_ID: ctx.model.id,
                } : {}),
                ...(ctx?.spaceId ? { COHUB_SPACE_ID: ctx.spaceId } : {}),
                ...(ctx?.sessionId ? { COHUB_SESSION_ID: ctx.sessionId } : {}),
                ...(ctx?.turnId ? { COHUB_TURN_ID: ctx.turnId } : {}),
                ...(ctx?.toolCallId ? { COHUB_TOOL_CALL_ID: ctx.toolCallId } : {}),
                ...(ctx?.sourceClientId ? { COHUB_SOURCE_CLIENT_ID: ctx.sourceClientId } : {}),
                ...(actorUserId ? { COHUB_USER_UUID: actorUserId } : {}),
                ...(executionToken ? { COHUB_EXECUTION_TOKEN: executionToken } : {}),
              };
              logger.debug(`[Tool:bash] exec summary="${cmdSummary}" cwd=${sandboxCwd}`);

              const rpcContext = captureToolRpcContext({ toolCallId });
              let abortSent = false;
              let unregisterProcessAbort: (() => void) | null = null;
              const abortProcess = (targetProcessId: string) => {
                if (abortSent) return;
                abortSent = true;
                logger.info(`[Tool:bash] abort requested processId=${targetProcessId} turnId=${rpcContext.turnId ?? ""} toolCallId=${toolCallId}`);
                void tracedRpc(connection, "process.abort", { processId: targetProcessId }, { context: rpcContext }, false).catch((error) => {
                  logger.warn(`[Tool:bash] process.abort failed processId=${targetProcessId}: ${error instanceof Error ? error.message : String(error)}`);
                });
              };

              const cleanupAbort = () => {
                signal?.removeEventListener("abort", onAbort);
                unregisterProcessAbort?.();
                unregisterProcessAbort = null;
              };

              const onAbort = () => {
                aborting = true;
                if (!processId) return;
                abortProcess(processId);
              };

              if (signal) {
                if (signal.aborted) onAbort();
                else signal.addEventListener("abort", onAbort, { once: true });
              }

              try {
                await tracedRpc(
                  connection,
                  "process.start",
                  {
                    command,
                    timeoutSecs: timeout,
                    cwd: sandboxCwd,
                    env: Object.keys(injectedEnv).length > 0 ? injectedEnv : undefined,
                  },
                  {
                    onEvent(event) {
                      if (event.type === "started") {
                        processId = event.processId;
                        logger.info(`[Tool:bash] process started processId=${event.processId} turnId=${rpcContext.turnId ?? ""} toolCallId=${toolCallId}`);
                        if (rpcContext.turnId) {
                          unregisterProcessAbort = registerActiveAbortHandle(rpcContext.turnId, {
                            id: `bash:${toolCallId}:${event.processId}`,
                            kind: "tool",
                            toolName: "bash",
                            abort: () => abortProcess(event.processId),
                          });
                        }
                        if (aborting) {
                          abortProcess(event.processId);
                        }
                        return;
                      }

                      if (event.type === "stdout" || event.type === "stderr") {
                        const rawChunk = typeof event.chunk === "string" ? event.chunk : "";
                        if (!rawChunk) return;
                        const chunk = executionToken
                          ? rawChunk.split(executionToken).join("[REDACTED_TOKEN]")
                          : rawChunk;
                        outputPreview = `${outputPreview}${chunk}`.slice(-2000);
                        onData(Buffer.from(chunk, "utf8"));
                        return;
                      }

                      if (event.type === "exit") {
                        cleanupAbort();
                        const exitCode = event.exitCode ?? null;
                        logger.debug(`[Tool:bash] exit code=${exitCode} reason=${event.termination?.reason ?? "exited"} summary="${cmdSummary}"`);
                        finish(() => resolve({
                          exitCode,
                          termination: event.termination ?? { reason: "exited", exitCode },
                        }));
                      }
                    },
                  },
                );
              } finally {
                if (!settled && processId) abortProcess(processId);
                cleanupAbort();
              }
            }));
          } catch (error) {
            if (isSandboxRpcError(error)) {
              const presentation = getSandboxRpcFailurePresentation(error);
              logger.warn(`[Tool:bash] sandbox rpc failed kind=${presentation.kind} cmd="${cmdSummary}" method=${error.method} rpcErrorCode=${error.rpcErrorCode} retryable=${error.retryable}`);
              finish(() => resolve({
                failure: {
                  isError: true,
                  retryable: error.retryable,
                  infrastructure: presentation.infrastructure,
                  rpcErrorCode: error.rpcErrorCode,
                  outputTail: outputPreview,
                  message: presentation.message,
                },
              } satisfies BashExecutionResult));
              return;
            }
            logger.error(`[Tool:bash] error cmd="${cmdSummary}"`, error);
            finish(() => reject(error));
          }
        })();
      });
    },
    async startBackground({ command, cwd, signal, timeout, toolCallId }) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const ctx = getCurrentToolExecutionContext();
      const sessionExecutionAuth = ctx?.sessionId && ctx.turnId ? getCurrentSessionExecutionAuth(ctx.sessionId, ctx.turnId) : null;
      const userId = ctx?.actorUserId ?? sessionExecutionAuth?.actorUserId ?? null;
      const executionScopes = ctx?.executionScopes ?? sessionExecutionAuth?.executionScopes ?? [];
      if (!ctx?.spaceId || !ctx.sessionId || !ctx.turnId || !userId) {
        throw new Error("Background bash execution requires space, session, turn, and user context.");
      }

      const payload: TaskPayload = {
        type: RUN_COMMAND_TASK_TYPE,
        spaceId: ctx.spaceId,
        sessionId: ctx.sessionId,
        turnId: ctx.turnId,
        userId,
        data: {
          command,
          cwd,
          ...(timeout !== undefined ? { timeout } : {}),
          ...(ctx.sourceClientId ? { sourceClientId: ctx.sourceClientId } : {}),
          ...(ctx.model ? { model: ctx.model } : {}),
          ...(ctx.generationPolicy ? { generationPolicy: ctx.generationPolicy } : {}),
          ...(ctx.env ? { env: ctx.env } : {}),
          ...(executionScopes.length ? { executionScopes } : {}),
          origin: {
            kind: "bash_tool_call",
            sessionId: ctx.sessionId,
            turnId: ctx.turnId,
            toolCallId,
            ...(ctx.requestId ? { requestId: ctx.requestId } : {}),
          },
          notify: {
            kind: "session_prompt",
            sessionId: ctx.sessionId,
            source: "background_bash_task",
          },
        },
      };

      const { taskRunId } = await enqueueTaskRun({
        db,
        payload,
        enqueue: (name, taskPayload, options) => taskQueue.add(name, taskPayload, options),
        onTaskCreated: (taskRun) => dispatchTaskCreated(taskRun).catch((error) => logger.warn("[Realtime] failed to dispatch task.created", error)),
      });
      logger.info(`[Tool:bash] background task enqueued taskRunId=${taskRunId} turnId=${ctx.turnId} toolCallId=${toolCallId} command=${JSON.stringify(command.trim().slice(0, 80))}`);
      return { taskRunId };
    },
  };
}

function createRemoteLsOperations(): LsOperations {
  const tracer = getAgentTracer();
  return {
    async exists(absolutePath) {
      const path = mapLocalAbsolutePathToSandboxPath(absolutePath);
      const relativePath = sandboxWorkspaceRelativePath(path);
      if (relativePath != null && !(await createCurrentWorkspaceVisibilityFilter(undefined, relativePath)).isVisible(relativePath)) return false;
      const connection = await getCurrentConnection();
      const result = await tracedRpc(connection, "fs.stat", { path });
      return result.exists;
    },
    async stat(absolutePath) {
      const path = mapLocalAbsolutePathToSandboxPath(absolutePath);
      await assertSandboxPathVisible(path);
      const connection = await getCurrentConnection();
      const result = await tracedRpc(connection, "fs.stat", { path });
      return {
        isDirectory: () => result.isDirectory,
      };
    },
    async readdir(absolutePath) {
      const spaceId = getCurrentSpaceId();
      const toolCtx = getCurrentToolExecutionContext();
      incrementToolCallCount(toolCtx?.metrics);
      const toolCallId = randomUUID();
      return runWithToolExecutionContext({
        spaceId: toolCtx?.spaceId ?? spaceId,
        sessionId: toolCtx?.sessionId ?? "",
        turnId: toolCtx?.turnId,
        toolCallId,
      }, async () => wrapToolCall(tracer, {
        toolName: "ls",
        input: { path: absolutePath },
        ...getCurrentTraceContext(),
      }, async () => {
        const path = mapLocalAbsolutePathToSandboxPath(absolutePath);
        await assertSandboxPathVisible(path, { isDirectory: true });
        logger.debug(`[Tool:ls] path=${path}`);
        const connection = await getCurrentConnection();
        const result = await tracedRpc(connection, "fs.ls", { path });
        const filter = await createCurrentWorkspaceVisibilityFilter(undefined, sandboxWorkspaceRelativePath(path) ?? "");
        return result.entries
          .filter((entry) => {
            const relativePath = workspaceChildPath(path, entry);
            return relativePath == null || filter.isVisible(relativePath, { isDirectory: entry.endsWith("/") });
          })
          .map((entry) => entry.endsWith("/") ? entry.slice(0, -1) : entry);
      }));
    },
  };
}

const FD_FIND_TIMEOUT_SECS = 30;
const FD_FIND_MAX_STDOUT_BYTES = DEFAULT_MAX_BYTES * 8;
const FD_FIND_MAX_STDERR_BYTES = 8 * 1024;
const FD_FIND_OUTPUT_LIMIT_MESSAGE = "Find output limit reached. Refine pattern or path.";

function buildFdFindPattern(pattern: string) {
  const useFullPath = pattern.includes("/");
  let effectivePattern = pattern;
  if (useFullPath && !effectivePattern.startsWith("/") && !effectivePattern.startsWith("**/") && effectivePattern !== "**") {
    effectivePattern = `**/${effectivePattern}`;
  }
  return { effectivePattern, useFullPath };
}

function buildFdFindArgv(input: { pattern: string; path: string; limit: number; ignore?: string[] }) {
  const { effectivePattern, useFullPath } = buildFdFindPattern(input.pattern);

  const argv = [
    "fd",
    "--color=never",
    "--glob",
    "--hidden",
    "--no-require-git",
    "--exclude",
    ".git",
  ];
  if (useFullPath) argv.push("--full-path");
  for (const ignore of input.ignore ?? []) {
    if (ignore) argv.push("--exclude", ignore);
  }
  argv.push("--max-results", String(input.limit), "--", effectivePattern, input.path);
  return argv;
}

async function resolveFindIndexMatches(
  connection: SandboxConnection,
  pattern: string,
  path: string,
  limit: number,
  ignore: string[] | undefined,
  context: ToolRpcContext,
): Promise<string[] | null> {
  if (
    connection.capabilities?.fsPathSearch !== true ||
    !isSandboxWorkspacePath(path) ||
    pattern.startsWith("/")
  ) return null;
  const { effectivePattern, useFullPath } = buildFdFindPattern(pattern);
  try {
    const result = await tracedRpc(
      connection,
      "fs.pathSearch",
      {
        pattern: effectivePattern,
        path,
        cwd: SANDBOX_WORKSPACE_PATH,
        limit,
        fullPath: useFullPath,
        ignore,
      },
      { context },
      false,
    );
    if (result.coverage !== "complete" || result.state !== "ready") {
      logger.debug(`[Tool:find] path index not authoritative coverage=${result.coverage} state=${result.state ?? "unknown"}`);
      return null;
    }
    logger.debug(`[Tool:find] path index matches=${result.matches.length}`);
    return result.matches;
  } catch (error) {
    logger.debug(`[Tool:find] path index unavailable, falling back to fd: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function formatFdFindPath(filePath: string, searchPath: string) {
  const file = toPosixPath(filePath).replace(/\/$/, "");
  const search = toPosixPath(searchPath).replace(/\/$/, "");
  if (file === search) return ".";
  if (file.startsWith(`${search}/`)) return file.slice(search.length + 1);
  return file.replace(/^\.\//, "");
}

function createRemoteFindOperations(): FindOperations {
  const tracer = getAgentTracer();
  return {
    async exists(absolutePath) {
      const path = mapLocalAbsolutePathToSandboxPath(absolutePath);
      const relativePath = sandboxWorkspaceRelativePath(path);
      if (relativePath != null && !(await createCurrentWorkspaceVisibilityFilter(undefined, relativePath)).isVisible(relativePath)) return false;
      const connection = await getCurrentConnection();
      const result = await tracedRpc(connection, "fs.stat", { path });
      return result.exists;
    },
    async glob(pattern, cwd, options) {
      const spaceId = getCurrentSpaceId();
      const toolCtx = getCurrentToolExecutionContext();
      incrementToolCallCount(toolCtx?.metrics);
      const toolCallId = randomUUID();
      return runWithToolExecutionContext({
        spaceId: toolCtx?.spaceId ?? spaceId,
        sessionId: toolCtx?.sessionId ?? "",
        turnId: toolCtx?.turnId,
        toolCallId,
      }, async () => wrapToolCall(tracer, {
        toolName: "find",
        input: { pattern, path: cwd },
        ...getCurrentTraceContext(),
      }, async () => {
        const path = mapLocalAbsolutePathToSandboxPath(cwd);
        await assertSandboxPathVisible(path, { isDirectory: true });
        logger.debug(`[Tool:find] pattern=${pattern} path=${path}`);

        const connection = await getCurrentConnection();
        if (connection.capabilities?.processStartArgv) {
          const rpcContext = captureToolRpcContext({ toolCallId });
          const baseRelative = sandboxWorkspaceRelativePath(path);
          const filter = await createCurrentWorkspaceVisibilityFilter(undefined, baseRelative ?? "");
          const indexedMatches = await resolveFindIndexMatches(
            connection,
            pattern,
            path,
            options.limit,
            options.ignore,
            rpcContext,
          );
          const filterFindMatches = (rawMatches: string[]) => rawMatches
            .map((match) => toPosixPath(match).replace(/^\.\//, "").replace(/\/$/, ""))
            .filter((match) => {
              if (baseRelative == null) return true;
              const relativePath = match === "." ? baseRelative : baseRelative ? `${baseRelative}/${match}` : match;
              return filter.isVisible(relativePath);
            })
            .slice(0, options.limit);
          if (indexedMatches) return filterFindMatches(indexedMatches);

          // A search-enabled sandbox has one structured fallback for find. It
          // preserves the same ignore domain as the path index when the index
          // is stale or unavailable; older sandboxes keep the direct fd path.
          if (connection.capabilities?.fsPathSearch === true) {
            const { effectivePattern, useFullPath } = buildFdFindPattern(pattern);
            try {
              const result = await tracedRpc(
                connection,
                "fs.find",
                {
                  pattern: effectivePattern,
                  path,
                  cwd: SANDBOX_WORKSPACE_PATH,
                  limit: options.limit,
                  maxResults: options.limit,
                  mode: "glob",
                  hidden: true,
                  requireGit: false,
                  ignoreVcs: false,
                  fullPath: useFullPath,
                  ignore: options.ignore,
                },
                { context: rpcContext },
                false,
              );
              return filterFindMatches(result.matches);
            } catch (error) {
              logger.debug(`[Tool:find] structured fallback unavailable, using fd: ${error instanceof Error ? error.message : String(error)}`);
            }
          }

          const argv = buildFdFindArgv({ pattern, path, limit: options.limit, ignore: options.ignore });
          const stderrChunks: string[] = [];
          const matches: string[] = [];
          const updates = createThrottledTextToolUpdate(options.onUpdate, { maxChars: DEFAULT_MAX_BYTES });
          let lineBuffer = "";
          let stdoutBytes = 0;
          let stderrBytes = 0;
          let stdoutLimitReached = false;
          let aborted = false;
          let activeProcessId: string | null = null;
          let abortSent = false;
          const unregisterProcessAborts: Array<() => void> = [];
          const abortProcess = (processId: string) => {
            if (abortSent) return;
            abortSent = true;
            logger.info(`[Tool:find] abort requested processId=${processId} turnId=${rpcContext.turnId ?? ""} toolCallId=${toolCallId}`);
            void tracedRpcAbortProcess(connection, processId, rpcContext);
          };
          const pushMatch = (rawMatch: string) => {
            const trimmed = rawMatch.trim();
            if (!trimmed || matches.length >= options.limit) return;
            const match = formatFdFindPath(trimmed, path);
            if (baseRelative != null) {
              const relativePath = match === "." ? baseRelative : baseRelative ? `${baseRelative}/${match}` : match;
              if (!filter.isVisible(relativePath)) return;
            }
            matches.push(match);
            updates.push(matches.join("\n"));
          };
          const consumeStdout = (chunk: string) => {
            lineBuffer += chunk;
            const lines = lineBuffer.split("\n");
            lineBuffer = lines.pop() ?? "";
            for (const line of lines) pushMatch(line);
          };
          const onAbort = () => {
            aborted = true;
            if (activeProcessId) abortProcess(activeProcessId);
          };
          if (toolCtx?.abortSignal) {
            if (toolCtx.abortSignal.aborted) onAbort();
            else toolCtx.abortSignal.addEventListener("abort", onAbort, { once: true });
          }

          try {
            const result = await tracedRpc(
              connection,
              "process.start",
              {
                argv,
                cwd: SANDBOX_WORKSPACE_PATH,
                timeoutSecs: FD_FIND_TIMEOUT_SECS,
              },
              {
                context: rpcContext,
                onEvent(event) {
                  if (event.type === "started") {
                    activeProcessId = event.processId;
                    logger.info(`[Tool:find] process started processId=${event.processId} turnId=${rpcContext.turnId ?? ""} toolCallId=${toolCallId}`);
                    if (rpcContext.turnId) {
                      unregisterProcessAborts.push(registerActiveAbortHandle(rpcContext.turnId, {
                        id: `find:${toolCallId}:${event.processId}`,
                        kind: "tool",
                        toolName: "find",
                        abort: () => abortProcess(event.processId),
                      }));
                    }
                    if (toolCtx?.abortSignal?.aborted) abortProcess(event.processId);
                    return;
                  }

                  if (event.type === "stdout") {
                    stdoutBytes += Buffer.byteLength(event.chunk, "utf8");
                    if (stdoutBytes > FD_FIND_MAX_STDOUT_BYTES) {
                      stdoutLimitReached = true;
                      if (activeProcessId) abortProcess(activeProcessId);
                      return;
                    }
                    consumeStdout(event.chunk);
                    return;
                  }

                  if (event.type === "stderr") {
                    stderrBytes += Buffer.byteLength(event.chunk, "utf8");
                    if (stderrBytes <= FD_FIND_MAX_STDERR_BYTES) stderrChunks.push(event.chunk);
                  }
                },
              },
            );

            if (lineBuffer) {
              pushMatch(lineBuffer);
              lineBuffer = "";
            }
            updates.flush();

            if (aborted || toolCtx?.abortSignal?.aborted) return { matches, note: "Operation aborted." };
            if (stdoutLimitReached) return { matches, note: FD_FIND_OUTPUT_LIMIT_MESSAGE, details: { outputLimitReached: true, partial: true } };

            const termination = result.termination;
            if (termination && termination.reason !== "exited") {
              if (termination.reason === "aborted") return { matches, note: termination.message ?? "Operation aborted." };
              throw new Error(termination.message || `fd ${termination.reason}`);
            }
            if (result.exitCode == null) throw new Error("fd exited without an exit code");
            const exitCode = result.exitCode;
            const stderr = stderrChunks.join("").trim();
            if (exitCode !== 0) throw new Error(stderr || `fd exited with code ${exitCode}`);

            return matches;
          } finally {
            if (toolCtx?.abortSignal) toolCtx.abortSignal.removeEventListener("abort", onAbort);
            for (const unregister of unregisterProcessAborts) unregister();
          }
        }

        // Agent owns tool semantics: match pi-coding-agent fd behavior.
        // In --full-path mode fd matches against the absolute candidate path,
        // so a path-containing pattern like 'src/**/*.spec.ts' needs a leading
        // '**/' to match anything (matching pi-coding-agent logic).
        let effectivePattern = pattern;
        const useFullPath = pattern.includes("/");
        if (useFullPath && !pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
          effectivePattern = `**/${pattern}`;
        }

        const result = await tracedRpc(connection, "fs.find", {
          pattern: effectivePattern,
          path,
          limit: options.limit,
          maxResults: options.limit,
          mode: "glob",
          // Always include hidden files (matching pi-coding-agent `--hidden`).
          hidden: true,
          // Apply .gitignore even outside a git repo (matching pi-coding-agent `--no-require-git`).
          requireGit: false,
          // Don't skip VCS ignore rules — let .gitignore work naturally.
          ignoreVcs: false,
          fullPath: useFullPath,
          // Pass through ignore patterns from the caller (e.g. node_modules).
          ignore: options.ignore,
        });
        return result.matches;
      }));
    },
  };
}

const RG_GREP_TIMEOUT_SECS = 30;
const RG_GREP_MAX_STDOUT_BYTES = DEFAULT_MAX_BYTES * 8;
const RG_GREP_MAX_STDERR_BYTES = 8 * 1024;
const RG_GREP_OUTPUT_LIMIT_MESSAGE = "Grep output limit reached. Refine pattern, path, or glob.";
// Stay under the sandbox process.start argv limits (256 items, 64 KiB) when
// index candidates are passed to rg as explicit files.
const RG_GREP_ARGV_LIMITS = { maxItems: 240, maxBytes: 60 * 1024 };
// Beyond this the literal is too common for the index to narrow the search;
// a truncated candidate set falls back to a full rg walk.
const GREP_INDEX_MAX_CANDIDATES = 512;

/** rg argv without search targets; callers append a directory or explicit files. */
function buildRgGrepArgv(input: GrepToolInput) {
  const argv = [
    "rg",
    "--line-number",
    "--color=never",
    "--json",
    "--hidden",
    "--no-require-git",
    "--glob",
    "!.git/**",
  ];
  // Match the legacy fs.grep request: maxCount is only sent when the user
  // explicitly provides limit, while limit itself is applied to returned JSON
  // lines for compatibility during rollout.
  if (input.limit && input.limit > 0) argv.push("--max-count", String(input.limit));
  if (input.context && input.context > 0) argv.push("--context", String(input.context));
  if (input.ignoreCase) argv.push("--ignore-case");
  if (input.literal) argv.push("--fixed-strings");
  if (input.glob?.trim()) argv.push("--glob", input.glob);
  argv.push("--", input.pattern);
  return argv;
}

function isSandboxWorkspacePath(searchPath: string) {
  if (!searchPath.startsWith("/")) return true;
  return searchPath === SANDBOX_WORKSPACE_PATH || searchPath.startsWith(`${SANDBOX_WORKSPACE_PATH}/`);
}

/**
 * Ask the sandbox trigram index for files that can contain every required
 * literal of the pattern. Returns null whenever the index cannot answer
 * authoritatively (feature missing, no usable literal, stale coverage, too
 * many candidates, or any RPC failure) so the caller runs a full rg walk.
 * An empty array is authoritative: no indexed file can match.
 */
async function resolveGrepIndexCandidates(
  connection: SandboxConnection,
  input: GrepToolInput,
  searchPath: string,
  context: ToolRpcContext,
): Promise<string[] | null> {
  if (connection.capabilities?.fsSearch !== true || !isSandboxWorkspacePath(searchPath)) return null;
  const literals = extractRequiredGrepLiterals(input.pattern, { literal: input.literal });
  if (literals.length === 0) return null;

  let result: RpcRequestMap["fs.search"]["result"];
  try {
    result = await tracedRpc(
      connection,
      "fs.search",
      { literals, path: searchPath, cwd: SANDBOX_WORKSPACE_PATH, limit: GREP_INDEX_MAX_CANDIDATES },
      { context },
      false,
    );
  } catch (error) {
    logger.debug(`[Tool:grep] index unavailable, falling back to rg walk: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (result.coverage !== "complete" || result.truncated) {
    logger.debug(`[Tool:grep] index not authoritative coverage=${result.coverage} truncated=${result.truncated === true}`);
    return null;
  }
  const files = filterGrepCandidatesByGlob(result.matches, input.glob);
  logger.debug(`[Tool:grep] index candidates=${files.length} literals=${literals.length}`);
  return files.map((relative) => joinGrepCandidatePath(searchPath, relative));
}

function isRgNoMatchOutput(lines: string[]) {
  if (lines.length === 0) return true;
  return lines.every((line) => {
    try {
      return (JSON.parse(line) as { type?: string }).type === "summary";
    } catch {
      return false;
    }
  });
}

/**
 * Sandbox grep tool. New sandboxes expose processStartArgv, so the agent owns
 * rg argv construction, JSON parsing, match limits, and presentation. Old
 * sandboxes keep using legacy fs.grep for compatibility during rollout.
 *
 * Native grep output format:
 *   Match lines:   relativePath:lineNumber: text
 *   Context lines: relativePath-lineNumber- text
 *   Long lines are truncated to GREP_MAX_LINE_LENGTH.
 */
function createRemoteGrepTool() {
  const tracer = getAgentTracer();
  const definition = createGrepToolDefinition(SANDBOX_WORKSPACE_PATH);

  definition.execute = async (
    _toolCallId,
    input,
    signal?: AbortSignal,
    onUpdate?,
    _ctx?: unknown,
  ) => {
    const grepInput = input as GrepToolInput;
    const spaceId = getCurrentSpaceId();
    const toolCtx = getCurrentToolExecutionContext();
    incrementToolCallCount(toolCtx?.metrics);
    const toolCallId = _toolCallId || randomUUID();
    logger.debug(`[Tool:grep] pattern=${grepInput.pattern} path=${grepInput.path}`);

    return runWithToolExecutionContext({
      spaceId: toolCtx?.spaceId ?? spaceId,
      sessionId: toolCtx?.sessionId ?? "",
      turnId: toolCtx?.turnId,
      toolCallId,
    }, async () => wrapToolCall(tracer, {
      toolName: "grep",
      input: { pattern: grepInput.pattern, path: grepInput.path },
      ...getCurrentTraceContext(),
    }, async () => {
      // Check abort before starting.
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const effectiveLimit = Math.max(1, grepInput.limit ?? 100);

      // Set up abort handling.
      let aborted = false;
      let activeProcessId: string | null = null;
      const rpcContext = captureToolRpcContext({ toolCallId });
      let abortSent = false;
      const unregisterProcessAborts: Array<() => void> = [];
      const abortProcess = (processId: string) => {
        if (abortSent) return;
        abortSent = true;
        logger.info(`[Tool:grep] abort requested processId=${processId} turnId=${rpcContext.turnId ?? ""} toolCallId=${toolCallId}`);
        void tracedRpcAbortProcess(connection, processId, rpcContext);
      };
      const onAbort = () => {
        aborted = true;
        if (activeProcessId) abortProcess(activeProcessId);
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      const connection = await getCurrentConnection();
      const searchPath = mapSandboxInputPath(grepInput.path);
      if (searchPath.startsWith(SANDBOX_WORKSPACE_PATH) || !searchPath.startsWith("/")) {
        await assertSandboxPathVisible(searchPath.startsWith("/") ? searchPath : `${SANDBOX_WORKSPACE_PATH}/${searchPath}`, { isDirectory: true });
      }
      try {
        if (connection.capabilities?.processStartArgv) {
          const lines: string[] = [];
          const stderrChunks: string[] = [];
          const updates = createThrottledTextToolUpdate(onUpdate, { maxChars: DEFAULT_MAX_BYTES });
          let lineBuffer = "";
          let stdoutBytes = 0;
          let stderrBytes = 0;
          let stdoutLimitReached = false;
          const baseArgv = buildRgGrepArgv(grepInput);
          const candidates = await resolveGrepIndexCandidates(connection, grepInput, searchPath, rpcContext);
          if (candidates && candidates.length === 0) {
            return formatRgJsonGrepResult({ lines: [], searchPath: grepInput.path, limit: effectiveLimit });
          }
          const argvRuns = candidates
            ? chunkGrepFileArgs(baseArgv, candidates, RG_GREP_ARGV_LIMITS).map((files) => [...baseArgv, ...files])
            : [[...baseArgv, searchPath]];
          const emitPartial = () => {
            const partial = formatRgJsonGrepResult({ lines: lines.slice(0, effectiveLimit), searchPath: grepInput.path, limit: effectiveLimit });
            const partialText = partial.content[0]?.type === "text" ? partial.content[0].text : "";
            if (partialText && partialText !== "No matches found") updates.push(partialText);
          };
          const consumeStdout = (chunk: string) => {
            lineBuffer += chunk;
            const completeLines = lineBuffer.split("\n");
            lineBuffer = completeLines.pop() ?? "";
            let changed = false;
            for (const line of completeLines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              lines.push(trimmed);
              changed = true;
            }
            if (changed) emitPartial();
          };

          const runRg = async (argv: string[]) => {
            const result = await tracedRpc(
              connection,
              "process.start",
              {
                argv,
                cwd: SANDBOX_WORKSPACE_PATH,
                timeoutSecs: RG_GREP_TIMEOUT_SECS,
              },
              {
                context: rpcContext,
                onEvent(event) {
                  if (event.type === "started") {
                    activeProcessId = event.processId;
                    logger.info(`[Tool:grep] process started processId=${event.processId} turnId=${rpcContext.turnId ?? ""} toolCallId=${toolCallId}`);
                    if (rpcContext.turnId) {
                      unregisterProcessAborts.push(registerActiveAbortHandle(rpcContext.turnId, {
                        id: `grep:${toolCallId}:${event.processId}`,
                        kind: "tool",
                        toolName: "grep",
                        abort: () => abortProcess(event.processId),
                      }));
                    }
                    if (aborted) abortProcess(event.processId);
                    return;
                  }

                  if (event.type === "stdout") {
                    stdoutBytes += Buffer.byteLength(event.chunk, "utf8");
                    if (stdoutBytes > RG_GREP_MAX_STDOUT_BYTES && activeProcessId) {
                      stdoutLimitReached = true;
                      abortProcess(activeProcessId);
                      return;
                    }
                    consumeStdout(event.chunk);
                    return;
                  }

                  if (event.type === "stderr") {
                    stderrBytes += Buffer.byteLength(event.chunk, "utf8");
                    if (stderrBytes <= RG_GREP_MAX_STDERR_BYTES) stderrChunks.push(event.chunk);
                  }
                },
              },
            );

            if (lineBuffer.trim()) {
              lines.push(lineBuffer.trim());
              lineBuffer = "";
              emitPartial();
            }
            return result.exitCode ?? 0;
          };

          // Candidate chunks run sequentially and stop as soon as the match
          // limit is covered; a full walk is a single run over searchPath.
          for (const argv of argvRuns) {
            const runStart = lines.length;
            const exitCode = await runRg(argv);
            if (aborted || stdoutLimitReached) break;

            const stderr = stderrChunks.join("").trim();
            const ignorableRgError = stderr.includes("No files were searched");
            if (exitCode !== 0 && !(exitCode === 1 && isRgNoMatchOutput(lines.slice(runStart))) && !ignorableRgError) {
              updates.flush();
              return {
                content: [{ type: "text" as const, text: stderr || `rg exited with code ${exitCode}` }],
                details: createToolFailure(stderr || `rg exited with code ${exitCode}`),
              };
            }
            if (lines.length >= effectiveLimit) break;
          }
          updates.flush();

          if (aborted) {
            const partial = formatRgJsonGrepResult({ lines: lines.slice(0, effectiveLimit), searchPath: grepInput.path, limit: effectiveLimit });
            const partialText = partial.content[0]?.type === "text" ? partial.content[0].text : "";
            return {
              content: [{ type: "text" as const, text: partialText && partialText !== "No matches found" ? `${partialText}\n\n[Operation aborted.]` : "[Operation aborted.]" }],
              details: { ...(partial.details ?? {}), termination: { reason: "aborted", exitCode: null, message: "Operation aborted." } },
            };
          }

          if (stdoutLimitReached) {
            const partial = formatRgJsonGrepResult({ lines: lines.slice(0, effectiveLimit), searchPath: grepInput.path, limit: effectiveLimit });
            const partialText = partial.content[0]?.type === "text" ? partial.content[0].text : "";
            return {
              content: [{ type: "text" as const, text: partialText && partialText !== "No matches found" ? `${partialText}\n\n[${RG_GREP_OUTPUT_LIMIT_MESSAGE}]` : RG_GREP_OUTPUT_LIMIT_MESSAGE }],
              details: { ...(partial.details ?? {}), outputLimitReached: true, partial: true },
            };
          }

          return formatRgJsonGrepResult({ lines: lines.slice(0, effectiveLimit), searchPath: grepInput.path, limit: effectiveLimit });
        }

        const result = await tracedRpc(
          connection,
          "fs.grep",
          {
            pattern: grepInput.pattern,
            path: searchPath,
            glob: grepInput.glob,
            ignoreCase: grepInput.ignoreCase,
            literal: grepInput.literal,
            context: grepInput.context,
            limit: effectiveLimit,
            // Legacy sandbox compatibility: sandbox still owns rg execution here.
            maxCount: grepInput.limit,
            json: true,
            hidden: true,
          },
          {
            onEvent(event) {
              if (event.type === "started") {
                activeProcessId = event.processId;
                logger.info(`[Tool:grep] process started processId=${event.processId} turnId=${rpcContext.turnId ?? ""} toolCallId=${toolCallId}`);
                if (rpcContext.turnId) {
                  unregisterProcessAborts.push(registerActiveAbortHandle(rpcContext.turnId, {
                    id: `grep:${toolCallId}:${event.processId}`,
                    kind: "tool",
                    toolName: "grep",
                    abort: () => abortProcess(event.processId),
                  }));
                }
                if (aborted) abortProcess(event.processId);
              }
            },
          },
        );

        if (aborted) {
          const partial = formatRgJsonGrepResult({ lines: result.lines, searchPath: grepInput.path, limit: effectiveLimit });
          const partialText = partial.content[0]?.type === "text" ? partial.content[0].text : "";
          return {
            content: [{ type: "text" as const, text: partialText && partialText !== "No matches found" ? `${partialText}\n\n[Operation aborted.]` : "[Operation aborted.]" }],
            details: { ...(partial.details ?? {}), termination: { reason: "aborted", exitCode: null, message: "Operation aborted." } },
          };
        }

        return formatRgJsonGrepResult({ lines: result.lines, searchPath: grepInput.path, limit: effectiveLimit });
      } finally {
        if (signal) signal.removeEventListener("abort", onAbort);
        for (const unregister of unregisterProcessAborts) unregister();
      }
    }));
  };

  // Keep native renderCall and renderResult for TUI consistency.
  return {
    ...definition,
    execute: definition.execute,
  };
}

/** Abort a running process via sandbox RPC. */
async function tracedRpcAbortProcess(connection: SandboxConnection, processId: string, context: ToolRpcContext) {
  try {
    await tracedRpc(connection, "process.abort", { processId }, { context }, false);
  } catch {
    // Ignore abort errors.
  }
}

function getCurrentActorUserId() {
  const ctx = getCurrentToolExecutionContext();
  if (ctx?.actorUserId) return ctx.actorUserId;
  if (ctx?.sessionId && ctx.turnId) return getCurrentSessionExecutionAuth(ctx.sessionId, ctx.turnId)?.actorUserId ?? null;
  return null;
}

async function resolveCurrentFileVisibility(spaceId: string): Promise<AgentFileVisibility> {
  const ctx = getCurrentToolExecutionContext();
  if (ctx?.fileVisibility) return ctx.fileVisibility;
  const actorUserId = getCurrentActorUserId();
  if (!actorUserId?.trim()) throw new Error("Access denied: an authenticated user is required.");
  return resolveSpaceFileVisibility({ actorUserId: actorUserId.trim(), spaceId });
}

async function createCurrentWorkspaceVisibilityFilter(spaceId = getCurrentSpaceId(), basePath = ""): Promise<AgentWorkspaceVisibilityFilter> {
  return createWorkspaceVisibilityFilter(getSpaceWorkspaceDir(spaceId), await resolveCurrentFileVisibility(spaceId), basePath);
}

function sandboxWorkspaceRelativePath(sandboxPath: string) {
  if (sandboxPath === SANDBOX_WORKSPACE_PATH) return "";
  if (sandboxPath.startsWith(`${SANDBOX_WORKSPACE_PATH}/`)) return sandboxPath.slice(SANDBOX_WORKSPACE_PATH.length + 1);
  return null;
}

function workspaceChildPath(parent: string, entry: string) {
  const base = sandboxWorkspaceRelativePath(parent);
  if (base == null) return null;
  const name = entry.endsWith("/") ? entry.slice(0, -1) : entry;
  return base ? `${base}/${name}` : name;
}

async function assertSandboxPathVisible(sandboxPath: string, options?: { isDirectory?: boolean }) {
  const relativePath = sandboxWorkspaceRelativePath(sandboxPath);
  if (relativePath == null) return;
  (await createCurrentWorkspaceVisibilityFilter(undefined, relativePath)).assertVisible(relativePath, options);
}

async function assertCurrentActorCanViewSpaceFiles(spaceId: string): Promise<AgentFileVisibility> {
  const actorUserId = getCurrentActorUserId();
  if (!actorUserId?.trim()) throw new Error("Access denied: an authenticated user is required.");
  return resolveSpaceFileVisibility({ actorUserId: actorUserId.trim(), spaceId });
}

async function resolveSandboxProvider(spaceId: string): Promise<"cloud" | "local"> {
  const now = Date.now();
  const cached = sandboxProviderCache.get(spaceId);
  if (cached && cached.expiresAt > now) return cached.provider;
  try {
    const sandbox = (await getSpaceSandbox({ spaceId }))?.sandbox;
    const provider = sandbox?.provider === "local" ? "local" : "cloud";
    sandboxProviderCache.set(spaceId, { provider, expiresAt: now + SANDBOX_PROVIDER_CACHE_TTL_MS });
    return provider;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SandboxRpcError("Unable to resolve target sandbox provider.", {
      method: "sandbox.provider",
      rpcErrorCode: "IO_ERROR",
      retryable: true,
      transportReason: message,
      diagnostics: { targetSpaceId: spaceId },
    });
  }
}

function withSandboxFailureResult<T extends AgentTool>(tool: T): T {
  const execute: AgentTool["execute"] = async (toolCallId, params, signal, onUpdate) => {
    try {
      const effectiveSignal = getEffectiveAbortSignal(signal);
      throwIfAborted(effectiveSignal);
      return await tool.execute(toolCallId, params, effectiveSignal, onUpdate);
    } catch (error) {
      if (!isSandboxRpcError(error)) throw error;
      const presentation = getSandboxRpcFailurePresentation(error);
      const traceContext = formatTraceContextForLog();
      const diagnostics = formatDiagnostics(error.diagnostics);
      const transportReason = error.transportReason ? ` transportReason=${JSON.stringify(truncateLogValue(error.transportReason))}` : "";
      logger.warn(`[Tool:${tool.name}] sandbox rpc failed kind=${presentation.kind} method=${error.method} rpcErrorCode=${error.rpcErrorCode} retryable=${error.retryable} infrastructure=${presentation.infrastructure}${transportReason}${traceContext ? ` ${traceContext}` : ""}${diagnostics ? ` ${diagnostics}` : ""}`);
      return {
        content: [{ type: "text", text: presentation.message }],
        details: createToolFailure(presentation.message, {
          retryable: error.retryable,
          infrastructure: presentation.infrastructure,
          rpcErrorCode: error.rpcErrorCode,
        }),
      };
    }
  };
  return { ...tool, execute } as T;
}

export function createSandboxCodingTools() {
  const toolCwd = SANDBOX_WORKSPACE_PATH;

  const sandboxReadTool = createReadTool(toolCwd, { operations: createRemoteReadOperations() });
  const sandboxLsTool = createLsTool(toolCwd, { operations: createRemoteLsOperations() });
  const sandboxFindTool = createFindTool(toolCwd, { operations: createRemoteFindOperations() });
  const sandboxGrepTool = createRemoteGrepTool();
  const crossSpaceReadTool = createLocalCrossSpaceReadTool();
  const crossSpaceLsTool = createLocalCrossSpaceLsTool();
  const crossSpaceFindTool = createLocalCrossSpaceFindTool();
  const crossSpaceGrepTool = createLocalCrossSpaceGrepTool();

  return [
    withSandboxFailureResult(createSpaceAwareReadTool({
      sandboxTool: sandboxReadTool,
      crossSpaceTool: crossSpaceReadTool,
      checkAccess: assertCurrentActorCanViewSpaceFiles,
      resolveSandboxProvider,
    })),
    withSandboxFailureResult(createBashTool(toolCwd, { operations: createRemoteBashOperations() })),
    withSandboxFailureResult(createEditTool(toolCwd, { operations: createRemoteEditOperations() })),
    withSandboxFailureResult(createWriteTool(toolCwd, { operations: createRemoteWriteOperations() })),
    withSandboxFailureResult(createSpaceAwareLsTool({
      sandboxTool: sandboxLsTool,
      crossSpaceTool: crossSpaceLsTool,
      checkAccess: assertCurrentActorCanViewSpaceFiles,
      resolveSandboxProvider,
    })),
    withSandboxFailureResult(createSpaceAwareFindTool({
      sandboxTool: sandboxFindTool,
      crossSpaceTool: crossSpaceFindTool,
      checkAccess: assertCurrentActorCanViewSpaceFiles,
      resolveSandboxProvider,
    })),
    withSandboxFailureResult(createSpaceAwareGrepTool({
      sandboxTool: sandboxGrepTool,
      crossSpaceTool: crossSpaceGrepTool,
      checkAccess: assertCurrentActorCanViewSpaceFiles,
      resolveSandboxProvider,
    })),
  ];
}
