import { createLogger } from "@cohub/infra/logging";
import { Hono } from "hono";
import { BillingAccessBlockedError, serializeBillingBlocked } from "@cohub/billing";
import { attachSandboxPublicEndpoints } from "../../sandbox-public-network.js";
import type {
  PersistMessageInput,
  UpdateSessionInfoInput,
} from "@cohub/protocol/model";
import type { ContentBlock } from "@cohub/protocol/core";
import {
  getSpaceById,
  getSpaceSessionById,
  persistMessageNode,
  updateSpaceSessionInfo,
  updateSpaceStatus,
  SandboxNotReadyError,
} from "../../space-sessions.js";
import { abortSessionTurn, failSessionTurn, interruptSessionTurn } from "../../session-turns.js";
import { hasPermission } from "../../permissions.js";
import { dispatchTurnFinalized, dispatchTurnUpdated } from "../../session-output.js";
import { submitSessionPrompt, type PromptAccessMode, type SubmitSessionPromptContext } from "../../session-prompts.js";
import { HarnessUnavailableError, ModelUnavailableError, parsePromptEnv, PromptEnvValidationError } from "@cohub/core/sessions";
import { verifyAppSessionToken } from "../../app-sessions.js";
import { mergePromptContextAuth, promptAuthContextFromAppSession } from "../../prompt-auth-context.js";
import { getSpaceSandboxBySpaceId, updateSpaceSandbox, recoverSpaceSandbox } from "../../space-sandboxes.js";
import { isSandboxReportTokenValid } from "../../crypto.js";
import { normalizeSandboxLifecycleStatus, normalizeSandboxRuntimeStatus } from "@cohub/sandbox-controller";
import {
  ensureInternalRequest,
  getRequestRemoteAddress,
  isPrivateNetworkAddress,
  requireValidId,
} from "../../lib/middleware.js";


const logger = createLogger({ serviceName: "cohub-api" });
const ALLOWED_SANDBOX_META_KEYS = new Set([
  "workspaceDir",
  "sandboxId",
  "lastProvisionedAt",
  "lastStatus",
  "lastError",
  "podName",
  "podIp",
  "wsEndpoint",
  "hostname",
  "imageVersion",
  "startedAt",
  "errorClass",
  "requiresPodRecreate",
  "mountPath",
  "recoverySource",
]);

function sanitizeSandboxMeta(input: Record<string, unknown> | null | undefined) {
  if (!input) return null;
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_SANDBOX_META_KEYS.has(key)) continue;
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      output[key] = value;
    }
  }
  return Object.keys(output).length > 0 ? output : null;
}

const router = new Hono();

// GET /internal/spaces/:id
router.get("/:id", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  return c.json({
    space: {
      id: space.id,
      userUuid: space.userUuid,
      name: space.name,
      meta: space.meta,
    },
  });
});

// POST /internal/spaces/:id/status
router.post("/:id/status", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c.req.json<{ status?: string; meta?: Record<string, unknown> | null }>().catch(() => null);
  if (!body?.status) return c.json({ message: "status is required" }, 400);

  await updateSpaceStatus(spaceId, body.status);

  const safeMeta = sanitizeSandboxMeta(body.meta);
  if (safeMeta) {
    try {
      const sandbox = await getSpaceSandboxBySpaceId(spaceId);
      await updateSpaceSandbox({
        spaceId,
        meta: {
          ...((sandbox?.meta as Record<string, unknown> | null) ?? {}),
          ...safeMeta,
        },
        lastHeartbeatAt: new Date(),
      });
    } catch (error) {
      logger.warn("[SandboxStatus] failed to persist sandbox meta:", error);
    }
  }

  return c.json({ ok: true });
});

// POST /internal/spaces/:id/sandbox-report
router.post("/:id/sandbox-report", async (c) => {
  const remoteAddress = getRequestRemoteAddress(c);
  if (!isPrivateNetworkAddress(remoteAddress)) return c.json({ message: "forbidden" }, 403);

  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = await c
    .req.json<{
      status?: string;
      podName?: string;
      sandboxId?: string;
      meta?: Record<string, unknown> | null;
    }>()
    .catch(() => null);
  if (!body?.status) return c.json({ message: "status is required" }, 400);

  const sandboxReportToken = c.req.header("x-sandbox-report-token")?.trim();
  if (!sandboxReportToken) return c.json({ message: "forbidden" }, 403);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  const sandboxMeta = (sandbox?.meta as Record<string, unknown> | null) ?? null;
  const expectedTokenHash = typeof sandboxMeta?.reportTokenHash === "string" ? sandboxMeta.reportTokenHash : null;
  if (!sandbox || !expectedTokenHash || !isSandboxReportTokenValid(sandboxReportToken, expectedTokenHash)) {
    return c.json({ message: "forbidden" }, 403);
  }

  const safeMeta = sanitizeSandboxMeta({
    ...(body.meta ?? {}),
    podName: body.podName?.trim() || sandbox.podName || null,
    sandboxId: body.sandboxId?.trim() || null,
  });
  const reportedImageVersion = typeof safeMeta?.imageVersion === "string"
    ? safeMeta.imageVersion.trim() || null
    : null;

  await updateSpaceSandbox({
    spaceId,
    status: normalizeSandboxLifecycleStatus(body.status),
    runtimeStatus: normalizeSandboxRuntimeStatus(body.status),
    podName: body.podName?.trim() || sandbox.podName || `sandbox-${spaceId}`,
    reportedImageVersion,
    reportedAt: new Date(),
    lastHeartbeatAt: new Date(),
    meta: {
      ...(sandboxMeta ?? {}),
      ...(safeMeta ?? {}),
    },
  });

  if (safeMeta?.requiresPodRecreate === true && safeMeta.errorClass === "stale_mount") {
    void recoverSpaceSandbox({
      spaceId,
      userUuid: space.userUuid,
      ownerUserUuid: space.userUuid,
      reason: typeof safeMeta.errorClass === "string" ? safeMeta.errorClass : body.status,
      source: "sandbox",
    }).catch((error) => logger.error(`[SandboxRecovery] auto recovery failed spaceId=${spaceId}`, error));
  }

  return c.json({ ok: true });
});

