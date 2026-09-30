import { Hono, type Context } from "hono";
import { z } from "zod";
import type { PushTargetEnvironment } from "@cohub/db";
import type { AuthUser } from "../lib/middleware.js";

const PUSH_TOKEN_PATTERN = /^[0-9a-f]{32,200}$/i;

const pushTargetBodySchema = z.object({
  environment: z.enum(["sandbox", "production"]),
  topic: z.string().trim().min(1).max(255),
});

export type PushTargetsRouterDependencies = {
  getUser: (c: Context) => AuthUser | Response;
  /** Configured APNs topics; null when push is disabled. */
  apnsTopics: () => readonly string[] | null;
  upsertPushTarget: (input: {
    userUuid: string;
    token: string;
    environment: PushTargetEnvironment;
    topic: string;
  }) => Promise<void>;
  deleteUserPushTarget: (input: { userUuid: string; token: string }) => Promise<void>;
};

export const createPushTargetsRouter = (deps: PushTargetsRouterDependencies) => {
  const router = new Hono();

  /** Resolves the user, push availability, and a normalized token, or the error response. */
  const resolveRequest = (c: Context) => {
    const user = deps.getUser(c);
    if (user instanceof Response) return user;
    const topics = deps.apnsTopics();
    if (!topics) {
      return c.json({ message: "push notifications are not configured", code: "push_unavailable" }, 503);
    }
    const token = c.req.param("token") ?? "";
    if (!PUSH_TOKEN_PATTERN.test(token)) {
      return c.json({ message: "push token must be 32-200 hex characters", code: "invalid_push_token" }, 400);
    }
    return { user, topics, token: token.toLowerCase() };
  };

  router.put("/push-targets/:token", async (c) => {
    const resolved = resolveRequest(c);
    if (resolved instanceof Response) return resolved;
    const parsed = pushTargetBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({
        message: "body must be { environment: \"sandbox\" | \"production\", topic: string }",
        code: "invalid_push_target",
      }, 400);
    }
    if (!resolved.topics.includes(parsed.data.topic)) {
      return c.json({ message: "push topic is not allowed", code: "push_topic_not_allowed" }, 400);
    }
    await deps.upsertPushTarget({
      userUuid: resolved.user.uuid,
      token: resolved.token,
      environment: parsed.data.environment,
      topic: parsed.data.topic,
    });
    return c.json({ ok: true });
  });

  router.delete("/push-targets/:token", async (c) => {
    const resolved = resolveRequest(c);
    if (resolved instanceof Response) return resolved;
    await deps.deleteUserPushTarget({ userUuid: resolved.user.uuid, token: resolved.token });
    return c.json({ ok: true });
  });

  return router;
};
