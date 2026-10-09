import { createHash } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { HTTPException } from "hono/http-exception";
import { and, eq, sql } from "drizzle-orm";
import { sessionTurns, spaceSessions } from "@cohub/db";
import { harnessArchiveIndexSchema, validateArchiveBoundary, type HarnessArchiveIndex, type RuntimeArchiveSegment, type RuntimeArchiveUpload } from "@cohub/protocol";
import { readRuntimeRecovery, runtimeResolutionOpen } from "@cohub/core/sessions";
import { db } from "../../db/index.js";
import { useAuth, requireValidId, authzDenied } from "../../lib/middleware.js";
import { hasPermission } from "../../permissions.js";
import { config } from "../../config.js";
import { createPresignedGetObjectUrl, createPresignedPutObjectUrl } from "../../object-presign.js";
import { headTurnObject } from "../../turn-object-storage.js";
import { redisCommandClient } from "../../redis.js";
import { consumeUploadQuota, UploadRateLimitError } from "../../upload-quota.js";
import { dispatchTurnUpdated } from "../../session-output.js";
import { getSessionTurnById } from "../../session-turns.js";

const router = new Hono();
const fail = (status: 400 | 403 | 404 | 409, message: string): never => { throw new HTTPException(status, { message }); };
const storage = () => ({ endpoint: config.turnObjectS3Endpoint, publicEndpoint: config.turnObjectS3PublicEndpoint,
  region: config.turnObjectS3Region, bucket: config.turnObjectS3Bucket,
  accessKeyId: config.turnObjectS3AccessKeyId, secretAccessKey: config.turnObjectS3SecretAccessKey });
const key = (spaceId: string, index: HarnessArchiveIndex, sha: string) =>
  `${config.env === "prod" ? "" : `${config.env}/`}spaces/${spaceId}/sessions/${index.sessionId}/native/${index.harness}/${sha}.jsonl`;
const storedIndex = (value: unknown, sessionId: string, turnId: string): HarnessArchiveIndex => {
  const parsed = harnessArchiveIndexSchema.safeParse(value);
  if (!parsed.success || parsed.data.sessionId !== sessionId || parsed.data.turnId !== turnId) {
    return fail(409, "Archive index unavailable");
  }
  return parsed.data;
};
const digest = (index: HarnessArchiveIndex) => createHash("sha256").update(JSON.stringify(harnessArchiveIndexSchema.parse(index))).digest("hex");
const ticketKey = (spaceId: string, userId: string, index: HarnessArchiveIndex) => `runtime:archive:upload:${spaceId}:${userId}:${digest(index)}`;

async function segmentExists(spaceId: string, index: HarnessArchiveIndex, segment: RuntimeArchiveSegment) {
  const object = await headTurnObject(key(spaceId, index, segment.sha256)).catch((error: unknown) => {
    if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return null;
    throw error;
  });
  if (object?.ContentLength == null) return false;
  if (object.ContentLength !== segment.sizeBytes || object.ETag?.replaceAll('"', "").toLowerCase() !== segment.md5) fail(409, "Archive segment mismatch");
  return true;
}

async function turnInSpace(spaceId: string, sessionId: string, turnId: string) {
  const [row] = await db.select({ id: sessionTurns.id, sequence: sessionTurns.sequence, status: sessionTurns.status, meta: sessionTurns.meta, harnessIndex: sessionTurns.harnessIndex }).from(sessionTurns)
    .innerJoin(spaceSessions, eq(spaceSessions.id, sessionTurns.sessionId))
    .where(and(eq(spaceSessions.spaceId, spaceId), eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.id, turnId))).limit(1);
  return row ?? fail(404, "Turn not found");
}
async function validateOwner(spaceId: string, userId: string, index: HarnessArchiveIndex) {
  const turn = await turnInSpace(spaceId, index.sessionId, index.turnId);
  const recovery = readRuntimeRecovery(turn.meta);
  if (recovery?.ownerUserId !== userId || (turn.meta as { harness?: unknown } | null)?.harness !== index.harness) fail(403, "Runtime owner mismatch");
  if (recovery?.state === "confirmed_stopped") fail(409, "Execution was resolved");
  const parent = index.parentTurnId ? await turnInSpace(spaceId, index.sessionId, index.parentTurnId) : null;
  if (parent && (parent.sequence >= turn.sequence || readRuntimeRecovery(parent.meta)?.state === "confirmed_stopped" || !parent.harnessIndex)) fail(409, "Archive parent is not ready");
  const parentIndex = parent ? storedIndex(parent.harnessIndex, index.sessionId, parent.id) : null;
  if (turn.harnessIndex) storedIndex(turn.harnessIndex, index.sessionId, turn.id);
  try { validateArchiveBoundary(index, parentIndex); }
  catch { fail(400, "Invalid archive boundary"); }
  return turn;
}

