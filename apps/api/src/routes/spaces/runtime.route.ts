import { Hono } from "hono";
import { RUNTIME_CATALOG_REFRESH_CHANNEL, displaysSnapshotSchema, fileWatcherStatusSchema, runtimeDisplaysKey, isLocalHarness, runtimeStopConfirmationSchema, runtimeWorkspaceKey, approvalDecisionSchema, APPROVAL_DECISIONS, runtimeWorkspaceStatus } from "@cohub/protocol";
import { useAuth, requireValidId, authzDenied } from "../../lib/middleware.js";
import { getSpaceSandboxBySpaceId } from "../../space-sandboxes.js";
import { hasPermission } from "../../permissions.js";
import { getRuntimeRegistration, getSessionRuntimeRecovery, confirmRuntimeStopped } from "../../runtime.js";
import { ApprovalError, decideRuntimeApproval, listRuntimeApprovals } from "../../runtime-approvals.js";
import runtimeArchivesRouter from "./runtime-archives.route.js";
import { redisCommandClient } from "../../redis.js";

const router = new Hono();

router.route("/:id/runtime/archives", runtimeArchivesRouter);

router.post("/:id/runtime/models/:harness/refresh", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const { id: spaceId, harness } = c.req.param();
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!isLocalHarness(harness)) return c.json({ message: "Unknown local Harness" }, 400);
  if (!(await hasPermission(user, "sandbox.view", { spaceId }))) return authzDenied(c);
  const registration = await getRuntimeRegistration(spaceId);
  if (!registration?.client?.catalogRefresh || !registration.capabilities.harnesses.includes(harness)) return c.json({ accepted: false });
  const { connectionId } = registration;
  const accepted = await redisCommandClient.eval(`
    if redis.call('EXISTS', KEYS[1]) == 1 then return 1 end
    if redis.call('PUBLISH', ARGV[1], ARGV[2]) == 0 then return 0 end
    redis.call('SET', KEYS[1], '1', 'EX', 30)
    return 1`, 1, `runtime:catalog-refresh:${connectionId}:${harness}`, RUNTIME_CATALOG_REFRESH_CHANNEL,
    JSON.stringify({ type: "runtime.catalog.refresh", spaceId, connectionId, harness }));
  return accepted === 1 ? c.json({ accepted: true }, 202) : c.json({ accepted: false });
});

router.get("/:id/runtime", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "sandbox.view", { spaceId }))) return authzDenied(c);
  const [sandbox, registration] = await Promise.all([
    getSpaceSandboxBySpaceId(spaceId), getRuntimeRegistration(spaceId),
  ]);
  const local = sandbox?.provider === "local" && Boolean(registration);
  const [rawWatcher, rawDisplays] = local
    ? await Promise.all([
      redisCommandClient.get(`sandbox:watcher:${spaceId}`).catch(() => null),
      redisCommandClient.get(runtimeDisplaysKey(spaceId)).catch(() => null),
    ])
    : [null, null];
  let fileWatcher = null;
  if (rawWatcher) {
    try {
      const parsed = fileWatcherStatusSchema.safeParse(JSON.parse(rawWatcher));
      if (parsed.success) fileWatcher = parsed.data;
    } catch { /* Invalid telemetry never affects Runtime availability. */ }
  }
  let displays = null;
  if (rawDisplays) {
    try {
      const parsed = displaysSnapshotSchema.safeParse(JSON.parse(rawDisplays));
      if (parsed.success) displays = parsed.data.displays;
    } catch { /* A malformed snapshot only hides displays. */ }
  }
  const rawWorkspace = registration ? await redisCommandClient.get(runtimeWorkspaceKey(spaceId)) : null;
  const workspace = runtimeWorkspaceStatus(registration?.runtimeId, rawWorkspace);
  return c.json({ kind: sandbox?.provider ?? "cloud", online: Boolean(registration), runtimeId: registration?.runtimeId ?? null, capabilities: registration?.capabilities ?? null, client: registration?.client ?? null, fileWatcher: workspace.online ? fileWatcher : null, displays: workspace.online ? displays : null, workspace, observedAt: new Date().toISOString() });
});

router.get("/:id/sessions/:sessionId/runtime", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "Session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId, sessionId }))) return authzDenied(c);
  const [recovery, canManage] = await Promise.all([
    getSessionRuntimeRecovery(spaceId, sessionId),
    hasPermission(user, "sandbox.manage", { spaceId }),
  ]);
  return c.json({ ...recovery, canManage });
});

router.get("/:id/sessions/:sessionId/approvals", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "Session not found" }, 404);
  if (!(await hasPermission(user, "session.view", { spaceId, sessionId }))) return authzDenied(c);
  const [approvals, canDecide] = await Promise.all([
    listRuntimeApprovals(spaceId, sessionId),
    hasPermission(user, "session.prompt.fullaccess", { spaceId, sessionId }),
  ]);
  return c.json({ approvals, canDecide });
});

// Approving runs the request on the Runtime's machine, which a full-access prompt could ask for anyway.
router.post("/:id/sessions/:sessionId/approvals/:approvalId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const sessionId = c.req.param("sessionId");
  const approvalId = c.req.param("approvalId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId) || !requireValidId(approvalId)) return c.json({ message: "Approval not found" }, 404);
  if (!(await hasPermission(user, "session.prompt.fullaccess", { spaceId, sessionId }))) return authzDenied(c);
  const parsed = approvalDecisionSchema.safeParse((await c.req.json().catch(() => null) as { decision?: unknown } | null)?.decision);
  if (!parsed.success) return c.json({ message: `decision must be one of: ${APPROVAL_DECISIONS.join(", ")}` }, 400);
  try { await decideRuntimeApproval(spaceId, sessionId, approvalId, parsed.data); }
  catch (error) {
    if (error instanceof ApprovalError) return c.json({ message: error.message }, error.status);
    throw error;
  }
  return c.json({ accepted: true }, 202);
});

router.post("/:id/sessions/:sessionId/runtime/confirm-stopped", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  const sessionId = c.req.param("sessionId");
  if (!requireValidId(spaceId) || !requireValidId(sessionId)) return c.json({ message: "Session not found" }, 404);
  if (!(await hasPermission(user, "sandbox.manage", { spaceId }))) return authzDenied(c);
  const parsed = runtimeStopConfirmationSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ message: "Invalid confirmation" }, 400);
  const accepted = await confirmRuntimeStopped(spaceId, sessionId, user.uuid, parsed.data);
  if (!accepted) return c.json({ message: "Runtime state changed; refresh before confirming" }, 409);
  return c.json({ accepted: true }, 202);
});

export default router;
