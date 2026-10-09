import { Hono } from "hono";
import healthRouter from "./health.route.js";
import modelsRouter from "./models.route.js";
import modelsStatusRouter from "./models-status.route.js";
import meRouter from "./me.route.js";
import meLabelsRouter from "./me-labels.route.js";
import channelsRouter from "./channels.route.js";
import spacesRouter, { meSpacesRouter } from "./spaces/index.js";
import sessionsRouter from "./sessions.route.js";
import sessionAccessRouter from "./session-access.route.js";
import internalRouter from "./internal/index.js";
import cronJobsRouter from "./cron-jobs.route.js";
import tasksRouter from "./tasks.route.js";
import trendingRouter from "./trending.route.js";
import promptsRouter from "./prompts.route.js";
import skillsRouter from "./skills.route.js";
import inviteRouter from "./invite.route.js";
import referralsRouter from "./referrals.route.js";
import searchRouter from "./search.route.js";
import paletteOverviewRouter from "./palette-overview.route.js";
import generationsRouter from "./generations.route.js";
import billingRouter from "./billing.route.js";
import queuesRouter from "./queues.route.js";
import publicAssetsRouter from "./public-assets.route.js";
import { createAppsRouter } from "./apps.route.js";
import { createAppCommerceRouter } from "./app-commerce.route.js";
import { createAppPromotionsRouter } from "./app-promotions.route.js";
import usersRouter from "./users.route.js";
import referencesRouter from "./references.route.js";
import desktopCommandsRouter from "./desktop-commands.route.js";
import previewRouter from "./preview.route.js";

const router = new Hono();

router.route("/", healthRouter);
router.route("/api/models/status", modelsStatusRouter);
router.route("/api/models", modelsRouter);
router.route("/api/prompts", promptsRouter);
router.route("/api/skills", skillsRouter);
router.route("/api/me", meRouter);
router.route("/api/me", meLabelsRouter);
router.route("/api/me", meSpacesRouter);
router.route("/api/channels", channelsRouter);
router.route("/api/spaces", spacesRouter);
router.route("/api/sessions", sessionsRouter);
router.route("/api/sessions", sessionAccessRouter);
router.route("/api/cron-jobs", cronJobsRouter);
router.route("/api/tasks", tasksRouter);
router.route("/api/trending", trendingRouter);
router.route("/api/invite", inviteRouter);
router.route("/api/referrals", referralsRouter);
router.route("/api/search", searchRouter);
router.route("/api/palette/overview", paletteOverviewRouter);
router.route("/api/generations", generationsRouter);
router.route("/api/billing", billingRouter);
router.route("/api/queues", queuesRouter);
router.route("/api/public-assets", publicAssetsRouter);
// Works REST is dual-mounted: the canonical /api/apps serves new SDK clients,
// and the legacy /api/works mount keeps existing consumers (older SDK versions
// and direct REST callers) working with identical payloads until the next
// breaking version.
router.route("/api/apps", createAppsRouter("canonical"));
router.route("/api/apps", createAppPromotionsRouter("canonical"));
router.route("/api/works", createAppsRouter("legacy"));
router.route("/api/works", createAppPromotionsRouter("legacy"));
router.route("/api", createAppCommerceRouter("apps"));
router.route("/api", createAppCommerceRouter("works"));
router.route("/api/users", usersRouter);
router.route("/api/references", referencesRouter);
router.route("/api/desktop/commands", desktopCommandsRouter);
router.route("/api/ui/commands", desktopCommandsRouter);
router.route("/", previewRouter);
router.route("/internal", internalRouter);

export default router;