router.use("*", bodyLimit({ maxSize: 128 * 1024 }));
router.post("/prepare", async (c) => {
  const user = useAuth(c); if (user instanceof Response) return user;
  const spaceId = c.req.param("id") ?? "";
  if (!requireValidId(spaceId)) return c.json({ message: "Invalid Space" }, 400);
  if (!await hasPermission(user, "sandbox.manage", { spaceId })) return authzDenied(c);
  const parsed = harnessArchiveIndexSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ message: "Invalid archive" }, 400);
  const index = parsed.data;
  const turn = await validateOwner(spaceId, user.uuid, index);
  if (turn.harnessIndex && digest(turn.harnessIndex) !== digest(index)) fail(409, "Archive already finalized");
  try {
    await consumeUploadQuota(redisCommandClient, user.uuid, {
      entryCount: Math.max(1, index.segments.length),
      totalBytes: index.segments.reduce((sum, segment) => sum + segment.sizeBytes, 0),
    });
  }
  catch (error) {
    if (!(error instanceof UploadRateLimitError)) throw error;
    c.header("Retry-After", String(error.retryAfterSeconds));
    return c.json({ message: "Archive upload rate limited", retryAfterSeconds: error.retryAfterSeconds }, 429);
  }
  const uploads: RuntimeArchiveUpload[] = [];
  const unique = [...new Map(index.segments.map((segment) => [segment.sha256, segment])).values()];
  for (let start = 0; start < unique.length; start += 4) {
    const plans = await Promise.all(unique.slice(start, start + 4).map(async (segment) => {
      if (await segmentExists(spaceId, index, segment)) return null;
      return { segment, ...createPresignedPutObjectUrl(storage(), key(spaceId, index, segment.sha256),
        "application/x-ndjson", "private, max-age=0", undefined,
        { contentLength: segment.sizeBytes, contentMd5: Buffer.from(segment.md5, "hex").toString("base64"), forbidOverwrite: true }) };
    }));
    uploads.push(...plans.filter((plan) => plan !== null));
  }
  await redisCommandClient.set(ticketKey(spaceId, user.uuid, index), "1", "EX", 3600);
  return c.json({ uploads });
});

router.post("/commit", async (c) => {
  const user = useAuth(c); if (user instanceof Response) return user;
  const spaceId = c.req.param("id") ?? "";
  if (!requireValidId(spaceId)) return c.json({ message: "Invalid Space" }, 400);
  if (!await hasPermission(user, "sandbox.manage", { spaceId })) return authzDenied(c);
  const parsed = harnessArchiveIndexSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ message: "Invalid archive" }, 400);
  const index = parsed.data;
  const turn = await validateOwner(spaceId, user.uuid, index);
  if (turn.harnessIndex) {
    if (digest(turn.harnessIndex) !== digest(index)) fail(409, "Archive already finalized");
  } else {
    if (!await redisCommandClient.get(ticketKey(spaceId, user.uuid, index))) fail(409, "Upload authorization expired");
    if (!["completed", "failed", "interrupted"].includes(turn.status)) fail(409, "Turn result is pending");
    // Single PUT objects: storage validates the signed Content-MD5, HEAD confirms those bytes.
    for (let start = 0; start < index.segments.length; start += 4) {
      await Promise.all(index.segments.slice(start, start + 4).map(async (segment) => {
        if (!await segmentExists(spaceId, index, segment)) fail(409, "Archive segment missing");
      }));
    }
    const [updated] = await db.update(sessionTurns).set({ harnessIndex: index,
      meta: sql`coalesce(${sessionTurns.meta}, '{}'::jsonb) || '{"runtimeArchiveStatus":"ready"}'::jsonb`,
    }).where(and(eq(sessionTurns.id, index.turnId), eq(sessionTurns.sessionId, index.sessionId), runtimeResolutionOpen,
      sql`${sessionTurns.harnessIndex} is null`, sql`${sessionTurns.meta}->'runtimeRecovery'->>'ownerUserId' = ${user.uuid}`)).returning({ id: sessionTurns.id });
    if (!updated) {
      const current = await validateOwner(spaceId, user.uuid, index);
      if (!current.harnessIndex || digest(current.harnessIndex) !== digest(index)) fail(409, "Archive state changed");
    }
  }
  const record = await getSessionTurnById(index.sessionId, index.turnId);
  if (record) await dispatchTurnUpdated({ spaceId, sessionId: index.sessionId, turn: record });
  return c.json({ ready: true });
});

router.get("/:sessionId/:turnId", async (c) => {
  const user = useAuth(c); if (user instanceof Response) return user;
  const spaceId = c.req.param("id") ?? "", sessionId = c.req.param("sessionId"), turnId = c.req.param("turnId");
  if (![spaceId, sessionId, turnId].every(requireValidId)) return c.json({ message: "Invalid identity" }, 400);
  if (!await hasPermission(user, "sandbox.manage", { spaceId }) || !await hasPermission(user, "session.view", { spaceId, sessionId })) return authzDenied(c);
  const turn = await turnInSpace(spaceId, sessionId, turnId);
  if (readRuntimeRecovery(turn.meta)?.state === "confirmed_stopped") fail(409, "Execution was resolved");
  if ((turn.meta as { runtimeArchiveStatus?: unknown } | null)?.runtimeArchiveStatus !== "ready") fail(409, "Archive is not ready");
  const index = storedIndex(turn.harnessIndex, sessionId, turnId);
  return c.json({ index, segments: index.segments.map((segment) => ({ segment, ...createPresignedGetObjectUrl(storage(), key(spaceId, index, segment.sha256)) })) });
});
export default router;
