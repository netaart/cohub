import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  measureDesktopCommandPayload,
  parseDesktopCommand,
  parseDesktopCommandError,
  parseDesktopCommandId,
  DESKTOP_COMMAND_ID_MAX_LENGTH,
  DESKTOP_COMMAND_MAX_BYTES,
  DESKTOP_COMMAND_PAYLOAD_MAX_BYTES,
  type DesktopCommandStatus,
} from "@cohub/protocol/desktop-command";
import { isRequestSourceClientId } from "@cohub/protocol/provenance";
import { getAppSessionPrincipal, useAuth } from "../lib/middleware.js";
import { getRequestSource } from "../lib/request-source.js";
import { canAppSessionSettleDesktopCommand } from "../desktop-command-auth.js";
import {
  acceptDesktopCommand,
  createDesktopCommand,
  getDesktopCommand,
  settleDesktopCommand,
  DesktopCommandOwnershipError,
} from "../desktop-commands.js";

const router = new Hono();

/**
 * Authorization rests on the authenticated user alone: the target derives from the
 * caller's identity, delivery is scoped to their own room, and the frontend acts
 * with their own credentials. A Work session may only complete a command that
 * opened that same Work. Client ids only order that user's own tabs.
 */

/** Runs before `json()`, so an oversized body never reaches memory. */
const limitBody = bodyLimit({
  maxSize: DESKTOP_COMMAND_MAX_BYTES + 4 * 1024,
  onError: (c) => c.json({ message: `body exceeds ${DESKTOP_COMMAND_MAX_BYTES} bytes` }, 413),
});

const REPORTABLE_STATUSES = new Set<DesktopCommandStatus>([
  "applied",
  "desktop_host_unavailable",
  "rejected",
  "unsupported",
]);

router.post("/", limitBody, async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = parseDesktopCommand(body?.command);
  if (!parsed.command) return c.json({ message: parsed.error }, 400);

  const source = getRequestSource(c);
  const requestedTarget = typeof body?.targetClientId === "string" ? body.targetClientId.trim() : "";
  if (requestedTarget && !isRequestSourceClientId(requestedTarget)) {
    return c.json({ message: "targetClientId has an unsupported format" }, 400);
  }
  const targetClientId = requestedTarget || source?.clientId || null;

  let commandId = "";
  if (body?.commandId !== undefined && body.commandId !== null && body.commandId !== "") {
    const parsedId = parseDesktopCommandId(body.commandId);
    if (!parsedId) {
      return c.json(
        {
          message: `commandId must be 1-${DESKTOP_COMMAND_ID_MAX_LENGTH} characters of A-Z, a-z, 0-9, _ or -`,
        },
        400,
      );
    }
    commandId = parsedId;
  }

  try {
    const { record } = await createDesktopCommand({
      commandId,
      actorUserId: user.uuid,
      command: parsed.command,
      targetClientId,
      source,
    });
    return c.json({ command: record });
  } catch (error) {
    if (error instanceof DesktopCommandOwnershipError) return c.json({ message: "forbidden" }, 403);
    throw error;
  }
});

router.get("/:commandId", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const commandId = parseDesktopCommandId(c.req.param("commandId"));
  if (!commandId) return c.json({ message: "desktop command not found" }, 404);
  const record = await getDesktopCommand(commandId);
  if (!record || record.actorUserId !== user.uuid) {
    return c.json({ message: "desktop command not found" }, 404);
  }
  return c.json({ command: record });
});

router.post("/:commandId/accept", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const commandId = parseDesktopCommandId(c.req.param("commandId"));
  // Only the host tab runs commands; App sessions just report results.
  if (!commandId || getAppSessionPrincipal(c)) return c.json({ message: "desktop command not found" }, 404);

  const acceptance = await acceptDesktopCommand({
    commandId,
    actorUserId: user.uuid,
    clientId: getRequestSource(c)?.clientId ?? null,
  });
  if (acceptance.ok) return c.json({ accepted: acceptance.accepted, command: acceptance.record });
  return acceptance.reason === "forbidden"
    ? c.json({ message: "forbidden" }, 403)
    : c.json({ message: "desktop command not found" }, 404);
});

router.post("/:commandId/result", limitBody, async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;

  const commandId = parseDesktopCommandId(c.req.param("commandId"));
  if (!commandId) return c.json({ message: "desktop command not found" }, 404);

  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const status = typeof body?.status === "string" ? (body.status as DesktopCommandStatus) : null;
  if (!status || !REPORTABLE_STATUSES.has(status)) {
    return c.json(
      { message: `status must be one of: ${[...REPORTABLE_STATUSES].join(", ")}` },
      400,
    );
  }
  const error = parseDesktopCommandError(body?.error, status);
  const reportedSize = measureDesktopCommandPayload({ result: body?.result, error });
  if (reportedSize === null) {
    return c.json({ message: "result must be JSON-serializable" }, 400);
  }
  if (reportedSize > DESKTOP_COMMAND_PAYLOAD_MAX_BYTES) {
    return c.json({ message: `result exceeds ${DESKTOP_COMMAND_PAYLOAD_MAX_BYTES} bytes` }, 413);
  }

  let reportingClientId = getRequestSource(c)?.clientId ?? null;
  const appSession = getAppSessionPrincipal(c);
  if (appSession) {
    const command = await getDesktopCommand(commandId);
    if (!canAppSessionSettleDesktopCommand(command, {
      actorUserId: user.uuid,
      appId: appSession.appId,
    })) {
      return c.json({ message: "desktop command not found" }, 404);
    }
    reportingClientId = command.targetClientId;
  }

  const settled = await settleDesktopCommand({
    commandId,
    actorUserId: user.uuid,
    reportingClientId,
    status,
    result: body?.result,
    error,
  });

  if (settled.ok) return c.json({ command: settled.record });
  if (settled.reason === "not_found") return c.json({ message: "desktop command not found" }, 404);
  if (settled.reason === "forbidden") return c.json({ message: "forbidden" }, 403);
  return c.json({ command: settled.record }, 200);
});

export default router;
