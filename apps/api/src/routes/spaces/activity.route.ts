import { Hono } from "hono";
import { createLogger } from "@cohub/infra/logging";
import {
	getOptionalAuth,
	requireValidId,
	authzDenied,
} from "../../lib/middleware.js";
import { getSpaceMemberRole, hasPermission } from "../../permissions.js";
import {
	loadSpaceActivity,
	stripActivityCost,
} from "../../space-activity.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

/**
 * GET /api/spaces/:id/activity?days=N
 * Everything the space Activity page renders in one response: usage hourly
 * rollups + summary, model/app rankings, and per-user contributor stats.
 * Cost figures are stripped for viewers without space-management access
 * (host/builder) — the aggregate shape stays identical so the client can
 * treat them uniformly.
 */
router.get("/", async (c) => {
	const user = getOptionalAuth(c);
	const spaceId = c.req.param("id");
	if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
	if (!(await hasPermission(user, "space.view", { spaceId }))) return authzDenied(c);

	const actorRole = user?.uuid
		? await getSpaceMemberRole(spaceId, user.uuid)
		: null;
	const includeCost = actorRole === "host" || actorRole === "builder";

	try {
		const activity = await loadSpaceActivity({
			spaceId,
			daysParam: c.req.query("days"),
		});
		return c.json(includeCost ? activity : stripActivityCost(activity));
	} catch (error) {
		logger.error("[space-activity] request failed", {
			spaceId,
			days: c.req.query("days") ?? "30",
			error,
		});
		return c.json({ message: "failed to load activity data" }, 500);
	}
});

export default router;