// POST /internal/spaces/:id/sandbox/recover
router.post("/:id/sandbox/recover", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const body = (await c.req.json<{ reason?: string; source?: string }>().catch(() => ({}))) as { reason?: string; source?: string };
  try {
    const result = await recoverSpaceSandbox({
      spaceId,
      userUuid: space.userUuid,
      ownerUserUuid: space.userUuid,
      reason: body.reason ?? "recover",
      source: body.source ?? "internal",
      verify: true,
    });
    return c.json(result);
  } catch (error) {
    logger.error("[sandbox] failed to recover sandbox", error);
    return c.json({ ok: false, status: "error", message: "failed to recover sandbox" }, 500);
  }
});


// GET /internal/spaces/:id/sandbox
router.get("/:id/sandbox", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  return c.json({ sandbox: attachSandboxPublicEndpoints(sandbox) });
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/info
router.post("/:spaceId/sessions/:sessionId/info", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);

  const body = await c.req.json<UpdateSessionInfoInput>().catch(() => null);
  if (!body) return c.json({ message: "invalid body" }, 400);

  await updateSpaceSessionInfo({
    spaceId,
    sessionId,
    title: body.title,
    updatedAt: body.updatedAt,
    meta: body.meta,
  });

  return c.json({ ok: true });
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/messages
router.post("/:spaceId/sessions/:sessionId/messages", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);

  const body = await c
    .req.json<{
      previousMessageId?: string | null;
      anchorUserMessageId?: string | null;
      userId?: string | null;
      idempotencyKey?: string;
      message?: PersistMessageInput["message"] & { id?: string | null };
    }>()
    .catch(() => null);
  if (!body?.idempotencyKey?.trim()) return c.json({ message: "idempotencyKey is required" }, 400);
  if (!body.message || !Array.isArray(body.message.content)) return c.json({ message: "message.content is required" }, 400);

  const messageNode = await persistMessageNode({
    spaceId,
    sessionId,
    previousMessageId: body.previousMessageId ?? null,
    anchorUserMessageId: body.anchorUserMessageId ?? null,
    userId: body.userId ?? null,
    idempotencyKey: body.idempotencyKey,
    message: {
      ...(body.message as PersistMessageInput["message"]),
      id: body.message.id ?? undefined,
      content: body.message.content as never,
    } as PersistMessageInput["message"] & { id?: string },
  });

  return c.json({ ok: true, message: messageNode });
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/turns/:turnId/interrupt
router.post("/:spaceId/sessions/:sessionId/turns/:turnId/interrupt", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);

  const body = await c.req.json<{ continuedByTurnId?: string | null; interruptedByTurnId?: string | null }>().catch(() => null);
  const continuedByTurnId = body?.continuedByTurnId?.trim() || body?.interruptedByTurnId?.trim();
  if (!continuedByTurnId || !requireValidId(continuedByTurnId)) return c.json({ message: "continuedByTurnId is required" }, 400);

  const result = await interruptSessionTurn({ spaceId, sessionId, turnId, continuedByTurnId });
  if (result.turn?.id && result.changed) {
    if (result.finalized) await dispatchTurnFinalized({ spaceId, sessionId, turn: result.turn }).catch((error) => logger.warn("[SessionTurn] failed to dispatch interrupted turn", error));
    else await dispatchTurnUpdated({ spaceId, sessionId, turn: result.turn }).catch((error) => logger.warn("[SessionTurn] failed to dispatch updated interrupted turn", error));
  }
  return c.json({ ok: true, turn: result.turn });
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/turns/:turnId/abort
router.post("/:spaceId/sessions/:sessionId/turns/:turnId/abort", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);

  const body = await c.req.json<{ actorUserId?: string | null }>().catch(() => null);
  const result = await abortSessionTurn({
    spaceId,
    sessionId,
    turnId,
    actorUserId: body?.actorUserId ?? null,
  });
  if (result.turn?.id && result.changed) {
    if (result.finalized) await dispatchTurnFinalized({ spaceId, sessionId, turn: result.turn }).catch((error) => logger.warn("[SessionTurn] failed to dispatch aborted turn", error));
    else await dispatchTurnUpdated({ spaceId, sessionId, turn: result.turn }).catch((error) => logger.warn("[SessionTurn] failed to dispatch updated aborted turn", error));
  }
  return c.json({ ok: true, turn: result.turn });
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/turns/:turnId/fail
router.post("/:spaceId/sessions/:sessionId/turns/:turnId/fail", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  const turnId = c.req.param("turnId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(turnId)) return c.json({ message: "turn not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);

  const body = await c.req.json<{ errorMessage?: string | null }>().catch(() => null);
  const errorMessage = body?.errorMessage?.trim() || "Agent turn failed.";
  const turn = await failSessionTurn({ sessionId, turnId, errorMessage });
  if (turn) await dispatchTurnFinalized({ spaceId, sessionId, turn }).catch((error) => logger.warn("[SessionTurn] failed to dispatch failed turn", error));
  return c.json({ ok: true, turn });
});

