import { isUuidLike } from "./identifiers.js";

export type TurnNotificationSource = "chat" | "scheduled" | "hook" | "background";
export type SilenceableNotificationSource = Exclude<TurnNotificationSource, "chat">;

export const SILENCEABLE_NOTIFICATION_SOURCES = ["scheduled", "hook", "background"] as const satisfies readonly SilenceableNotificationSource[];
export const MAX_CRON_JOB_NOTIFICATION_OVERRIDES = 500;

export type NotificationPreferences = {
  success: Record<SilenceableNotificationSource, boolean>;
  /** Per scheduled task; wins over `success.scheduled`. Absent = follow global. */
  cronJobs: Record<string, boolean>;
};

export type UserPreferences = { notifications: NotificationPreferences };

export type NotificationPreferencesPatch = {
  success?: Partial<Record<SilenceableNotificationSource, boolean>>;
  /** `null` removes the override so the task follows the global switch again. */
  cronJobs?: Record<string, boolean | null>;
};

export type UserPreferencesPatch = { notifications?: NotificationPreferencesPatch };

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** Tolerant read: unknown or malformed fields fall back to defaults. */
export function parseUserPreferences(value: unknown): UserPreferences {
  const notifications = record(record(value)?.notifications);
  const success = record(notifications?.success);
  const cronJobs: Record<string, boolean> = {};
  for (const [id, enabled] of Object.entries(record(notifications?.cronJobs) ?? {})) {
    if (isUuidLike(id) && typeof enabled === "boolean") cronJobs[id] = enabled;
  }
  return {
    notifications: {
      success: {
        scheduled: success?.scheduled !== false,
        hook: success?.hook !== false,
        background: success?.background !== false,
      },
      cronJobs,
    },
  };
}

/** Strict read of a client patch; throws with a message suitable for a 400. */
export function parseUserPreferencesPatch(value: unknown): UserPreferencesPatch {
  const input = record(value);
  if (!input) throw new Error("preferences patch must be an object");
  if (input.notifications === undefined) return {};
  const notifications = record(input.notifications);
  if (!notifications) throw new Error("notifications must be an object");
  const patch: NotificationPreferencesPatch = {};
  if (notifications.success !== undefined) {
    const success = record(notifications.success);
    if (!success) throw new Error("notifications.success must be an object");
    patch.success = {};
    for (const [source, enabled] of Object.entries(success)) {
      if (!(SILENCEABLE_NOTIFICATION_SOURCES as readonly string[]).includes(source)) {
        throw new Error(`notifications.success.${source} is not a known source; use ${SILENCEABLE_NOTIFICATION_SOURCES.join(", ")}`);
      }
      if (typeof enabled !== "boolean") throw new Error(`notifications.success.${source} must be a boolean`);
      patch.success[source as SilenceableNotificationSource] = enabled;
    }
  }
  if (notifications.cronJobs !== undefined) {
    const cronJobs = record(notifications.cronJobs);
    if (!cronJobs) throw new Error("notifications.cronJobs must be an object");
    patch.cronJobs = {};
    for (const [id, enabled] of Object.entries(cronJobs)) {
      if (!isUuidLike(id)) throw new Error(`notifications.cronJobs key ${id} must be a cron job id`);
      if (enabled !== null && typeof enabled !== "boolean") throw new Error(`notifications.cronJobs.${id} must be a boolean or null`);
      patch.cronJobs[id] = enabled;
    }
  }
  return { notifications: patch };
}

export function applyUserPreferencesPatch(current: UserPreferences, patch: UserPreferencesPatch): UserPreferences {
  const changes = patch.notifications;
  if (!changes) return current;
  const cronJobs = { ...current.notifications.cronJobs };
  for (const [id, enabled] of Object.entries(changes.cronJobs ?? {})) {
    if (enabled === null) delete cronJobs[id];
    else cronJobs[id] = enabled;
  }
  return {
    notifications: {
      success: { ...current.notifications.success, ...changes.success },
      cronJobs,
    },
  };
}

export function turnNotificationSource(context: unknown): TurnNotificationSource {
  switch (record(context)?.kind) {
    case "scheduled_task":
      return "scheduled";
    case "space_hook":
      return "hook";
    case "background_bash_task":
      return "background";
    default:
      return "chat";
  }
}

/** Per task wins over the global switch; failures and interruptions always notify. */
export function shouldNotifyTurn(
  preferences: NotificationPreferences,
  turn: { status: string; source: TurnNotificationSource; cronJobId?: string | null },
): boolean {
  if (turn.status !== "completed" || turn.source === "chat") return true;
  const override = turn.cronJobId ? preferences.cronJobs[turn.cronJobId] : undefined;
  return override ?? preferences.success[turn.source];
}
