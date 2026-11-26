import { createLogger } from "@cohub/infra/logging";
import { Hono } from "hono";
import { db } from "../../db/index.js";
import { readBoardCheckpoint } from "@cohub/core/board";
import { boardErrorBody, boardErrorResponse } from "../../board-error.js";
import { spaces, taskRuns, checkpoints } from "@cohub/db";
import { eq, and, inArray, desc, lt, or } from "drizzle-orm";
import { useAuth, getOptionalAuth, requireValidId, authzDenied } from "../../lib/middleware.js";
import { enqueueTask } from "../../tasks.js";
import { hasPermission, hasMemberPermission, resolveFileViewVisibility } from "../../permissions.js";
import {
  CHECKPOINT_DIFF_CACHE_CONTROL,
  getCheckpointDiffFile,
  getCheckpointDiffSummary,
} from "../../checkpoint-diff.js";
import { parseFsPagination } from "../../fs-pagination.js";
import { checkpointFsJsonError, listCheckpointDirectory, readCheckpointFile, redactCheckpointForView } from "../../checkpoint-fs.js";
import { isLocalSpace } from "../../space-fs-backend.js";
import type { SpaceFsVisibility } from "@cohub/core/space-fs";
import type { AuthUser } from "../../lib/middleware.js";
import { redisCommandClient } from "../../redis.js";
import { getRequestSource } from "../../lib/request-source.js";

const logger = createLogger({ serviceName: "cohub-api" });
const router = new Hono();

const getSpaceSaveCheckpointLockKey = (spaceId: string) => `cohub:space:${spaceId}:save-checkpoint`;

router.post("/:id/checkpoints", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);

  const [space] = await db.select().from(spaces).where(eq(spaces.id, spaceId)).limit(1);
  if (!space) return c.json({ message: "space not found" }, 404);
  if (!(await hasPermission(user, "checkpoint.edit", { spaceId }))) return authzDenied(c);

  const body = await c.req.json<{ description?: string }>().catch(() => null);
  const description = body?.description?.trim() || null;

  const existingSave = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(and(eq(taskRuns.spaceId, spaceId), eq(taskRuns.taskType, "save_checkpoint"), inArray(taskRuns.status, ["pending", "running"])))
    .orderBy(desc(taskRuns.createdAt))
    .limit(1);
  if (existingSave[0]) return c.json({ ok: true, taskRunId: existingSave[0].id, existing: true });

  const saveLockBusy = await redisCommandClient.exists(getSpaceSaveCheckpointLockKey(spaceId)).catch((error) => {
    logger.warn(`[Checkpoints] failed to check save lock for space=${spaceId}`, error);
    return 0;
  });
  if (saveLockBusy) {
    return c.json({ message: "Checkpoint save in progress.", reason: "save_checkpoint_lock_busy" }, 409);
  }

  const { taskRunId } = await enqueueTask({
    type: "save_checkpoint",
    spaceId,
    userId: user.uuid,
    data: {
      spaceId,
      description,
      requestSource: getRequestSource(c),
    },
  });

  return c.json({ ok: true, taskRunId });
});

const DEFAULT_CHECKPOINT_LIST_LIMIT = 20;
const MAX_CHECKPOINT_LIST_LIMIT = 100;

const encodeCheckpointListCursor = (
  checkpoint: { id: string; createdAt: Date | string | null } | null | undefined,
) => {
  if (!checkpoint?.createdAt) return null;
  const createdAt = checkpoint.createdAt instanceof Date
    ? checkpoint.createdAt.toISOString()
    : new Date(checkpoint.createdAt).toISOString();
  return `${createdAt}|${checkpoint.id}`;
};

const decodeCheckpointListCursor = (cursor: string | null | undefined) => {
  if (!cursor) return null;
  const separatorIndex = cursor.lastIndexOf("|");
  const rawDate = separatorIndex > 0 ? cursor.slice(0, separatorIndex) : cursor;
  const id = separatorIndex > 0 ? cursor.slice(separatorIndex + 1) : null;
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) return null;
  return { date, id };
};

