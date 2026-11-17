import type { Component } from "svelte";
import type { Permission } from "@neta-art/cohub";
import type { AppNavigationTarget } from "@cohub/protocol/app-navigation";
import type { ResourceAppTarget } from "@cohub/protocol";
import type { ResourceDetail } from "./client.ts";

export type ResourceViewModule = { default: Component<ViewProps> };

export type ViewProps = {
  target: ResourceAppTarget;
  spaceId: string;
  detail: ResourceDetail | null;
  busy: boolean;
  draft: Record<string, unknown> | null;
  action: (
    scopes: Permission[],
    run: () => Promise<void>,
    options?: { write?: boolean },
  ) => Promise<boolean>;
  authorize: (scopes: Permission[]) => Promise<boolean>;
  updateDraft: (draft: Record<string, unknown> | null) => void;
  setDetail: (detail: ResourceDetail) => void;
  refresh: () => Promise<void>;
  openDetail: (id: string, base?: string) => void;
  back: () => void;
  removed: (message: string) => void;
  navigateRelated: (target: AppNavigationTarget) => Promise<void>;
};
