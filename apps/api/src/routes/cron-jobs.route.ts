import { Hono } from "hono";
import * as cronParser from "cron-parser";
import { db } from "../db/index.js";
import { cronJobs, taskRuns } from "@cohub/db";
import { eq, and, isNull, desc, lt, or } from "drizzle-orm";
import { sanitizePostgresJsonValue } from "@cohub/core/content/sanitize";
import { getOptionalAuth, useAuth, requireValidId, authzDenied, getAppSessionPrincipal } from "../lib/middleware.js";
import type { Context } from "hono";
import { hasPermission } from "../permissions.js";
import { disableCronJob, enableCronJob, removeCronJob, updateCronJob } from "../tasks.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "../user-profiles.js";
import { sanitizeTaskRunPricingForViewer } from "../task-run-privacy.js";
import { preserveCronPayloadServerFields } from "./cron-jobs-payload.js";

const router = new Hono();
const { CronExpressionParser } = cronParser;

const MAX_RUNS_LIMIT = 100;

type CronJobAuthSubject = {
  id: string;
  userUuid: string;
  spaceId: string | null;
  sessionId: string | null;
};

async function hydrateCronJobUserProfiles<T extends { userUuid: string }>(jobs: T[]) {
  const profiles = await getProfilesByUuids(jobs.map((job) => job.userUuid));
  return jobs.map((job) => ({
    ...job,
    userProfile: profiles.get(job.userUuid) ?? fallbackPublicUserProfile(job.userUuid),
  }));
}

function validateTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function validateCronSchedule(input: { cronExpression: string; timezone: string }) {
  const cronExpression = input.cronExpression.trim();
  const timezone = input.timezone.trim();
  if (cronExpression.split(/\s+/).length !== 5) {
    throw new Error("cronExpression must have 5 fields, e.g. 0 9 * * *");
  }
  if (!validateTimezone(timezone)) throw new Error("timezone must be an IANA timezone, e.g. Asia/Shanghai or UTC");
  const interval = CronExpressionParser.parse(cronExpression, { tz: timezone });
  const nextRun = interval.next().toDate();
  const secondRun = interval.next().toDate();
  if (secondRun.getTime() - nextRun.getTime() < 60_000) {
    throw new Error("cron interval must be at least 1 minute");
  }
  return { cronExpression, timezone };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

async function authorizeCronJobView(user: ReturnType<typeof getOptionalAuth>, job: CronJobAuthSubject) {
  if (job.spaceId) return hasPermission(user, "cronjob.view", { spaceId: job.spaceId, sessionId: job.sessionId ?? undefined });
  return !!user && job.userUuid === user.uuid;
}

async function authorizeCronJobManage(c: Context, user: Exclude<ReturnType<typeof useAuth>, Response>, job: CronJobAuthSubject) {
  if (job.spaceId) {
    if (!(await hasPermission(user, "cronjob.manage", { spaceId: job.spaceId, sessionId: job.sessionId ?? undefined }))) return false;
    // An app session acts for one viewer: it may only manage that viewer's
    // own jobs, never another member's (whose quota they would spend).
    if (getAppSessionPrincipal(c) && job.userUuid !== user.uuid) return false;
    return true;
  }
  return job.userUuid === user.uuid;
}

async function authorizeTaskRunView(user: ReturnType<typeof getOptionalAuth>, job: CronJobAuthSubject) {
  if (job.spaceId) return hasPermission(user, "taskrun.view", { spaceId: job.spaceId, sessionId: job.sessionId ?? undefined });
  return !!user && job.userUuid === user.uuid;
}

async function loadCronJobAuthSubject(cronJobId: string): Promise<CronJobAuthSubject | null> {
  const [job] = await db
    .select({
      id: cronJobs.id,
      userUuid: cronJobs.userUuid,
      spaceId: cronJobs.spaceId,
      sessionId: cronJobs.sessionId,
    })
    .from(cronJobs)
    .where(and(eq(cronJobs.id, cronJobId), isNull(cronJobs.deletedAt)))
    .limit(1);
  return job ?? null;
}

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

router.get("/", async (c) => {
  const spaceId = c.req.query("spaceId") ?? null;
  const user = spaceId ? getOptionalAuth(c) : useAuth(c);
  if (user instanceof Response) return user;
  const userId = user?.uuid;

  if (spaceId && !requireValidId(spaceId)) return c.json({ message: "invalid spaceId" }, 400);

  if (spaceId) {
    if (!(await hasPermission(user, "cronjob.view", { spaceId }))) return authzDenied(c);
    const jobs = await db
      .select()
      .from(cronJobs)
      .where(and(eq(cronJobs.spaceId, spaceId), isNull(cronJobs.deletedAt)))
      .orderBy(desc(cronJobs.createdAt));
    return c.json({ jobs: await hydrateCronJobUserProfiles(jobs) });
  }

  if (!userId) return c.json({ message: "unauthorized" }, 401);

  const jobs = await db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.userUuid, userId), isNull(cronJobs.deletedAt)))
    .orderBy(desc(cronJobs.createdAt));

  return c.json({ jobs: await hydrateCronJobUserProfiles(jobs) });
});

