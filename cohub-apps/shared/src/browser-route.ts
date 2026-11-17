import {
  isUuid,
  readResourceAppTarget,
  type ResourceAppKind,
} from "@cohub/protocol";
import type { AppRuntimeContext, Permission } from "@neta-art/cohub";
import { readScopes } from "./access.ts";

export type ResourceScope =
  | { kind: "space"; spaceId: string; sessionId?: string }
  | { kind: "mine" };

export function readBrowserRoute(
  hash: string,
  kind: ResourceAppKind,
  context: AppRuntimeContext,
) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const requested = params.get("space");
  const explicit = requested && isUuid(requested) ? requested : null;
  const source = context.invocation?.spaceId;
  const spaceId =
    explicit ??
    (kind === "task" && params.get("scope") === "mine"
      ? ""
      : source && isUuid(source)
        ? source
        : "");
  const session =
    params.get("session") ??
    (!params.has("space") && !params.has("scope") && !params.has("resource")
      ? context.invocation?.sessionId
      : null);
  const scope: ResourceScope | null =
    kind === "task" && params.get("scope") === "mine"
      ? { kind: "mine" }
      : spaceId
        ? {
            kind: "space",
            spaceId,
            ...(kind === "task" && session && isUuid(session)
              ? { sessionId: session }
              : {}),
          }
        : kind === "task"
          ? { kind: "mine" }
          : null;
  const target = readResourceAppTarget(params);
  const invalid = Boolean(
    (requested && !explicit) ||
      (params.has("resource") &&
        (!target ||
          target.kind !== kind ||
          (!spaceId && !(kind === "task" && scope?.kind === "mine")))),
  );
  return {
    scope,
    spaceId,
    target: !invalid && target?.kind === kind ? target : null,
    invalid,
  };
}

export function scopeHash(scope: ResourceScope | null) {
  const params = new URLSearchParams();
  if (scope?.kind === "mine") params.set("scope", "mine");
  if (scope?.kind === "space") {
    params.set("space", scope.spaceId);
    if (scope.sessionId) params.set("session", scope.sessionId);
  }
  return `#${params}`;
}

export function scopePermissions(
  kind: ResourceAppKind,
  scope: ResourceScope,
): Permission[] {
  return scope.kind === "mine" ? ["user.taskrun.list"] : readScopes(kind);
}
