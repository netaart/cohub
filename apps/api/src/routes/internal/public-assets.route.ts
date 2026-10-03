import { Hono } from "hono";
import { z } from "zod";
import { ensureInternalRequest } from "../../lib/middleware.js";
import { createInternalPublicAssetUploadPlan, PublicAssetConfigError, PublicAssetValidationError } from "../../public-asset-storage.js";
import { UserUploadConfigError } from "../../user-upload-storage.js";

const router = new Hono();
const imageUploadSchema = z.object({
  userId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
  file: z.object({
    size: z.number().int().positive().max(5 * 1024 * 1024),
    mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
  }),
});

router.post("/image-upload", async (context) => {
  const forbidden = ensureInternalRequest(context);
  if (forbidden) return forbidden;
  const parsed = imageUploadSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) return context.json({ message: "invalid image upload" }, 400);
  try {
    return context.json(createInternalPublicAssetUploadPlan({
      purpose: "chat_attachment", userUuid: parsed.data.userId, file: parsed.data.file,
    }));
  } catch (error) {
    if (error instanceof PublicAssetValidationError) return context.json({ message: error.message }, 400);
    if (error instanceof PublicAssetConfigError || error instanceof UserUploadConfigError) {
      return context.json({ message: "public asset storage is not configured" }, 503);
    }
    throw error;
  }
});

export default router;
