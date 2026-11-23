import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import * as z from "zod";
import { APP_BROWSER_SESSION_SECONDS, appReturnPath } from "@cohub/protocol";
import type { Permission } from "@cohub/core/permissions";
import { APP_SESSION_TTL_SECONDS, createAppSessionToken } from "../app-sessions.js";
import { redisCommandClient } from "../redis.js";
import { getExecutionPrincipal, useAccountPrincipal } from "../lib/middleware.js";

const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const target = z.object({ origin: z.string().max(255) });
const authorize = target.extend({ challenge: secret, returnTo: z.string().max(2048) });
const exchange = target.extend({ code: secret, verifier: secret });
const session = target.extend({ session: secret });
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
const randomSecret = () => randomBytes(32).toString("base64url");
const sessionKey = (appId: string, origin: string, handle: string) => `app:browser:${appId}:${origin}:${hash(handle)}`;
const codeKey = (appId: string, origin: string, challenge: string, code: string) =>
  `app:browser-code:${appId}:${origin}:${challenge}:${hash(code)}`;
const epochKey = (userUuid: string) => `app:browser-epoch:${userUuid}`;

type StoredSession = { userUuid: string; epoch: string };

/** Ends every storefront session of this account, on every device. */
export async function revokeAppBrowserSessions(userUuid: string) {
  await redisCommandClient.set(epochKey(userUuid), randomSecret(), "EX", APP_BROWSER_SESSION_SECONDS);
}

async function currentEpoch(userUuid: string) {
  return await redisCommandClient.get(epochKey(userUuid)) ?? "";
}

type BoundApp = { id: string; spaceId: string; appScopes: string[] };

export function createAppBrowserSessionRouter(resolveApp: (origin: string, id: string) => Promise<BoundApp | null>) {
  const router = new Hono().basePath("/:id/browser-session");
  router.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  router.post("/code", async (c) => {
    const user = useAccountPrincipal(c);
    if (user instanceof Response) return user;
    if (getExecutionPrincipal(c)) return c.json({ message: "account sign-in required" }, 403);
    const id = c.req.param("id");
    const parsed = authorize.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: "invalid sign-in request" }, 400);
    const { origin, challenge, returnTo } = parsed.data;
    const path = appReturnPath(returnTo, origin);
    if (!path || !(await resolveApp(origin, id))) return c.json({ message: "invalid App destination" }, 403);
    const code = randomSecret();
    await redisCommandClient.set(codeKey(id, origin, challenge, code), JSON.stringify({ userUuid: user.uuid, path }), "EX", 90);
    return c.json({ code });
  });

  router.post("/exchange", async (c) => {
    const id = c.req.param("id");
    const parsed = exchange.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: "invalid sign-in exchange" }, 400);
    const { origin, code, verifier } = parsed.data;
    const key = codeKey(id, origin, hash(verifier), code);
    const stored = await redisCommandClient.getdel(key);
    if (!stored || !(await resolveApp(origin, id))) return c.json({ message: "sign-in expired" }, 401);
    const { userUuid, path } = JSON.parse(stored) as { userUuid: string; path: string };
    const handle = randomSecret();
    const epoch = await currentEpoch(userUuid);
    // The epoch must outlive every session that references it.
    if (epoch) await redisCommandClient.expire(epochKey(userUuid), APP_BROWSER_SESSION_SECONDS);
    const session: StoredSession = { userUuid, epoch };
    await redisCommandClient.set(sessionKey(id, origin, handle), JSON.stringify(session), "EX", APP_BROWSER_SESSION_SECONDS);
    return c.json({ session: handle, returnTo: path });
  });

  router.post("/token", async (c) => {
    const id = c.req.param("id");
    const parsed = session.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: "invalid App session" }, 400);
    const { origin, session: handle } = parsed.data;
    const key = sessionKey(id, origin, handle);
    const stored = await redisCommandClient.get(key);
    const { userUuid, epoch } = (stored ? JSON.parse(stored) : {}) as Partial<StoredSession>;
    if (!userUuid) return c.json({ message: "App session expired" }, 401);
    if (epoch !== await currentEpoch(userUuid)) {
      await redisCommandClient.del(key);
      return c.json({ message: "App session ended" }, 401);
    }
    const app = await resolveApp(origin, id);
    if (!app) return c.json({ message: "App origin unavailable" }, 403);
    const token = createAppSessionToken({ userUuid, appId: id, spaceId: app.spaceId, appScopes: app.appScopes as Permission[] });
    return c.json({ token, viewer: { userUuid }, expiresIn: APP_SESSION_TTL_SECONDS });
  });

  router.post("/logout", async (c) => {
    const parsed = session.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ message: "invalid App session" }, 400);
    await redisCommandClient.del(sessionKey(c.req.param("id"), parsed.data.origin, parsed.data.session));
    return c.body(null, 204);
  });
  return router;
}
