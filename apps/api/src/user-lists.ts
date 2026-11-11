import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { apps, cronJobs, spaces, taskRuns, userProfiles } from "@cohub/db";
import { isUuid, type UserAppFilter, type UserCronJobFilter } from "@cohub/protocol";
import { getRealtimeUserRoom } from "@cohub/protocol/realtime";
import * as cronParser from "cron-parser";
import { createLogger } from "@cohub/infra/logging";
import { dispatchRealtimeEvent } from "./channels.js";
import { db } from "./db/index.js";
import { createAppPublicUrl } from "./lib/app-public-url.js";
import { filterSpaceIdsByPermission, listAccessibleSpaceIds } from "./permissions.js";
import { serializeAppRecord } from "./routes/apps-wire.js";
import { spaceAudienceUserIds } from "./space-list-events.js";
import { attachSpaceSummaries, toSpaceSummary } from "./space-sessions.js";
import { fallbackPublicUserProfile, getProfilesByUuids } from "./user-profiles.js";

const logger = createLogger({ serviceName: "cohub-api" });

export const USER_LIST_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const EPOCH = new Date(0);
const EMPTY_PAGE = { items: [], pageInfo: { hasMore: false, nextCursor: null } };

export class InvalidUserListCursorError extends Error {}

type Cursor = { at: Date; id: string };

export function resolveUserListLimit(raw: string | undefined) {
  const value = Number(raw ?? USER_LIST_PAGE_SIZE);
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), MAX_PAGE_SIZE) : USER_LIST_PAGE_SIZE;
}

const msSortKey = (column: AnyPgColumn) => sql`date_trunc('milliseconds', coalesce(${column}, 'epoch'::timestamptz))`;

function parseCursor(raw: string | undefined | null): Cursor | null {
  if (!raw) return null;
  const [at, id] = raw.split("|");
  const date = new Date(at ?? "");
  if (Number.isNaN(date.getTime()) || !isUuid(id)) throw new InvalidUserListCursorError("invalid cursor");
  return { at: date, id };
}

function page<T>(rows: T[], limit: number, cursorOf: (row: T) => Cursor) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  const next = rows.length > limit && last !== undefined ? cursorOf(last) : null;
  return {
    items,
    pageInfo: { hasMore: next !== null, nextCursor: next ? `${next.at.toISOString()}|${next.id}` : null },
  };
}

async function manageableSpaceIds(userUuid: string, permission: "app.manage" | "cronjob.manage") {
  return filterSpaceIdsByPermission({ uuid: userUuid }, permission, await listAccessibleSpaceIds(userUuid));
}

export async function listUserApps(userUuid: string, options: { filter: UserAppFilter; cursor?: string | null; limit: number }) {
  const cursor = parseCursor(options.cursor);
  const sortAt = msSortKey(apps.updatedAt);
  const conditions: SQL[] = [];
  if (options.filter === "mine") {
    const accessible = await listAccessibleSpaceIds(userUuid);
    if (accessible.length === 0) return EMPTY_PAGE;
    conditions.push(eq(apps.userUuid, userUuid), inArray(apps.spaceId, accessible));
  } else {
    const manageable = await manageableSpaceIds(userUuid, "app.manage");
    if (manageable.length === 0) return EMPTY_PAGE;
    conditions.push(inArray(apps.spaceId, manageable));
    if (options.filter === "disabled") conditions.push(eq(apps.status, "disabled"));
  }
  if (cursor) conditions.push(sql`(${sortAt}, ${apps.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`);

  const rows = await db
    .select({ app: apps, space: spaces, ownerUsername: userProfiles.username })
    .from(apps)
    .innerJoin(spaces, eq(spaces.id, apps.spaceId))
    .leftJoin(userProfiles, eq(userProfiles.userUuid, spaces.userUuid))
    .where(and(...conditions))
    .orderBy(desc(sortAt), desc(apps.id))
    .limit(options.limit + 1);

  const result = page(rows, options.limit, ({ app }) => ({ at: app.updatedAt ?? EPOCH, id: app.id }));
  return {
    ...result,
    items: result.items.map(({ app, space, ownerUsername }) => ({
      ...serializeAppRecord(app, "canonical"),
      space: toSpaceSummary(space),
      publicUrl: ownerUsername && space.slug
        ? createAppPublicUrl({ ownerUsername, spaceSlug: space.slug, appSlug: app.slug, status: app.status })
        : null,
    })),
  };
}

function nextRunAt(job: { enabled: boolean; cronExpression: string; timezone: string }) {
  if (!job.enabled) return null;
  try {
    return cronParser.CronExpressionParser.parse(job.cronExpression, { tz: job.timezone }).next().toDate().toISOString();
  } catch {
    return null;
  }
}