router.get("/:id", async (c) => {
  const user = getOptionalAuth(c);
  const cronJobId = c.req.param("id");
  if (!requireValidId(cronJobId)) return c.json({ message: "not found" }, 404);

  const [job] = await db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.id, cronJobId), isNull(cronJobs.deletedAt)))
    .limit(1);
  if (!job) return c.json({ message: "not found" }, 404);
  if (!(await authorizeCronJobView(user, job))) return authzDenied(c);

  const [hydrated] = await hydrateCronJobUserProfiles([job]);
  return c.json({ job: hydrated });
});

router.get("/:id/runs", async (c) => {
  const user = getOptionalAuth(c);

  const cronJobId = c.req.param("id");
  if (!requireValidId(cronJobId)) return c.json({ message: "not found" }, 404);

  const job = await loadCronJobAuthSubject(cronJobId);
  if (!job) return c.json({ message: "not found" }, 404);
  const canViewSpaceData = job.spaceId
    ? await hasPermission(user, "taskrun.view", { spaceId: job.spaceId, sessionId: job.sessionId ?? undefined })
    : false;
  if (!(await authorizeTaskRunView(user, job))) return authzDenied(c);

  const limitParam = Number(c.req.query("limit") ?? 20);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.floor(limitParam), 1), MAX_RUNS_LIMIT) : 20;
  const cursor = parseTaskCursor(c.req.query("cursor"));
  if (cursor === "invalid") return c.json({ message: "invalid cursor" }, 400);

  const conditions = [eq(taskRuns.cronJobId, cronJobId)];
  if (cursor) {
    const cursorCondition = cursor.id
      ? or(lt(taskRuns.createdAt, cursor.createdAt), and(eq(taskRuns.createdAt, cursor.createdAt), lt(taskRuns.id, cursor.id)))
      : lt(taskRuns.createdAt, cursor.createdAt);
    if (cursorCondition) conditions.push(cursorCondition);
  }

  const rows = await db
    .select()
    .from(taskRuns)
    .where(and(...conditions))
    .orderBy(desc(taskRuns.createdAt), desc(taskRuns.id))
    .limit(limit + 1);
  const runs = rows
    .slice(0, limit)
    .map((run) => sanitizeTaskRunPricingForViewer(run, user?.uuid, { canViewSpaceData }));

  return c.json({
    runs,
    pageInfo: {
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit ? buildTaskCursor(runs.at(-1)) : null,
    },
  });
});

router.delete("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;

  const cronJobId = c.req.param("id");
  if (!requireValidId(cronJobId)) return c.json({ message: "not found" }, 404);

  const [job] = await db
    .select({
      id: cronJobs.id,
      userUuid: cronJobs.userUuid,
      spaceId: cronJobs.spaceId,
      sessionId: cronJobs.sessionId,
      bullJobKey: cronJobs.bullJobKey,
    })
    .from(cronJobs)
    .where(and(eq(cronJobs.id, cronJobId), isNull(cronJobs.deletedAt)))
    .limit(1);
  if (!job) return c.json({ message: "not found" }, 404);
  if (!(await authorizeCronJobManage(c, user, job))) return authzDenied(c);

  await removeCronJob(cronJobId);
  return c.json({ ok: true });
});

