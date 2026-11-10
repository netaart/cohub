import { Hono, type Context } from "hono";
import { isUserAppFilter, isUserCronJobFilter } from "@cohub/protocol";
import { InvalidUserListCursorError, listUserApps, listUserCronJobs, resolveUserListLimit } from "../user-lists.js";
import { authzDenied, useAuth } from "../lib/middleware.js";
import { asAccountIdentity, hasPermission } from "../permissions.js";

const router = new Hono();

async function accountListRequest(c: Context, permission: "user.app.list" | "user.cronjob.list") {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  if (!(await hasPermission(user, permission, { spaceId: "" }))) return authzDenied(c);
  return asAccountIdentity(user) ?? authzDenied(c);
}

async function respond(c: Context, load: () => Promise<unknown>) {
  try {
    return c.json(await load());
  } catch (error) {
    if (error instanceof InvalidUserListCursorError) return c.json({ message: error.message }, 400);
    throw error;
  }
}

router.get("/apps", async (c) => {
  const identity = await accountListRequest(c, "user.app.list");
  if (identity instanceof Response) return identity;
  const filter = c.req.query("filter") ?? "mine";
  if (!isUserAppFilter(filter)) return c.json({ message: "filter must be one of: mine, all, disabled" }, 400);
  return respond(c, () => listUserApps(identity.uuid, {
    filter,
    cursor: c.req.query("cursor"),
    limit: resolveUserListLimit(c.req.query("limit")),
  }));
});

router.get("/cron-jobs", async (c) => {
  const identity = await accountListRequest(c, "user.cronjob.list");
  if (identity instanceof Response) return identity;
  const filter = c.req.query("filter") ?? "mine";
  if (!isUserCronJobFilter(filter)) return c.json({ message: "filter must be one of: mine, all, paused, attention" }, 400);
  return respond(c, () => listUserCronJobs(identity.uuid, {
    filter,
    cursor: c.req.query("cursor"),
    limit: resolveUserListLimit(c.req.query("limit")),
  }));
});

export default router;
