import { m } from "$messages";
import type { Locale } from "$kit/core.ts";
import { appActionName, taskTypeLabel } from "$kit/task-run.ts";
import type { ResourceDetail } from "../client.ts";

export function resourceTitle(detail: ResourceDetail, locale: Locale) {
  switch (detail.kind) {
    case "task": {
      const action = appActionName(detail.data.run);
      return action
        ? m.task_type_app_action({ action }, { locale })
        : taskTypeLabel(detail.data.run.taskType, locale);
    }
    case "checkpoint":
      return (
        detail.data.description.trim() ||
        m.resource_app_save_title({ id: detail.data.commitHash.slice(0, 8) }, { locale })
      );
    case "cronjob":
      return detail.data.title;
    case "app":
      return detail.data.meta?.title?.trim() || detail.data.slug;
  }
}
