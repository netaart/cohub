import { Hono } from "hono";
import { db } from "../db/index.js";
import { taskRuns } from "@cohub/db";
import { eq, and, desc, inArray, lt, or, type SQL } from "drizzle-orm";
import { getOptionalAuth, useAuth, requireValidId, authzDenied } from "../lib/middleware.js";
import {
  canAccessUnscopedTaskRun,
  canViewOwnTaskRunsAccountWide,
  canViewTaskRunViaAccountScope,
  hasPermission,
  isTaskRunOwner,
  listAppSessionTaskRunSpaceIds,
} from "../permissions.js";
import { taskQueue } from "../tasks.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "../user-profiles.js";
import {
  sanitizeTaskRunPricingForViewer,
  sanitizeTaskRunProgressForViewer,
} from "../task-run-privacy.js";
import { sanitizeTaskRunForList } from "@cohub/protocol/task";

const router = new Hono();

function parseTaskCursor(cursor: string | undefined) {
  if (!cursor) return null;
  const [createdAtRaw, id] = cursor.split("|");
  const createdAt = new Date(createdAtRaw ?? "");
  if (Number.isNaN(createdAt.getTime())) return "invalid" as const;
  return { createdAt, id: id?.trim() || null };
}

function buildTaskCursor(run: { createdAt: Date | string | null; id: string } | undefined) {
  if (!run?.createdAt) return null;
  const createdAt = run.createdAt instanceof Date ? run.createdAt.toISOString() : run.createdAt;
  return `${createdAt}|${run.id}`;
}

function applyTaskFilters(input: {
  conditions: ReturnType<typeof eq>[];
  taskRunIds?: string[];
  sessionId?: string;
  cronJobId?: string;
  taskType?: string;
  status?: string;
  cursor: ReturnType<typeof parseTaskCursor>;
}) {
  if (input.taskRunIds?.length) input.conditions.push(inArray(taskRuns.id, input.taskRunIds));
  if (input.sessionId) input.conditions.push(eq(taskRuns.sessionId, input.sessionId));
  if (input.cronJobId) input.conditions.push(eq(taskRuns.cronJobId, input.cronJobId));
  if (input.taskType?.trim()) input.conditions.push(eq(taskRuns.taskType, input.taskType.trim()));
  if (input.status === "active") input.conditions.push(inArray(taskRuns.status, ["pending", "running"]));
  else if (input.status) input.conditions.push(eq(taskRuns.status, input.status));
  if (input.cursor && input.cursor !== "invalid") {
    const cursorCondition = input.cursor.id
      ? or(lt(taskRuns.createdAt, input.cursor.createdAt), and(eq(taskRuns.createdAt, input.cursor.createdAt), lt(taskRuns.id, input.cursor.id)))
      : lt(taskRuns.createdAt, input.cursor.createdAt);
    if (cursorCondition) input.conditions.push(cursorCondition);
  }
}

function hydrateTaskRunUserProfiles<T extends {
  userUuid: string | null;
  taskType: string;
  payload: unknown;
  result: unknown;
}>(
  runs: T[],
  options?: { sanitizeForList?: boolean; viewerUserId?: string | null; canViewSpaceData?: boolean },
) {
  const userUuids = runs.map((run) => run.userUuid).filter((value): value is string => Boolean(value));
  return getProfilesByUuids(userUuids).then((profiles) =>
    runs.map((run) => {
      const privateRun = sanitizeTaskRunPricingForViewer(run, options?.viewerUserId, {
        canViewSpaceData: options?.canViewSpaceData,
      });
      const sanitized = options?.sanitizeForList ? sanitizeTaskRunForList(privateRun) : privateRun;
      return {
        ...sanitized,
        userProfile: sanitized.userUuid ? profiles.get(sanitized.userUuid) ?? fallbackPublicUserProfile(sanitized.userUuid) : undefined,
      };
    }),
  );
}

