import { randomUUID } from "node:crypto";
import { Hono, type Context } from "hono";
import * as z from "zod";
import { createLogger } from "@cohub/infra/logging";
import {
  displayActorSchema,
  displayActParamsSchema,
  displayCaptureParamsSchema,
  displayHandoverParamsSchema,
  displayIdSchema,
  displayInputBatchSchema,
  displaySessionRequestSchema,
  displayTreeParamsSchema,
  displayVirtualStartSchema,
  isUuid,
} from "@cohub/protocol";
import { hasPermission } from "../../permissions.js";
import { authzDenied, requireValidId, useAuth } from "../../lib/middleware.js";
import { getIceServers } from "../../rtc/ice.js";
import { displayErrorResponse } from "../../display-errors.js";
import { callSandboxRpc } from "../../space-sandbox-rpc.js";
import { enqueueSessionAbort, getSpaceSessionById } from "../../space-sessions.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

// Watching a display takes sandbox.view; steering it, or starting a virtual
// screen, takes command.execute, as running a command on the machine does.
type Permission = "sandbox.view" | "command.execute";

async function authorize(c: Context, permission: Permission) {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, permission, { spaceId }))) return authzDenied(c);
  return { user, spaceId };
}

function displayParam(c: Context): string | null {
  const parsed = displayIdSchema.safeParse(c.req.param("displayId"));
  return parsed.success ? parsed.data : null;
}

function displayError(c: Context, error: unknown, spaceId: string) {
  const mapped = displayErrorResponse(error);
  if (!mapped) logger.warn("[Displays] request failed", { spaceId, error });
  const { status, code, message } = mapped ?? { status: 502 as const, code: "display_error", message: "The display request failed." };
  return c.json({ code, message }, status);
}

