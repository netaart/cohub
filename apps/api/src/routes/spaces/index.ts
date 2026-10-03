import { Hono } from "hono";
import { maybeEnqueueCrossSpaceReference } from "../../lib/cross-space-reference.js";
import spacesRouter, { meSpacesRouter } from "./spaces.route.js";
import fsRouter from "./fs.route.js";
import membersRouter from "./members.route.js";
import accessRouter from "./access.route.js";
import activityRouter from "./activity.route.js";
import usageRouter from "./usage.route.js";
import invitationsRouter from "./invitations.route.js";
import labelsRouter, { getResourceLabels, patchResourceLabels, setResourceLabels } from "./labels.route.js";
import modsRouter from "./mods.route.js";
import boardRouter from "./board.route.js";
import presenceRouter from "./presence.route.js";
import previewSessionRouter from "./preview-session.route.js";
import startupRouter from "./startup.route.js";
import commerceRouter from "./commerce.route.js";
import completionsRouter from "./completions.route.js";
import publicFilesRouter from "./public-files.route.js";
import webhooksRouter from "./webhooks.route.js";

const router = new Hono();

// Record cross-space tool_call when X-Cohub-Source-* points at another space.
// Exact /:id and /:id/* both need a matcher; Hono does not treat them as one.
const afterSpaceRequest: Parameters<typeof router.use>[1] = async (c, next) => {
  try {
    await next();
  } finally {
    maybeEnqueueCrossSpaceReference(c, c.req.param("id"));
  }
};
router.use("/:id/*", afterSpaceRequest);
router.use("/:id", afterSpaceRequest);

router.route("/", spacesRouter);
// In production, /:id/fs/* is routed to fs-api by the gateway (same codebase).
// This remains a local/non-split fallback.
router.route("/:id/fs", fsRouter);
router.route("/:id/completions", completionsRouter);
router.route("/:id/public", publicFilesRouter);
router.route("/:id/members", membersRouter);
router.route("/:id/access", accessRouter);
router.route("/:id/usage", usageRouter);
router.route("/:id/activity", activityRouter);
router.route("/:id/invitations", invitationsRouter);
router.route("/:id/labels", labelsRouter);
router.get("/:id/resources/:resourceType/labels", getResourceLabels);
router.patch("/:id/resources/:resourceType/labels", patchResourceLabels);
router.put("/:id/resources/:resourceType/labels", setResourceLabels);
router.route("/:id/mods", modsRouter);
router.route("/:id/boards", boardRouter);
router.route("/:id/presence", presenceRouter);
router.route("/", previewSessionRouter);
router.route("/", startupRouter);
router.route("/", commerceRouter);
router.route("/", webhooksRouter);

export { meSpacesRouter };
export default router;
