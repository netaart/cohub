import { Hono } from "hono";
import { createLogger } from "@cohub/infra/logging";
import { authzDenied, getOptionalAuth, requireValidId } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import { loadSpaceOverview } from "../../space-overview.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

/** GET /api/spaces/:id/overview */
router.get("/", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  const [canView, includeRevenue, includeSchedules] = await Promise.all([
    hasPermission(user, "space.view", { spaceId }),
    hasPermission(user, "space.commerce.view", { spaceId }),
    hasPermission(user, "cronjob.view", { spaceId }),
  ]);
  if (!canView) return authzDenied(c);

  try {
    return c.json(await loadSpaceOverview({ spaceId, includeRevenue, includeSchedules }));
  } catch (error) {
    logger.error("[space-overview] request failed", { spaceId, error });
    return c.json({ message: "failed to load space overview" }, 500);
  }
});

export default router;