// POST /internal/spaces/:spaceId/sessions/:sessionId/prompt
router.post("/:spaceId/sessions/:sessionId/prompt", async (c) => {
  const forbidden = ensureInternalRequest(c);
  if (forbidden) return forbidden;

  const spaceId = c.req.param("spaceId");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "session not found" }, 404);

  const session = await getSpaceSessionById(sessionId);
  if (!session || session.spaceId !== spaceId) return c.json({ message: "session not found" }, 404);

  const body = await c
    .req.json<{
      content: ContentBlock[];
      userId?: string | null;
      authToken?: string | null;
      clientMessageId?: string | null;
      source?: string | null;
      model?: string | null;
      provider?: string | null;
      harness?: "cohub" | "pi" | "codex" | null;
      thinkingLevel?: string | null;
      accessMode?: PromptAccessMode | null;
      env?: unknown;
      context?: SubmitSessionPromptContext | null;
    }>()
    .catch(() => null);
  if (!body || !Array.isArray(body.content) || body.content.length === 0) {
    return c.json({ message: "content is required" }, 400);
  }
  const userId = body.userId?.trim();
  if (!userId) return c.json({ message: "userId is required" }, 400);
  const accessMode = body.accessMode ?? "full_access";
  if (accessMode !== "read_only" && accessMode !== "full_access") {
    return c.json({ message: "accessMode must be one of: read_only, full_access" }, 400);
  }
  const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const promptThinkingLevel = typeof body.thinkingLevel === "string" && body.thinkingLevel.trim() && VALID_THINKING_LEVELS.has(body.thinkingLevel.trim()) ? body.thinkingLevel.trim() : body.thinkingLevel === undefined || body.thinkingLevel === null ? undefined : null;
  if (promptThinkingLevel === null) return c.json({ message: "thinkingLevel must be one of: off, minimal, low, medium, high, xhigh, max" }, 400);
  const promptPermission = accessMode === "read_only" ? "session.prompt.readonly" : "session.prompt.fullaccess";
  const appSession = body.authToken ? verifyAppSessionToken(body.authToken) : null;
  const permissionSubject = appSession && appSession.userUuid === userId
    ? ({ uuid: userId, appSession } as { uuid: string; appSession: typeof appSession })
    : { uuid: userId };
  const promptAuth = appSession?.userUuid === userId ? await promptAuthContextFromAppSession(appSession, spaceId) : null;
  if (!(await hasPermission(permissionSubject, promptPermission, { spaceId, sessionId }))) {
    return c.json({ message: "forbidden" }, 403);
  }
  const clientMessageId = body.clientMessageId?.trim();
  if (!clientMessageId) return c.json({ message: "clientMessageId is required" }, 400);

  let promptEnv: Record<string, string> | null = null;
  try {
    promptEnv = parsePromptEnv(body.env);
  } catch (error) {
    if (error instanceof PromptEnvValidationError) return c.json({ message: error.message }, 400);
    throw error;
  }

  try {
    const result = await submitSessionPrompt({
      spaceId,
      sessionId,
      userId,
      clientMessageId,
      content: body.content,
      source: body.source?.trim() || "scheduled_task",
      model: body.model ?? null,
      provider: body.provider ?? null,
      harness: body.harness ?? null,
      thinkingLevel: promptThinkingLevel ?? null,
      accessMode,
      env: promptEnv,
      context: mergePromptContextAuth(body.context ?? null, promptAuth),
    });
    return c.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof HarnessUnavailableError) return c.json({ code: error.code, message: error.message }, 503);
    if (error instanceof ModelUnavailableError) {
      return c.json({ code: error.code, message: "requested model is not available" }, 422);
    }
    if (error instanceof SandboxNotReadyError) return c.json({ message: "sandbox is not ready" }, 503);
    if (error instanceof BillingAccessBlockedError) return c.json(serializeBillingBlocked(error), 402);
    throw error as Error;
  }
});

export default router;
