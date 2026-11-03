import {
  createCohubClient,
  resolveWebBaseUrl,
  type AppRecord,
  type AppVersionRecord,
  type CronJobRecord,
  type CheckpointRecord,
  type PublicUserProfile,
  type TaskRunDetailResponse,
} from "@neta-art/cohub";
import {
  resourceAppRef,
  resourceAppLaunch,
  type ResourceAppTarget,
} from "@cohub/protocol";
import type { AppNavigationTarget } from "@cohub/protocol/app-navigation";
import type { AppTotals } from "$kit/app";

const environment = import.meta.env.VITE_COHUB_ENV === "dev" ? "dev" : "prod";
export const client = createCohubClient({ env: environment });

export function webUrl(path: string) {
  return new URL(path, resolveWebBaseUrl({ env: environment })).href;
}

export function nativeResourceUrl(spaceId: string, target: ResourceAppTarget) {
  const segment = {
    task: "tasks",
    checkpoint: "checkpoints",
    cronjob: "cronjobs",
    app: "apps",
  }[target.kind];
  const url = new URL(webUrl(`/spaces/${spaceId}/${segment}/${target.id}`));
  url.searchParams.set("native", "1");
  if (target.base) url.searchParams.set("base", target.base);
  return url.href;
}

export async function openRelated(
  target: AppNavigationTarget,
): Promise<string | null> {
  let resolved = target;
  let fallback: string | null = null;
  if (
    target.kind === "task" ||
    target.kind === "checkpoint" ||
    target.kind === "cronjob"
  ) {
    const id =
      target.kind === "task"
        ? target.taskRunId
        : target.kind === "checkpoint"
          ? target.checkpointId
          : target.cronjobId;
    const resource = { kind: target.kind, id };
    const ref = resourceAppRef(resource);
    const launch = resourceAppLaunch(target.spaceId, resource);
    resolved = { kind: "app", ref, launch };
    const [owner, space, app] = ref.split("/");
    fallback = webUrl(`/${owner}/${space}/w/${app}${launch.hash}`);
  } else if (target.kind === "session") {
    fallback = webUrl(
      `/spaces/${encodeURIComponent(target.spaceId)}/sessions/${encodeURIComponent(target.sessionId)}`,
    );
  }
  const result = await client.navigation.open(resolved).catch(() => null);
  if (result?.handled) return null;
  if (fallback) return fallback;
  if (target.kind === "app")
    return (await client.apps.getPublicById(target.ref)).publicUrl;
  throw new Error("Navigation is unavailable");
}

type SpaceEventHandler = Parameters<ReturnType<typeof client.space>["subscribe"]>[0];
export type SpaceEvent = Parameters<SpaceEventHandler>[0];

export function subscribeSpace(spaceId: string, handler: SpaceEventHandler) {
  try {
    return client.space(spaceId).subscribe(handler);
  } catch {
    return null;
  }
}

export type ResourceDetail =
  | { kind: "task"; data: TaskRunDetailResponse }
  | { kind: "checkpoint"; data: CheckpointRecord }
  | { kind: "cronjob"; data: CronJobRecord }
  | AppDetail;

export type AppDetail = {
  kind: "app";
  data: AppRecord;
  versions: AppVersionRecord[];
  publicUrl: string | null;
  publisher: PublicUserProfile | null;
  totals: AppTotals;
};

async function loadApp(id: string): Promise<AppDetail> {
  const [detail, { versions }] = await Promise.all([client.apps.get(id), client.apps.listVersions(id)]);
  return {
    kind: "app",
    data: detail.app,
    versions,
    publicUrl: detail.publicUrl,
    publisher: detail.publisher ?? null,
    totals: { totalViews: detail.totalViews, likeCount: detail.likeCount },
  };
}

export async function loadResource(
  spaceId: string,
  target: ResourceAppTarget,
): Promise<ResourceDetail> {
  let result: ResourceDetail;
  switch (target.kind) {
    case "task":
      result = { kind: "task", data: await client.tasks.get(target.id, { include: ["boards"] }) };
      break;
    case "checkpoint":
      result = {
        kind: "checkpoint",
        data: (await client.space(spaceId).checkpoints.get(target.id))
          .checkpoint,
      };
      break;
    case "cronjob":
      result = {
        kind: "cronjob",
        data: (await client.cronJobs.get(target.id)).job,
      };
      break;
    case "app":
      result = await loadApp(target.id);
      break;
  }
  const resource = result.kind === "task" ? result.data.run : result.data;
  if ((resource.spaceId ?? "") !== spaceId || resource.id !== target.id)
    throw new Error("Resource does not belong to the requested Space");
  return result;
}