router.get("/:id/checkpoints", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  if (!requireValidId(spaceId)) return c.json({ message: "space not found" }, 404);
  if (!(await hasMemberPermission(user, "checkpoint.view", spaceId))) return authzDenied(c);

  const limitParam = Number(c.req.query("limit") ?? DEFAULT_CHECKPOINT_LIST_LIMIT);
  const rawLimit = Math.trunc(limitParam);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(rawLimit, 1), MAX_CHECKPOINT_LIST_LIMIT)
    : DEFAULT_CHECKPOINT_LIST_LIMIT;
  const cursor = decodeCheckpointListCursor(c.req.query("cursor"));

  const rows = await db
    .select({
      id: checkpoints.id,
      spaceId: checkpoints.spaceId,
      commitHash: checkpoints.commitHash,
      description: checkpoints.description,
      parentCheckpointId: checkpoints.parentCheckpointId,
      rootCheckpointId: checkpoints.rootCheckpointId,
      forkCount: checkpoints.forkCount,
      saveVersion: checkpoints.saveVersion,
      createdAt: checkpoints.createdAt,
    })
    .from(checkpoints)
    .where(
      cursor
        ? and(
            eq(checkpoints.spaceId, spaceId),
            or(
              lt(checkpoints.createdAt, cursor.date),
              cursor.id
                ? and(eq(checkpoints.createdAt, cursor.date), lt(checkpoints.id, cursor.id))
                : undefined,
            ),
          )
        : eq(checkpoints.spaceId, spaceId),
    )
    .orderBy(desc(checkpoints.createdAt), desc(checkpoints.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const listedCheckpoints = hasMore ? rows.slice(0, limit) : rows;

  return c.json({
    checkpoints: listedCheckpoints,
    pageInfo: {
      hasMore,
      nextCursor: hasMore ? encodeCheckpointListCursor(listedCheckpoints.at(-1)) : null,
    },
  });
});

router.get("/:id/checkpoints/:checkpointId", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || !requireValidId(checkpointId)) {
    return c.json({ message: "checkpoint not found" }, 404);
  }
  if (!(await hasPermission(user, "checkpoint.view", { spaceId }))) return authzDenied(c);

  const [checkpoint] = await db
    .select()
    .from(checkpoints)
    .where(and(eq(checkpoints.id, checkpointId), eq(checkpoints.spaceId, spaceId)))
    .limit(1);

  if (!checkpoint) return c.json({ message: "checkpoint not found" }, 404);

  // Non-full views lose diff and path metadata; see redactCheckpointForView.
  const visibility = await resolveCheckpointFsVisibility(user, spaceId);
  return c.json({ checkpoint: await redactCheckpointForView(checkpoint, visibility) });
});

// Checkpoint file views apply the same visibility as the workspace file routes. Filtered views need the
// workspace .gitignore on this server, which local sandboxes do not provide, so those are denied.
async function resolveCheckpointFsVisibility(user: AuthUser | null, spaceId: string): Promise<SpaceFsVisibility | null> {
  if (!(await hasPermission(user, "checkpoint.view", { spaceId }))) return null;
  const visibility = await resolveFileViewVisibility(user, spaceId);
  if (visibility === "filtered" && await isLocalSpace(spaceId)) return null;
  return visibility;
}

// In production, these checkpoints/fs routes are routed to fs-api by the gateway.
// This remains a local/non-split fallback.
router.get("/:id/checkpoints/:checkpointId/fs/tree", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || (checkpointId !== "latest" && !requireValidId(checkpointId))) return c.json({ code: "checkpoint_not_found", message: "Checkpoint not found." }, 404);
  const visibility = await resolveCheckpointFsVisibility(user, spaceId);
  if (!visibility) return authzDenied(c);

  try {
    return c.json(await listCheckpointDirectory({ spaceId, checkpointId, path: c.req.query("path") ?? "", pagination: parseFsPagination(c.req.query()), visibility }));
  } catch (error) {
    const { status, body } = checkpointFsJsonError(error);
    return c.json(body, status as never);
  }
});