router.get("/:id/displays", async (c) => {
  const auth = await authorize(c, "sandbox.view");
  if (auth instanceof Response) return auth;
  try {
    return c.json(await callSandboxRpc(auth.spaceId, "display.list", {}));
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.get("/:id/displays/:displayId/capture", async (c) => {
  const auth = await authorize(c, "sandbox.view");
  if (auth instanceof Response) return auth;
  const display = displayParam(c);
  if (!display) return c.json({ code: "display_not_found", message: "display not found" }, 404);
  const query = c.req.query();
  const parsed = displayCaptureParamsSchema.safeParse({
    ...(query.format ? { format: query.format } : {}),
    ...(query.quality ? { quality: Number(query.quality) } : {}),
    ...(query.maxSize ? { maxSize: Number(query.maxSize) } : {}),
    ...(query.window ? { window: query.window } : {}),
  });
  if (!parsed.success) return c.json({ code: "invalid_request", message: parsed.error.issues[0]?.message ?? "invalid capture" }, 400);
  try {
    const capture = await callSandboxRpc(auth.spaceId, "display.capture", { ...parsed.data, display });
    c.header("Cache-Control", "no-store");
    return c.json(capture);
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.get("/:id/displays/:displayId/tree", async (c) => {
  const auth = await authorize(c, "sandbox.view");
  if (auth instanceof Response) return auth;
  const display = displayParam(c);
  if (!display) return c.json({ code: "display_not_found", message: "display not found" }, 404);
  const maxElements = c.req.query("maxElements");
  const parsed = displayTreeParamsSchema.safeParse({
    ...(maxElements ? { maxElements: Number(maxElements) } : {}),
    ...(c.req.query("compact") === "true" ? { compact: true } : {}),
    ...(c.req.query("window") ? { window: c.req.query("window") } : {}),
  });
  if (!parsed.success) return c.json({ code: "invalid_request", message: parsed.error.issues[0]?.message ?? "invalid tree" }, 400);
  try {
    const tree = await callSandboxRpc(auth.spaceId, "display.tree", { ...parsed.data, display });
    c.header("Cache-Control", "no-store");
    return c.json(tree);
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.post("/:id/displays/virtual", async (c) => {
  const auth = await authorize(c, "command.execute");
  if (auth instanceof Response) return auth;
  const parsed = displayVirtualStartSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ code: "invalid_request", message: parsed.error.issues[0]?.message ?? "invalid size" }, 400);
  try {
    const result = await callSandboxRpc(auth.spaceId, "display.start", parsed.data);
    logger.info("[Displays] virtual screen started", { spaceId: auth.spaceId, userId: auth.user.uuid, size: parsed.data.size });
    return c.json(result);
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.delete("/:id/displays/virtual", async (c) => {
  const auth = await authorize(c, "command.execute");
  if (auth instanceof Response) return auth;
  try {
    const result = await callSandboxRpc(auth.spaceId, "display.stop", {});
    logger.info("[Displays] virtual screen stopped", { spaceId: auth.spaceId, userId: auth.user.uuid });
    return c.json(result);
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.post("/:id/displays/:displayId/input", async (c) => {
  const auth = await authorize(c, "command.execute");
  if (auth instanceof Response) return auth;
  const display = displayParam(c);
  if (!display) return c.json({ code: "display_not_found", message: "display not found" }, 404);
  const parsed = displayInputBatchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: "invalid_request", message: parsed.error.issues[0]?.message ?? "invalid input" }, 400);
  try {
    return c.json(await callSandboxRpc(auth.spaceId, "display.input", { ...parsed.data, display }));
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.post("/:id/displays/:displayId/act", async (c) => {
  const auth = await authorize(c, "command.execute");
  if (auth instanceof Response) return auth;
  const display = displayParam(c);
  if (!display) return c.json({ code: "display_not_found", message: "display not found" }, 404);
  const parsed = displayActParamsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: "invalid_request", message: parsed.error.issues[0]?.message ?? "invalid plan" }, 400);
  const plan = randomUUID();
  const cancel = () => void callSandboxRpc(auth.spaceId, "display.interrupt", { display, plan }).catch(() => undefined);
  const signal = c.req.raw.signal;
  if (signal.aborted) return c.body(null, 499 as never);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const result = await callSandboxRpc(auth.spaceId, "display.act", { ...parsed.data, display, plan });
    c.header("Cache-Control", "no-store");
    return c.json(result);
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
});

router.post("/:id/displays/:displayId/interrupt", async (c) => {
  const auth = await authorize(c, "command.execute");
  if (auth instanceof Response) return auth;
  const display = displayParam(c);
  if (!display) return c.json({ code: "display_not_found", message: "display not found" }, 404);
  try {
    const { activity } = await callSandboxRpc(auth.spaceId, "display.interrupt", { display });
    logger.info("[Displays] stopped", { spaceId: auth.spaceId, display, userId: auth.user.uuid, sessionId: activity?.sessionId });
    const session = activity?.sessionId ? await getSpaceSessionById(activity.sessionId) : null;
    if (session?.spaceId === auth.spaceId && (await hasPermission(auth.user, "session.prompt.fullaccess", { spaceId: session.spaceId, sessionId: session.id }))) {
      await enqueueSessionAbort({ sessionId: session.id, actorUserId: auth.user.uuid, turnId: activity?.turnId ?? null });
    }
    return c.body(null, 204);
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.post("/:id/displays/:displayId/handover", async (c) => {
  const auth = await authorize(c, "command.execute");
  if (auth instanceof Response) return auth;
  const display = displayParam(c);
  if (!display) return c.json({ code: "display_not_found", message: "display not found" }, 404);
  const parsed = displayHandoverParamsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ code: "invalid_request", message: parsed.error.issues[0]?.message ?? "invalid handover" }, 400);
  try {
    const result = await callSandboxRpc(auth.spaceId, "display.handover", { ...parsed.data, display });
    c.header("Cache-Control", "no-store");
    return c.json(result);
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.delete("/:id/displays/:displayId/handover", async (c) => {
  const auth = await authorize(c, "command.execute");
  if (auth instanceof Response) return auth;
  const display = displayParam(c);
  if (!display) return c.json({ code: "display_not_found", message: "display not found" }, 404);
  try {
    await callSandboxRpc(auth.spaceId, "display.handback", { display });
    return c.body(null, 204);
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.get("/:id/displays/:displayId/windows", async (c) => {
  const auth = await authorize(c, "sandbox.view");
  if (auth instanceof Response) return auth;
  const display = displayParam(c);
  if (!display) return c.json({ code: "display_not_found", message: "display not found" }, 404);
  try {
    c.header("Cache-Control", "no-store");
    return c.json(await callSandboxRpc(auth.spaceId, "display.windows", { display }));
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

const recordingRequestSchema = z.object({ auto: z.boolean().optional(), actor: displayActorSchema.optional() });

router.post("/:id/displays/:displayId/recording", async (c) => {
  const auth = await authorize(c, "command.execute");
  if (auth instanceof Response) return auth;
  const display = displayParam(c);
  if (!display) return c.json({ code: "display_not_found", message: "display not found" }, 404);
  const parsed = recordingRequestSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ code: "invalid_request", message: parsed.error.issues[0]?.message ?? "invalid recording" }, 400);
  const { auto, actor } = parsed.data;
  try {
    const result = await callSandboxRpc(auth.spaceId, "display.record.start", {
      display, by: { userId: auth.user.uuid, ...actor }, ...(auto ? { auto } : {}),
    });
    logger.info("[Displays] recording started", { spaceId: auth.spaceId, display, userId: auth.user.uuid, auto: Boolean(auto), sessionId: actor?.sessionId });
    return c.json(result);
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.delete("/:id/displays/:displayId/recording", async (c) => {
  const auth = await authorize(c, "command.execute");
  if (auth instanceof Response) return auth;
  const display = displayParam(c);
  if (!display) return c.json({ code: "display_not_found", message: "display not found" }, 404);
  const auto = c.req.query("auto") === "true";
  try {
    await callSandboxRpc(auth.spaceId, "display.record.stop", { display, ...(auto ? { auto } : {}) });
    logger.info("[Displays] recording stopped", { spaceId: auth.spaceId, display, userId: auth.user.uuid, auto });
    return c.body(null, 204);
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.get("/:id/displays/:displayId/apps", async (c) => {
  const auth = await authorize(c, "sandbox.view");
  if (auth instanceof Response) return auth;
  const display = displayParam(c);
  if (!display) return c.json({ code: "display_not_found", message: "display not found" }, 404);
  try {
    return c.json(await callSandboxRpc(auth.spaceId, "display.apps", { display }));
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.post("/:id/displays/:displayId/sessions", async (c) => {
  const parsed = displaySessionRequestSchema.safeParse(await c.req.json().catch(() => null));
  const control = parsed.data?.control ?? true;
  const auth = await authorize(c, control ? "command.execute" : "sandbox.view");
  if (auth instanceof Response) return auth;
  const display = displayParam(c);
  if (!display) return c.json({ code: "display_not_found", message: "display not found" }, 404);
  if (!parsed.success) return c.json({ code: "invalid_request", message: parsed.error.issues[0]?.message ?? "invalid offer" }, 400);
  const sessionId = randomUUID();
  try {
    const { iceServers } = await getIceServers(auth.user.uuid);
    const { answer } = await callSandboxRpc(auth.spaceId, "rtc.open", {
      sessionId, display, offer: parsed.data.offer, iceServers, control, userId: auth.user.uuid,
    });
    logger.info("[Displays] session opened", { spaceId: auth.spaceId, display, sessionId, userId: auth.user.uuid, control });
    return c.json({ sessionId, answer }, 201);
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.delete("/:id/displays/:displayId/sessions/:sessionId", async (c) => {
  const auth = await authorize(c, "sandbox.view");
  if (auth instanceof Response) return auth;
  const sessionId = c.req.param("sessionId");
  if (!isUuid(sessionId)) return c.json({ code: "invalid_request", message: "invalid session" }, 400);
  try {
    const result = await callSandboxRpc(auth.spaceId, "rtc.close", { sessionId, userId: auth.user.uuid });
    logger.info("[Displays] session closed", { spaceId: auth.spaceId, sessionId, userId: auth.user.uuid, closed: result.closed });
    return c.json(result);
  } catch (error) {
    return displayError(c, error, auth.spaceId);
  }
});

router.get("/:id/rtc/ice-servers", async (c) => {
  const auth = await authorize(c, "sandbox.view");
  if (auth instanceof Response) return auth;
  c.header("Cache-Control", "private, no-store");
  return c.json(await getIceServers(auth.user.uuid));
});

export default router;
