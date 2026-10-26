import { createLogger } from "@cohub/infra/logging";
import type { MultipartUploadCompletedPart } from "@cohub/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { authzDenied, getExecutionPrincipal, requireValidId, useAuth } from "../lib/middleware.js";
import { abortMultipartUpload, completeMultipartUpload, getMultipartUpload, MultipartUploadError, multipartUploadPlan, withUploadLock } from "../multipart-upload.js";
import { hasPermission } from "../permissions.js";

const router = new Hono();
const logger = createLogger({ serviceName: "cohub-api" });
router.use("*", bodyLimit({ maxSize: 128 * 1024, onError: (c) => c.json({ message: "upload request is too large" }, 413) }));
router.on(["POST", "DELETE"], ["/:uploadId/refresh", "/:uploadId/complete", "/:uploadId"], async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const uploadId = c.req.param("uploadId");
  if (!uploadId || !requireValidId(uploadId)) return c.json({ message: "upload not found" }, 404);
  const record = await getMultipartUpload(uploadId);
  if (!record || record.userId !== user.uuid) return c.json({ message: "upload not found" }, 404);
  if (record.access) {
    if (record.access.permission === "session_image") {
      const execution = getExecutionPrincipal(c);
      if (!execution || execution.spaceId !== record.access.spaceId || (record.access.sessionId && execution.sessionId && execution.sessionId !== record.access.sessionId)) return authzDenied(c);
    } else if (!(await hasPermission(user, record.access.permission, { spaceId: record.access.spaceId }))) return authzDenied(c);
  }
  try {
    if (c.req.method === "POST" && c.req.path.endsWith("/refresh")) return c.json(multipartUploadPlan(record));
    const body = c.req.method === "POST" ? await c.req.json<{ parts: MultipartUploadCompletedPart[] }>().catch(() => null) : null;
    if (c.req.method === "POST" && (!c.req.path.endsWith("/complete") || !body?.parts)) return c.json({ message: "invalid upload request" }, 400);
    if (c.req.method === "DELETE" && c.req.path !== `/api/uploads/${uploadId}`) return c.json({ message: "invalid upload request" }, 400);
    await withUploadLock(`upload:multipart:${uploadId}:lock`, async () => {
      const current = await getMultipartUpload(uploadId);
      if (!current) throw new MultipartUploadError("upload has expired", 404);
      if (c.req.method === "DELETE") await abortMultipartUpload(current);
      else if (body) await completeMultipartUpload(current, body.parts);
    });
    return c.json({ ok: true });
  } catch (error) {
    if (error instanceof MultipartUploadError) return c.json({ message: error.message }, error.status);
    logger.error("[uploads] storage operation failed", { uploadId, error });
    return c.json({ message: "upload storage operation failed" }, 502);
  }
});
export default router;