router.get("/:id/checkpoints/:checkpointId/fs/file", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || (checkpointId !== "latest" && !requireValidId(checkpointId))) return c.json({ code: "checkpoint_not_found", message: "Checkpoint not found." }, 404);
  const visibility = await resolveCheckpointFsVisibility(user, spaceId);
  if (!visibility) return authzDenied(c);

  try {
    return c.json(await readCheckpointFile({ spaceId, checkpointId, path: c.req.query("path") ?? "", visibility }));
  } catch (error) {
    const { status, body } = checkpointFsJsonError(error);
    return c.json(body, status as never);
  }
});

router.get("/:id/checkpoints/:checkpointId/fs/diff", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || (checkpointId !== "latest" && !requireValidId(checkpointId))) {
    return c.json({ code: "checkpoint_not_found", message: "Checkpoint not found." }, 404);
  }
  const visibility = await resolveCheckpointFsVisibility(user, spaceId);
  if (!visibility) return authzDenied(c);

  const base = c.req.query("base") ?? null;
  if (base && !requireValidId(base)) {
    return c.json({ code: "checkpoint_not_found", message: "Base checkpoint not found." }, 404);
  }

  try {
    const summary = await getCheckpointDiffSummary({ spaceId, checkpointId, baseCheckpointId: base, visibility });
    // Immutable parent diffs: long private browser cache. Auth still gates origin.
    // Large precomputed payloads use delivery=url (OSS object with public immutable Cache-Control).
    if (summary.precomputed && !base) {
      c.header("Cache-Control", CHECKPOINT_DIFF_CACHE_CONTROL);
      c.header("Vary", "Authorization, Cookie");
    } else {
      c.header("Cache-Control", "private, max-age=60");
    }
    return c.json(summary);
  } catch (error) {
    const { status, body } = checkpointFsJsonError(error);
    return c.json(body, status as never);
  }
});

router.get("/:id/checkpoints/:checkpointId/fs/diff/file", async (c) => {
  const user = getOptionalAuth(c);
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  if (!requireValidId(spaceId) || (checkpointId !== "latest" && !requireValidId(checkpointId))) {
    return c.json({ code: "checkpoint_not_found", message: "Checkpoint not found." }, 404);
  }
  const visibility = await resolveCheckpointFsVisibility(user, spaceId);
  if (!visibility) return authzDenied(c);

  const path = c.req.query("path") ?? "";
  if (!path) return c.json({ code: "path_invalid", message: "path is required" }, 400);
  const base = c.req.query("base") ?? null;
  if (base && !requireValidId(base)) {
    return c.json({ code: "checkpoint_not_found", message: "Base checkpoint not found." }, 404);
  }

  try {
    const file = await getCheckpointDiffFile({ spaceId, checkpointId, path, baseCheckpointId: base, visibility });
    // Align with summary: long immutable cache only for precomputed parent diffs.
    if (!base && file.precomputed) {
      c.header("Cache-Control", CHECKPOINT_DIFF_CACHE_CONTROL);
    } else {
      c.header("Cache-Control", "private, max-age=60");
    }
    c.header("Vary", "Authorization, Cookie");
    return c.json(file);
  } catch (error) {
    const { status, body } = checkpointFsJsonError(error);
    return c.json(body, status as never);
  }
});

router.get("/:id/checkpoints/:checkpointId/boards/:boardId", async (c) => {
  const spaceId = c.req.param("id");
  const checkpointId = c.req.param("checkpointId");
  const boardId = c.req.param("boardId");
  if (!requireValidId(spaceId) || !requireValidId(checkpointId) || !requireValidId(boardId)) {
    return c.json({ code: "BOARD_NOT_FOUND", message: "Board not found." }, 404);
  }
  if (!(await hasPermission(getOptionalAuth(c), "checkpoint.view", { spaceId }))) return authzDenied(c);
  try {
    const board = await readBoardCheckpoint(db, { spaceId, checkpointId, boardId });
    c.header("Cache-Control", "private, max-age=31536000, immutable");
    c.header("Vary", "Authorization, Cookie");
    return c.json(board);
  } catch (error) {
    const response = boardErrorResponse(error);
    return c.json(boardErrorBody(response), response.status as never);
  }
});

export default router;
