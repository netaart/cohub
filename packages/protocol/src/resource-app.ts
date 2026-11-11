import { isUuid } from "./identifiers.js";

/** Resource routes are App launch state, never workspace file paths. */
export const RESOURCE_APP_KINDS = [
  "task",
  "checkpoint",
  "cronjob",
  "app",
] as const;
export type ResourceAppKind = (typeof RESOURCE_APP_KINDS)[number];
export type ResourceAppTarget = {
  kind: ResourceAppKind;
  id: string;
  base?: string;
};

export function resourceAppRef(target: Pick<ResourceAppTarget, "kind">) {
  const slug = {
    task: "task-inspector",
    checkpoint: "checkpoint-explorer",
    cronjob: "schedule-manager",
    app: "app-manager",
  }[target.kind];
  return `tzwm/cohub/${slug}`;
}

export function readResourceAppTarget(
  search: URLSearchParams,
): ResourceAppTarget | null {
  const value = search.get("resource");
  if (!value) return null;
  const [kind, id, extra] = value.split(":");
  if (
    extra !== undefined ||
    !RESOURCE_APP_KINDS.includes(kind as ResourceAppKind)
  )
    return null;
  if (
    !id ||
    (!isUuid(id) &&
      !(id === "new" && (kind === "checkpoint" || kind === "cronjob")))
  )
    return null;
  const base = search.get("resourceBase");
  if (base && (kind !== "checkpoint" || !isUuid(base))) return null;
  return { kind: kind as ResourceAppKind, id, ...(base ? { base } : {}) };
}

export function writeResourceAppTarget(
  search: URLSearchParams,
  target: ResourceAppTarget | null,
) {
  search.delete("resource");
  search.delete("resourceBase");
  if (!target) return;
  search.set("resource", `${target.kind}:${target.id}`);
  if (target.base) search.set("resourceBase", target.base);
}

export function resourceAppLaunch(
  spaceId: string,
  target: ResourceAppTarget | null = null,
) {
  const params = new URLSearchParams({ space: spaceId });
  writeResourceAppTarget(params, target);
  return { hash: `#${params}` };
}

export function readResourceAppLaunch(hash: string) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const spaceId = params.get("space");
  const target = readResourceAppTarget(params);
  return spaceId && isUuid(spaceId) && target ? { spaceId, target } : null;
}