export async function listUserCronJobs(userUuid: string, options: { filter: UserCronJobFilter; cursor?: string | null; limit: number }) {
  const cursor = parseCursor(options.cursor);
  const manageable = await manageableSpaceIds(userUuid, "cronjob.manage");
  const manageableSet = new Set(manageable);
  const mine = eq(cronJobs.userUuid, userUuid);
  const visible = manageable.length > 0 ? or(mine, inArray(cronJobs.spaceId, manageable)) : mine;
  const lastRun = db
    .select({ status: taskRuns.status, finishedAt: taskRuns.finishedAt, createdAt: taskRuns.createdAt })
    .from(taskRuns)
    .where(eq(taskRuns.cronJobId, cronJobs.id))
    .orderBy(desc(taskRuns.createdAt), desc(taskRuns.id))
    .limit(1)
    .as("last_run");
  const sortAt = msSortKey(cronJobs.createdAt);

  const conditions: SQL[] = [isNull(cronJobs.deletedAt)];
  switch (options.filter) {
    case "mine":
      conditions.push(mine);
      break;
    case "all":
      conditions.push(visible as SQL);
      break;
    case "paused":
      conditions.push(visible as SQL, eq(cronJobs.enabled, false));
      break;
    case "attention": {
      const lost = manageable.length > 0
        ? and(isNotNull(cronJobs.spaceId), notInArray(cronJobs.spaceId, manageable))
        : isNotNull(cronJobs.spaceId);
      conditions.push(mine, or(eq(lastRun.status, "failed"), lost) as SQL);
      break;
    }
  }
  if (cursor) conditions.push(sql`(${sortAt}, ${cronJobs.id}) < (${cursor.at.toISOString()}::timestamptz, ${cursor.id}::uuid)`);

  const rows = await db
    .select({
      job: {
        id: cronJobs.id,
        userUuid: cronJobs.userUuid,
        title: cronJobs.title,
        taskType: cronJobs.taskType,
        cronExpression: cronJobs.cronExpression,
        timezone: cronJobs.timezone,
        spaceId: cronJobs.spaceId,
        sessionId: cronJobs.sessionId,
        enabled: cronJobs.enabled,
        createdAt: cronJobs.createdAt,
        updatedAt: cronJobs.updatedAt,
      },
      lastRun: { status: lastRun.status, finishedAt: lastRun.finishedAt, createdAt: lastRun.createdAt },
    })
    .from(cronJobs)
    .leftJoinLateral(lastRun, sql`true`)
    .where(and(...conditions))
    .orderBy(desc(sortAt), desc(cronJobs.id))
    .limit(options.limit + 1);

  const result = page(rows, options.limit, ({ job }) => ({ at: job.createdAt ?? EPOCH, id: job.id }));
  const [profiles, items] = await Promise.all([
    getProfilesByUuids(result.items.map(({ job }) => job.userUuid)),
    attachSpaceSummaries(result.items.map(({ job, lastRun: run }) => ({
      ...job,
      createdAt: job.createdAt?.toISOString() ?? null,
      updatedAt: job.updatedAt?.toISOString() ?? null,
      access: !job.spaceId || manageableSet.has(job.spaceId) ? "full" as const : "lost" as const,
      nextRunAt: nextRunAt(job),
      lastRun: run?.status
        ? { status: run.status, finishedAt: run.finishedAt?.toISOString() ?? null, createdAt: run.createdAt?.toISOString() ?? null }
        : null,
    }))),
  ]);
  return {
    ...result,
    items: items.map((item) => ({
      ...item,
      userProfile: profiles.get(item.userUuid) ?? fallbackPublicUserProfile(item.userUuid),
    })),
  };
}

async function dispatchListChanged(
  event: { type: "app.list.changed"; payload: { appId: string; spaceId: string } } | { type: "cronjob.list.changed"; payload: { cronJobId: string; spaceId: string | null } },
  ownerUuid: string,
) {
  const spaceId = event.payload.spaceId;
  const audience = (spaceId && (await spaceAudienceUserIds(spaceId, [ownerUuid]))) || [ownerUuid];
  await dispatchRealtimeEvent({
    id: randomUUID(),
    timestamp: Date.now(),
    domain: "space",
    type: event.type,
    rooms: audience.map(getRealtimeUserRoom),
    payload: { ...event.payload, revision: new Date().toISOString() },
  });
}

function notify(event: Parameters<typeof dispatchListChanged>[0], ownerUuid: string) {
  void dispatchListChanged(event, ownerUuid).catch((error) => {
    logger.warn(`[user-lists] failed to dispatch ${event.type}`, { ...event.payload, error });
  });
}

export const notifyAppListChanged = (app: { id: string; spaceId: string; userUuid: string }) =>
  notify({ type: "app.list.changed", payload: { appId: app.id, spaceId: app.spaceId } }, app.userUuid);

export const notifyCronJobListChanged = (job: { id: string; spaceId: string | null; userUuid: string }) =>
  notify({ type: "cronjob.list.changed", payload: { cronJobId: job.id, spaceId: job.spaceId } }, job.userUuid);
