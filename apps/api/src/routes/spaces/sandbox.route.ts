import { Hono } from "hono";
import type { spaces } from "@cohub/db";
import { useAuth, getOptionalAuth, requireValidId, authzDenied } from "../../lib/middleware.js";
import { attachSandboxPublicEndpoints } from "../../sandbox-public-network.js";
import { getSpaceSandboxBySpaceId, recoverSpaceSandbox } from "../../space-sandboxes.js";
import { getSpaceById } from "../../space-sessions.js";
import { enqueueTask } from "../../tasks.js";
import { RUN_COMMAND_TASK_TYPE } from "@cohub/core/commands";
import { hasPermission } from "../../permissions.js";
import type { AuthUser } from "../../lib/middleware.js";
import { getRequestSource } from "../../lib/request-source.js";

const router = new Hono();

function getSpaceProvisionParams(
  user: AuthUser,
  space: typeof spaces.$inferSelect,
) {
  return {
    spaceId: space.id,
    userUuid: user.uuid,
    ownerUserUuid: space.userUuid,
  };
}

router.get("/:id/sandbox", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "sandbox.view", { spaceId }))) return authzDenied(c);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  return c.json({ sandbox: attachSandboxPublicEndpoints(sandbox) });
});

router.get("/:id/sandbox/ports", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "sandbox.view", { spaceId }))) return authzDenied(c);

  const sandbox = await getSpaceSandboxBySpaceId(spaceId);
  return c.json({ endpoints: attachSandboxPublicEndpoints(sandbox)?.publicEndpoints ?? {} });
});

router.post("/:id/sandbox/recreate", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "sandbox.manage", { spaceId }))) return authzDenied(c);

  const space = await getSpaceById(spaceId);
  if (!space) return c.json({ message: "space not found" }, 404);

  const result = await recoverSpaceSandbox({
    ...getSpaceProvisionParams(user, space),
    reason: "manual_recreate",
    source: "manual",
    verify: true,
  });

  return c.json(result);
});

const MAX_COMMAND_LENGTH = 16 * 1024;

router.post("/:id/commands", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "command.execute", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ command?: string }>().catch(() => null);
  const command = body?.command?.trim();
  if (!command) return c.json({ message: "command is required" }, 400);
  if (command.length > MAX_COMMAND_LENGTH) return c.json({ message: `command is too long; max ${MAX_COMMAND_LENGTH} characters` }, 400);
  const cwd = "/workspace";
  const sourceClientId = getRequestSource(c)?.clientId;

  const { taskRunId } = await enqueueTask({
    type: RUN_COMMAND_TASK_TYPE,
    spaceId,
    userId: user.uuid,
    data: {
      command,
      cwd,
      source: "command_palette",
      ...(sourceClientId ? { sourceClientId } : {}),
    },
  });

  return c.json({ taskRunId });
});

export default router;