router.get("/", async (c) => {
  const idsParam = c.req.query("ids");
  const cronJobId = c.req.query("cronJobId");
  const spaceId = c.req.query("spaceId");
  const sessionId = c.req.query("sessionId");
  const taskType = c.req.query("taskType");
  const status = c.req.query("status");
  const cursor = c.req.query("cursor");
  const limitParam = Number(c.req.query("limit") ?? 50);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.floor(limitParam), 1), 100) : 50;
  const user = spaceId ? getOptionalAuth(c) : useAuth(c);
  if (user instanceof Response) return user;
  const userId = user?.uuid;
  const taskRunIds = idsParam
    ? [...new Set(idsParam.split(",").map((id) => id.trim()).filter(Boolean))]
    : undefined;

  if (taskRunIds && (taskRunIds.length > 100 || taskRunIds.some((id) => !requireValidId(id)))) {
    return c.json({ message: "invalid task run ids" }, 400);
  }
  if (spaceId && !requireValidId(spaceId)) return c.json({ message: "invalid spaceId" }, 400);
  if (sessionId && !requireValidId(sessionId)) return c.json({ message: "invalid sessionId" }, 400);
  if (cronJobId && !requireValidId(cronJobId)) return c.json({ message: "invalid cronJobId" }, 400);
  if (status && !["active", "pending", "running", "completed", "failed"].includes(status)) {
    return c.json({ message: "invalid status" }, 400);
  }
  const cursorValue = parseTaskCursor(cursor);
  if (cursorValue === "invalid") return c.json({ message: "invalid cursor" }, 400);

  if (spaceId) {
    if (!(await hasPermission(user, "taskrun.view", { spaceId, sessionId: sessionId ?? undefined }))) return authzDenied(c);
    const conditions = [eq(taskRuns.spaceId, spaceId)];
    applyTaskFilters({ conditions, taskRunIds, sessionId, cronJobId, taskType, status, cursor: cursorValue });
    const rows = await db
      .select()
      .from(taskRuns)
      .where(and(...conditions))
      .orderBy(desc(taskRuns.createdAt), desc(taskRuns.id))
      .limit(limit + 1);
    const runs = await hydrateTaskRunUserProfiles(rows.slice(0, limit), {
      sanitizeForList: true,
      viewerUserId: userId,
      canViewSpaceData: true,
    });
    return c.json({ runs, pageInfo: { hasMore: rows.length > limit, nextCursor: rows.length > limit ? buildTaskCursor(runs.at(-1)) : null } });
  }

  if (!userId) return c.json({ message: "unauthorized" }, 401);
  // App sessions see Task Runs in spaces with a live taskrun.view viewer grant
  // that still matches the viewer's current access — a grant on one Space
  // never widens to the viewer's other Spaces. An account-level
  // `user.taskrun.list` grant instead unlocks every run owned by the viewer,
  // including runs from spaces they can no longer access and unscoped runs.
  const appTaskSpaces = await listAppSessionTaskRunSpaceIds(user);
  let conditions: SQL[] = [];
  if (appTaskSpaces === null || await canViewOwnTaskRunsAccountWide(user)) {
    conditions = [eq(taskRuns.userUuid, userId)];
  } else if (appTaskSpaces.length === 0) {
    return authzDenied(c);
  } else {
    conditions = [eq(taskRuns.userUuid, userId), inArray(taskRuns.spaceId, appTaskSpaces)];
  }
  applyTaskFilters({ conditions, taskRunIds, sessionId, cronJobId, taskType, status, cursor: cursorValue });
  const rows = await db
    .select()
    .from(taskRuns)
    .where(and(...conditions))
    .orderBy(desc(taskRuns.createdAt), desc(taskRuns.id))
    .limit(limit + 1);
  const runs = await hydrateTaskRunUserProfiles(rows.slice(0, limit), {
    sanitizeForList: true,
    viewerUserId: userId,
    canViewSpaceData: false,
  });

  return c.json({ runs, pageInfo: { hasMore: rows.length > limit, nextCursor: rows.length > limit ? buildTaskCursor(runs.at(-1)) : null } });
});

router.get("/:taskId", async (c) => {
  const user = getOptionalAuth(c);

  const taskId = c.req.param("taskId");
  if (!taskId?.trim()) return c.json({ message: "task run not found" }, 404);

  const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, taskId)).limit(1);
  if (!run) return c.json({ message: "task run not found" }, 404);

  if (run.spaceId) {
    const owner = isTaskRunOwner(user, run);
    const perSpace = owner
      || await hasPermission(user, "taskrun.view", { spaceId: run.spaceId, sessionId: run.sessionId ?? undefined });
    if (!perSpace && !(await canViewTaskRunViaAccountScope(user, run))) {
      return authzDenied(c);
    }
  } else if (!(await canAccessUnscopedTaskRun(user, run.userUuid))) {
    return authzDenied(c);
  }

  const job = await taskQueue.getJob(run.jobId).catch(() => null);
  const hasSpaceAccess = run.spaceId
    ? await hasPermission(user, "taskrun.view", { spaceId: run.spaceId, sessionId: run.sessionId ?? undefined })
    : false;
  const [hydratedRun] = await hydrateTaskRunUserProfiles([run], {
    viewerUserId: user?.uuid,
    canViewSpaceData: hasSpaceAccess,
  });
  const progress = sanitizeTaskRunProgressForViewer(run, job?.progress ?? null, hasSpaceAccess);
  return c.json({ run: hydratedRun, progress });
});

export default router;
