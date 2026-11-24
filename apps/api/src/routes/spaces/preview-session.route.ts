import { Hono } from "hono";
import { authzDenied, requireValidId, useAuth } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import { createPreviewSessionToken, PREVIEW_SESSION_TTL_SECONDS } from "../../preview-sessions.js";

const router = new Hono();

router.post("/:id/preview-session", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  // The preview token outlives this request, so offline App access cannot mint it.
  if (!(await hasPermission(user, "file.view", { spaceId }, { offlineAccess: false }))) return authzDenied(c);
  const token = createPreviewSessionToken({ userUuid: user.uuid, spaceId });
  return c.json({ token, expiresIn: PREVIEW_SESSION_TTL_SECONDS });
});

export default router;
