import { createLogger } from "@cohub/infra/logging";
import { Hono } from "hono";
import { hasPermission } from "../permissions.js";
import { authzDenied, requireValidId, useAuth } from "../lib/middleware.js";
import {
  consumePublicAssetUploadQuota,
  createPublicAssetUploadPlan,
  PublicAssetConfigError,
  PublicAssetValidationError,
  type CreatePublicAssetUploadInput,
} from "../public-asset-storage.js";
import { UserUploadConfigError } from "../user-upload-storage.js";


const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

router.post("/uploads", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const body = await c.req.json<CreatePublicAssetUploadInput>().catch(() => null);
  if (!body || typeof body !== "object") return c.json({ message: "invalid body" }, 400);
  if (body.purpose !== "user_avatar" && body.purpose !== "space_avatar" && body.purpose !== "chat_attachment" && body.purpose !== "app_source") {
    return c.json({ message: "invalid public asset purpose" }, 400);
  }
  if (body.uploadProtocol !== "presigned_put_v1") {
    return c.json({ message: "presigned_put_v1 upload protocol is required" }, 400);
  }

  if (body.purpose === "space_avatar" || body.purpose === "app_source") {
    if (!body.spaceId || !requireValidId(body.spaceId)) return c.json({ message: "space not found" }, 404);
    // App source uploads publish an App, so they follow `app.publish`; space
    // avatars stay a Space-settings concern on `space.edit`.
    const permission = body.purpose === "app_source" ? "app.publish" : "space.edit";
    if (!(await hasPermission(user, permission, { spaceId: body.spaceId }))) return authzDenied(c);
    if (body.purpose === "app_source" && !body.sessionId) return c.json({ message: "sessionId is required" }, 400);
  }

  // chat_attachment is user-scoped: authenticated is enough.
  // Optional spaceId/sessionId are association hints only and do not gate upload.
  // Rate limits: avatar 60/h; chat image specialization 300/h (demotes to file on failure).

  try {
    const plan = createPublicAssetUploadPlan({
      purpose: body.purpose,
      uploadProtocol: body.uploadProtocol,
      userUuid: user.uuid,
      spaceId: body.spaceId,
      sessionId: body.sessionId,
      file: body.file,
    });
    await consumePublicAssetUploadQuota(user.uuid, body.purpose);
    return c.json(plan);
  } catch (error) {
    if (error instanceof PublicAssetValidationError) {
      const status = error.message.startsWith("too many") ? 429 : 400;
      return c.json({ message: error.message }, status as never);
    }
    if (error instanceof PublicAssetConfigError || error instanceof UserUploadConfigError) {
      logger.error("[public-assets] upload storage is not configured", error.message);
      return c.json({ message: "public asset storage is not configured" }, 500);
    }
    logger.error("[public-assets] failed to create public asset upload", error);
    return c.json({ message: "failed to create public asset upload" }, 500);
  }
});

export default router;
