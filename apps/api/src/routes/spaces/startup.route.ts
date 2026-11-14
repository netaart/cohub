import {
  parseSpaceConfig,
  SPACE_CONFIG_PATH,
  type SpaceStartupResponse,
} from "@cohub/protocol";
import { Hono, type Context } from "hono";
import { authzDenied, requireValidId, useAuth } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import {
  createPreviewSessionToken,
  PREVIEW_SESSION_TTL_SECONDS,
} from "../../preview-sessions.js";
import { readSpaceFile, spaceFsJsonError } from "../../space-fs-backend.js";
import { resolveSpeechVoiceId } from "../../speech.js";

const router = new Hono();

function json(c: Context, body: SpaceStartupResponse) {
  c.header("Cache-Control", "private, no-store");
  return c.json(body);
}

router.get("/:id/startup", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!spaceId || !requireValidId(spaceId)) {
    return c.json({ message: "space not found" }, 404);
  }
  if (!(await hasPermission(user, "file.view", { spaceId }))) {
    return authzDenied(c);
  }

  const speechVoiceRequest = resolveSpeechVoiceId(user.uuid, spaceId).catch(() => undefined);
  try {
    const file = await readSpaceFile(spaceId, SPACE_CONFIG_PATH, {
      visibility: "full",
    });
    const speechVoice = await speechVoiceRequest;
    if (!("content" in file)) {
      return json(c, {
        status: "preparing",
        config: null,
        configRaw: null,
        revision: { mtimeMs: file.mtimeMs, size: file.size },
        previewSession: null,
        speechVoice,
        retryAfterMs: file.retryAfterMs,
      });
    }

    const raw =
      file.encoding === "base64"
        ? Buffer.from(file.content, "base64").toString("utf8")
        : file.content;
    const config = parseSpaceConfig(raw);
    const background = config?.ui?.newChat?.background;
    const needsSpacePreview =
      background?.type === "html" && background.source.kind === "space";

    return json(c, {
      status: config ? "ready" : "invalid",
      config,
      configRaw: raw,
      revision: { mtimeMs: file.mtimeMs, size: file.size },
      previewSession: needsSpacePreview
        ? {
            token: createPreviewSessionToken({ userUuid: user.uuid, spaceId }),
            expiresIn: PREVIEW_SESSION_TTL_SECONDS,
          }
        : null,
      speechVoice,
    });
  } catch (error) {
    const failure = spaceFsJsonError(error);
    if (failure.status === 404) {
      return json(c, {
        status: "missing",
        config: null,
        configRaw: null,
        revision: null,
        previewSession: null,
        speechVoice: await speechVoiceRequest,
      });
    }
    return c.json(failure.body, failure.status as never);
  }
});

export default router;