router.patch("/:id", async (c) => {
  const user = useAuth(c);
  if (user instanceof Response) return user;

  const cronJobId = c.req.param("id");
  if (!requireValidId(cronJobId)) return c.json({ message: "not found" }, 404);

  const [job] = await db
    .select()
    .from(cronJobs)
    .where(and(eq(cronJobs.id, cronJobId), isNull(cronJobs.deletedAt)))
    .limit(1);
  if (!job) return c.json({ message: "not found" }, 404);
  if (!(await authorizeCronJobManage(c, user, job))) return authzDenied(c);

  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return c.json({ message: "invalid json body" }, 400);
  if ("taskType" in body) return c.json({ message: "taskType cannot be changed" }, 400);

  const patch: {
    title?: string;
    payload?: Record<string, unknown>;
    cronExpression?: string;
    timezone?: string;
    enabled?: boolean;
  } = {};

  if ("title" in body) {
    if (typeof body.title !== "string" || !body.title.trim()) return c.json({ message: "title is required" }, 400);
    if (body.title.trim().length > 255) return c.json({ message: "title must be at most 255 characters" }, 400);
    patch.title = body.title.trim();
  }

  if ("payload" in body) {
    // App sessions must not rewrite task payloads: the payload carries both
    // the content and the app's authorization reference. Scheduled prompts
    // are created through the gated prompt endpoint; apps can delete and
    // re-create instead of editing.
    if (getAppSessionPrincipal(c)) return c.json({ message: "apps cannot edit task payloads; create a new scheduled prompt instead" }, 403);
    if (!isRecord(body.payload)) return c.json({ message: "payload must be an object" }, 400);
    // payload.auth is server-generated provenance: whatever a client sends
    // under it is dropped and the original is preserved verbatim, so no
    // account can inject or swap an app authorization reference.
    patch.payload = preserveCronPayloadServerFields(
      sanitizePostgresJsonValue(body.payload) as Record<string, unknown>,
      job.payload,
    );
  }

  const nextCronExpression = "cronExpression" in body ? body.cronExpression : undefined;
  const nextTimezone = "timezone" in body ? body.timezone : undefined;
  if (nextCronExpression !== undefined || nextTimezone !== undefined) {
    if (nextCronExpression !== undefined && typeof nextCronExpression !== "string") return c.json({ message: "cronExpression must be a string" }, 400);
    if (nextTimezone !== undefined && typeof nextTimezone !== "string") return c.json({ message: "timezone must be a string" }, 400);
    try {
      const schedule = validateCronSchedule({
        cronExpression: nextCronExpression === undefined ? job.cronExpression : nextCronExpression,
        timezone: nextTimezone === undefined ? job.timezone : nextTimezone,
      });
      patch.cronExpression = schedule.cronExpression;
      patch.timezone = schedule.timezone;
    } catch (error) {
      return c.json({ message: error instanceof Error ? error.message : "invalid schedule" }, 400);
    }
  }

  if ("enabled" in body) {
    if (typeof body.enabled !== "boolean") return c.json({ message: "enabled must be a boolean" }, 400);
    patch.enabled = body.enabled;
  }

  if (Object.keys(patch).length === 0) return c.json({ message: "no changes provided" }, 400);

  if (patch.enabled !== undefined && Object.keys(patch).length === 1) {
    if (patch.enabled && !job.enabled) {
      const enabledJob = await enableCronJob(cronJobId, {
        taskType: job.taskType,
        payload: job.payload as Record<string, unknown>,
        cronExpression: job.cronExpression,
        timezone: job.timezone,
        userUuid: job.userUuid,
        spaceId: job.spaceId,
        sessionId: job.sessionId,
      });
      const [hydrated] = await hydrateCronJobUserProfiles([enabledJob]);
      return c.json({ ok: true, job: hydrated });
    }
    if (!patch.enabled && job.enabled) {
      await disableCronJob(cronJobId);
    }
    const [freshJob] = await db.select().from(cronJobs).where(eq(cronJobs.id, cronJobId)).limit(1);
    const [hydrated] = await hydrateCronJobUserProfiles([freshJob ?? { ...job, enabled: patch.enabled }]);
    return c.json({ ok: true, job: hydrated });
  }

  const updatedJob = await updateCronJob(job, patch);
  const [hydrated] = await hydrateCronJobUserProfiles([updatedJob]);
  return c.json({ ok: true, job: hydrated });
});

export default router;
