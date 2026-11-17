import type { ResourceAppKind } from "@cohub/protocol";
import type {
  AppRecord,
  CheckpointRecord,
  CronJobRecord,
  TaskRunRecord,
} from "@neta-art/cohub";
import { asRecord } from "$kit/core.ts";
import { appActionName } from "$kit/task-run.ts";
import { client } from "./client.ts";
import type { ResourceScope } from "./browser-route.ts";

export type TaskRow = {
  kind: "task";
  id: string;
  spaceId: string;
  sessionId: string | null;
  taskType: string;
  action: string | null;
  status: TaskRunRecord["status"];
  cronJobId: string | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};
export type CheckpointRow = {
  kind: "checkpoint";
  id: string;
  spaceId: string;
  description: string;
  commitHash: string;
  changedFiles: number | null;
  createdAt: string;
};
export type ScheduleRow = {
  kind: "cronjob";
  id: string;
  spaceId: string;
  title: string;
  cronExpression: string;
  timezone: string;
  enabled: boolean;
  createdAt: string;
};
export type AppRow = {
  kind: "app";
  id: string;
  spaceId: string;
  title: string;
  slug: string;
  latestVersion: number;
  status: AppRecord["status"];
  visibility: AppRecord["visibility"];
  createdAt: string | null;
};
export type ResourceRow = TaskRow | CheckpointRow | ScheduleRow | AppRow;
export type ResourcePage = { rows: ResourceRow[]; cursor: string | null };
export type TaskFilter = "all" | "active" | "failed" | "completed";

export const TASK_FILTERS: TaskFilter[] = ["all", "active", "failed", "completed"];

const PAGE_SIZE = 30;

export function taskRow(run: TaskRunRecord): TaskRow {
  return {
    kind: "task",
    id: run.id,
    spaceId: run.spaceId ?? "",
    sessionId: run.sessionId,
    taskType: run.taskType,
    action: appActionName(run),
    status: run.status,
    cronJobId: run.cronJobId,
    errorMessage: run.errorMessage?.slice(0, 240) ?? null,
    createdAt: run.createdAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
}

export function matchesTaskFilter(
  status: TaskRunRecord["status"],
  filter: TaskFilter,
) {
  if (filter === "all") return true;
  if (filter === "active") return status === "pending" || status === "running";
  return status === filter;
}

function checkpointRow(item: CheckpointRecord): CheckpointRow {
  const changed = asRecord(asRecord(item.meta)?.stats)?.changedFileCount;
  return {
    kind: "checkpoint",
    id: item.id,
    spaceId: item.spaceId,
    description: item.description?.trim() ?? "",
    commitHash: item.commitHash,
    changedFiles: typeof changed === "number" ? changed : null,
    createdAt: item.createdAt,
  };
}

function scheduleRow(item: CronJobRecord): ScheduleRow {
  return {
    kind: "cronjob",
    id: item.id,
    spaceId: item.spaceId ?? "",
    title: item.title,
    cronExpression: item.cronExpression,
    timezone: item.timezone,
    enabled: item.enabled,
    createdAt: item.createdAt,
  };
}

function appRow(item: AppRecord): AppRow {
  return {
    kind: "app",
    id: item.id,
    spaceId: item.spaceId,
    title: item.meta?.title?.trim() || item.slug,
    slug: item.slug,
    latestVersion: item.latestVersion,
    status: item.status,
    visibility: item.visibility,
    createdAt: item.createdAt,
  };
}

export async function listResources(
  kind: ResourceAppKind,
  scope: ResourceScope,
  filter: TaskFilter,
  cursor?: string | null,
): Promise<ResourcePage> {
  if (kind === "task") {
    const result = await client.tasks.list({
      ...(scope.kind === "space"
        ? { spaceId: scope.spaceId, sessionId: scope.sessionId }
        : {}),
      ...(filter === "all" ? {} : { status: filter }),
      limit: PAGE_SIZE,
      ...(cursor ? { cursor } : {}),
    });
    return {
      rows: result.runs
        .filter(
          (run) => scope.kind === "mine" || run.spaceId === scope.spaceId,
        )
        .map(taskRow),
      cursor: result.pageInfo?.hasMore ? result.pageInfo.nextCursor : null,
    };
  }
  if (scope.kind !== "space") throw new Error("A Space is required");
  const { spaceId } = scope;
  if (kind === "checkpoint") {
    const result = await client
      .space(spaceId)
      .checkpoints.list({ limit: PAGE_SIZE, cursor });
    return {
      rows: result.checkpoints
        .filter((item) => item.spaceId === spaceId)
        .map(checkpointRow),
      cursor: result.pageInfo?.hasMore ? result.pageInfo.nextCursor : null,
    };
  }
  if (kind === "cronjob") {
    const { jobs } = await client.cronJobs.list(spaceId);
    return {
      rows: jobs.filter((item) => item.spaceId === spaceId).map(scheduleRow),
      cursor: null,
    };
  }
  const { apps } = await client.apps.listBySpace(spaceId);
  return {
    rows: apps.filter((item) => item.spaceId === spaceId).map(appRow),
    cursor: null,
  };
}
