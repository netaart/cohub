import type { AppRecord, TaskRunRecord } from "@neta-art/cohub";
import { m } from "$messages";
import type { Locale } from "$kit/core.ts";

export type Tone = "success" | "error" | "info" | "warning" | "brand" | "muted";

export type StatusView = { tone: Tone; label: string; live?: boolean };

export function taskStatus(
  status: TaskRunRecord["status"],
  locale: Locale,
): StatusView {
  switch (status) {
    case "completed":
      return { tone: "success", label: m.task_status_completed({}, { locale }) };
    case "failed":
      return { tone: "error", label: m.task_status_failed({}, { locale }) };
    case "running":
      return {
        tone: "info",
        label: m.task_status_running({}, { locale }),
        live: true,
      };
    case "pending":
      return {
        tone: "warning",
        label: m.task_status_pending({}, { locale }),
        live: true,
      };
    default:
      return { tone: "muted", label: status };
  }
}

export function scheduleStatus(enabled: boolean, locale: Locale): StatusView {
  return enabled
    ? { tone: "success", label: m.cron_active({}, { locale }) }
    : { tone: "muted", label: m.cron_paused({}, { locale }) };
}

export function appStatus(
  status: AppRecord["status"],
  locale: Locale,
): StatusView {
  return status === "published"
    ? { tone: "success", label: m.resource_app_published({}, { locale }) }
    : { tone: "error", label: m.resource_app_disabled({}, { locale }) };
}

export function appVisibility(
  visibility: AppRecord["visibility"],
  locale: Locale,
): StatusView {
  return visibility === "public"
    ? { tone: "brand", label: m.resource_app_public({}, { locale }) }
    : { tone: "muted", label: m.resource_app_space_access({}, { locale }) };
}
