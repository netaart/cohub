import { createLogger } from "@cohub/infra/logging";
import { UPLOAD_MAX_BATCH_FILES, UPLOAD_MAX_FILE_BYTES, type PublicFileCreateUploadInput } from "@cohub/protocol";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { authzDenied, getExecutionPrincipal, requireValidId, useAuth } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import {
  createPublicFileUpload,
  getPublicFileUrl,
  listPublicFiles,
  PublicFileConfigError,
  PublicFileValidationError,
} from "../../public-file-storage.js";
import { consumeUploadQuota, UploadRateLimitError } from "../../upload-quota.js";
import { redisCommandClient } from "../../redis.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();
const MAX_UPLOAD_BODY_BYTES = 6 * 1024 * 1024;

const uploadBodyLimit = bodyLimit({
  maxSize: MAX_UPLOAD_BODY_BYTES,
  onError: (c) => c.json({ message: "upload request is too large" }, 413),
});

const uploadSchema = z.object({
  overwrite: z.boolean().optional(),
  entries: z.array(z.object({
    id: z.string().min(1).max(80),
    relativePath: z.string().min(1).max(4096),
    size: z.number().int().min(0).max(UPLOAD_MAX_FILE_BYTES),
    mimeType: z.string().max(255).nullable().optional(),
  }).strict()).min(1).max(UPLOAD_MAX_BATCH_FILES),
}).strict();

const getSpaceId = (value: string | undefined) =>
  value && requireValidId(value) ? value : null;

router.post("/uploads", uploadBodyLimit, async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = getSpaceId(c.req.param("id"));
  if (!spaceId) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "file.edit", { spaceId }))) return authzDenied(c);
  const body = await c.req.json<PublicFileCreateUploadInput>().catch(() => null);
  const parsed = uploadSchema.safeParse(body);
  if (!parsed.success) return c.json({ message: "invalid upload request" }, 400);

  try {
    const plan = createPublicFileUpload(spaceId, parsed.data, {
      endpoint: getExecutionPrincipal(c) ? "internal" : "public",
    });
    await consumeUploadQuota(redisCommandClient, user.uuid, {
      entryCount: parsed.data.entries.length,
      totalBytes: parsed.data.entries.reduce((sum, entry) => sum + entry.size, 0),
    });
    return c.json(plan);
  } catch (error) {
    if (error instanceof PublicFileValidationError) {
      return c.json({ message: error.message }, 400);
    }
    if (error instanceof UploadRateLimitError) {
      c.header("Retry-After", String(error.retryAfterSeconds));
      return c.json({ message: error.message, retryAfterSeconds: error.retryAfterSeconds }, 429);
    }
    if (error instanceof PublicFileConfigError) {
      logger.error("[public-files] storage is not configured", { error });
      return c.json({ message: error.message }, 503);
    }
    logger.error("[public-files] failed to create upload", { spaceId, error });
    return c.json({ message: "failed to create public upload" }, 502);
  }
});

router.get("/url", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = getSpaceId(c.req.param("id"));
  if (!spaceId) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "file.view", { spaceId }))) return authzDenied(c);

  try {
    return c.json(getPublicFileUrl(spaceId, c.req.query("path") ?? ""));
  } catch (error) {
    if (error instanceof PublicFileValidationError) return c.json({ message: error.message }, 400);
    if (error instanceof PublicFileConfigError) return c.json({ message: error.message }, 503);
    throw error;
  }
});

router.get("/", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = getSpaceId(c.req.param("id"));
  if (!spaceId) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "file.view", { spaceId }))) return authzDenied(c);

  const rawLimit = c.req.query("limit");
  const limit = rawLimit == null ? undefined : Number(rawLimit);
  if (limit != null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)) {
    return c.json({ message: "limit must be between 1 and 1000" }, 400);
  }
  const cursor = c.req.query("cursor");
  if (cursor && cursor.length > 4096) return c.json({ message: "invalid cursor" }, 400);

  try {
    return c.json(await listPublicFiles(
      spaceId,
      c.req.query("path") ?? "",
      {
        recursive: c.req.query("recursive") === "true",
        limit,
        cursor,
      },
    ));
  } catch (error) {
    if (error instanceof PublicFileValidationError) return c.json({ message: error.message }, 400);
    if (error instanceof PublicFileConfigError) return c.json({ message: error.message }, 503);
    logger.error("[public-files] failed to list files", { spaceId, error });
    return c.json({ message: "failed to list public files" }, 502);
  }
});

export default router;
