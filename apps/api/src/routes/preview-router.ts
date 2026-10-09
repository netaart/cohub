import { Readable } from "node:stream";
import { Hono, type Context } from "hono";
import { setCookie } from "hono/cookie";
import type { PreviewSessionPrincipal } from "../preview-sessions.js";
import type {
  resolveSpaceFileDownload,
  spaceFsJsonError,
  streamSpaceFile,
} from "../space-fs-backend.js";

const PREVIEW_SESSION_COOKIE = "__preview_session";

export type PreviewRouterDependencies = {
  previewHostnames: () => readonly string[];
  previewSessionTtlSeconds: number;
  getPreviewSessionPrincipal: (context: Context) => PreviewSessionPrincipal | null;
  hasPreviewSessionPermission: (
    principal: PreviewSessionPrincipal,
    permission: "file.view",
    spaceId: string,
  ) => boolean;
  requireValidId: (value: string | null | undefined) => boolean;
  resolveSpaceFileDownload: typeof resolveSpaceFileDownload;
  spaceFsJsonError: typeof spaceFsJsonError;
  streamSpaceFile: typeof streamSpaceFile;
  verifyPreviewSessionToken: (token: string) => PreviewSessionPrincipal | null;
};

function parseRange(value: string | undefined, size: number) {
  if (!value) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return "invalid" as const;
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
  const start = suffixLength === null ? Number(match[1]) : Math.max(0, size - suffixLength);
  const end = match[1] && match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size) {
    return "invalid" as const;
  }
  return { start, end };
}

function normalizeNextPath(input: string | undefined, spaceId: string) {
  if (!input?.startsWith("/s/")) return null;
  let url: URL;
  try {
    url = new URL(input, "https://preview.local");
  } catch {
    return null;
  }
  if (url.origin !== "https://preview.local") return null;
  const prefix = `/s/${spaceId}/`;
  if (!url.pathname.startsWith(prefix)) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function createPreviewRouter(dependencies: PreviewRouterDependencies) {
  const router = new Hono();

  function isPreviewHost(host: string | undefined) {
    const normalized = host?.split(":")[0]?.toLowerCase();
    return Boolean(
      normalized && dependencies.previewHostnames().some(
        (hostname) => normalized === hostname.trim().toLowerCase(),
      ),
    );
  }

  function previewOnly(context: Context) {
    if (isPreviewHost(context.req.header("host"))) return null;
    return context.json({ message: "not found" }, 404);
  }

  function setPreviewSessionCookie(
    context: Context,
    token: string,
    session: PreviewSessionPrincipal,
  ) {
    const remainingSeconds = Math.max(1, session.exp - Math.floor(Date.now() / 1_000));
    setCookie(context, PREVIEW_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: Math.min(dependencies.previewSessionTtlSeconds, remainingSeconds),
    });
  }

  router.get("/__session", (context) => {
    const denied = previewOnly(context);
    if (denied) return denied;

    const token = context.req.query("token") ?? "";
    const session = dependencies.verifyPreviewSessionToken(token);
    if (!session) return context.json({ message: "unauthorized" }, 401);
    const next = normalizeNextPath(context.req.query("next"), session.spaceId);
    if (!next) return context.json({ message: "invalid preview target" }, 400);

    setPreviewSessionCookie(context, token, session);
    return context.redirect(next, 302);
  });

  router.get("/s/:spaceId/*", async (context) => {
    const denied = previewOnly(context);
    if (denied) return denied;

    const spaceId = context.req.param("spaceId");
    if (!spaceId || !dependencies.requireValidId(spaceId)) {
      return context.json({ message: "space not found" }, 404);
    }

    const rawQueryToken = context.req.query("token");
    const queryToken = rawQueryToken?.trim() ?? "";
    const querySession = rawQueryToken === undefined
      ? null
      : dependencies.verifyPreviewSessionToken(queryToken);
    if (rawQueryToken !== undefined && !querySession) {
      return context.json({ message: "unauthorized" }, 401);
    }
    const session = querySession ?? dependencies.getPreviewSessionPrincipal(context);
    if (!session) return context.json({ message: "unauthorized" }, 401);
    if (session.spaceId !== spaceId) return context.json({ message: "forbidden" }, 403);
    if (!dependencies.hasPreviewSessionPermission(session, "file.view", spaceId)) {
      return context.json({ message: "forbidden" }, 403);
    }

    const rawPath = context.req.path.slice(`/s/${spaceId}/`.length);
    let path: string;
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      return context.json({ message: "invalid path" }, 400);
    }
    if (querySession) setPreviewSessionCookie(context, queryToken, querySession);

    try {
      const download = await dependencies.resolveSpaceFileDownload(spaceId, path, {
        visibility: "full",
      });
      const headers = {
        "cache-control": "no-store",
        "content-security-policy":
          "sandbox allow-scripts allow-same-origin allow-forms allow-popups allow-downloads allow-modals",
        "x-content-type-options": "nosniff",
      };
      if (download.kind === "buffer") {
        const range = parseRange(context.req.header("range"), download.buffer.length);
        if (range === "invalid") {
          return context.body(null, 416, {
            ...headers,
            "content-range": `bytes */${download.buffer.length}`,
          });
        }
        if (range) {
          return context.body(
            new Uint8Array(download.buffer.subarray(range.start, range.end + 1)),
            206,
            {
              ...headers,
              "accept-ranges": "bytes",
              "content-length": String(range.end - range.start + 1),
              "content-range": `bytes ${range.start}-${range.end}/${download.buffer.length}`,
              "content-type": download.mimeType ?? "application/octet-stream",
            },
          );
        }
        return context.body(new Uint8Array(download.buffer), 200, {
          ...headers,
          "accept-ranges": "bytes",
          "content-length": String(download.buffer.length),
          "content-type": download.mimeType ?? "application/octet-stream",
        });
      }

      const info = await dependencies.streamSpaceFile(spaceId, path, { visibility: "full" });
      try {
        const range = parseRange(context.req.header("range"), info.size);
        if (range === "invalid") {
          await info.file.close();
          return context.body(null, 416, { ...headers, "content-range": `bytes */${info.size}` });
        }
        // Transfer the validated descriptor to the stream. EOF/cancellation closes
        // it; the untrusted pathname is never opened again after validation.
        const stream = Readable.toWeb(info.file.createReadStream(range ?? {})) as ReadableStream;
        return context.body(stream, range ? 206 : 200, {
          ...headers,
          "accept-ranges": "bytes",
          "content-length": String(range ? range.end - range.start + 1 : info.size),
          ...(range ? { "content-range": `bytes ${range.start}-${range.end}/${info.size}` } : {}),
          "content-type": info.mimeType ?? "application/octet-stream",
        });
      } catch (error) {
        await info.file.close();
        throw error;
      }
    } catch (error) {
      const { status, body } = dependencies.spaceFsJsonError(error);
      return context.json(body, status as never);
    }
  });

  return router;
}
