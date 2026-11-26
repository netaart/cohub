import { Hono } from "hono";
import type { AppWire } from "./apps-wire.js";
import { createAppReadRouter } from "./app-read.route.js";
import { createAppPublishRouter } from "./app-publish.route.js";
import { createAppRealtimeRouter } from "./app-realtime.route.js";
import { createAppViewerRouter } from "./app-viewer.route.js";

/**
 * Works REST router factory: the canonical `/api/apps` mount and the legacy
 * `/api/works` mount share every handler; only the wire vocabulary differs.
 */
export function createAppsRouter(wire: AppWire): Hono {
  const router = new Hono();
  router.route("/", createAppReadRouter(wire));
  router.route("/", createAppPublishRouter(wire));
  router.route("/", createAppRealtimeRouter());
  router.route("/", createAppViewerRouter(wire));
  return router;
}
