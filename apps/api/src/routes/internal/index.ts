import { Hono } from "hono";
import internalGatewayRouter from "./gateway.route.js";
import internalSpaceEventsRouter from "./space-events.route.js";
import internalSpacesRouter from "./spaces.route.js";
import internalPublicAssetsRouter from "./public-assets.route.js";

const router = new Hono();

router.route("/gateway", internalGatewayRouter);
router.route("/space-events", internalSpaceEventsRouter);
router.route("/spaces", internalSpacesRouter);
router.route("/public-assets", internalPublicAssetsRouter);

export default router;
