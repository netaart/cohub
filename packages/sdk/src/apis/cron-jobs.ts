import type { HttpTransport } from "../transport.js";
import type { CronJobRecord, CronJobUpdatePatch, CursorPageInfo, TaskRunRecord } from "../types.js";

export type CronJobRunsOptions = {
  limit?: number;
  cursor?: string | null;
};

const toQuery = (params: Record<string, string | number | null | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
};

/** `override` is this task's own setting; `null` follows `global` (the scheduled-prompt switch). */
export type CronJobNotificationSetting = { override: boolean | null; global: boolean };

export class CronJobsApi {
  constructor(private readonly transport: HttpTransport) {}

  list(spaceId?: string) {
    const query = toQuery({ spaceId });
    return this.transport.request<{ jobs: CronJobRecord[] }>(`/api/cron-jobs${query}`);
  }

  get<TPayload extends Record<string, unknown> = Record<string, unknown>>(id: string) {
    return this.transport.request<{ job: CronJobRecord<TPayload> }>(`/api/cron-jobs/${id}`);
  }

  update<TPayload extends Record<string, unknown> = Record<string, unknown>>(
    id: string,
    patch: CronJobUpdatePatch<TPayload>,
  ) {
    return this.transport.request<{ ok: true; job: CronJobRecord<TPayload> }>(`/api/cron-jobs/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
  }

  delete(id: string) {
    return this.transport.request<{ ok: true }>(`/api/cron-jobs/${id}`, {
      method: "DELETE",
    });
  }

  toggle(id: string, enabled: boolean) {
    return this.update(id, { enabled });
  }

  /** Whether successful runs pop up for the caller; only the task's owner receives them. */
  getNotification(id: string) {
    return this.transport.request<CronJobNotificationSetting>(`/api/cron-jobs/${id}/notification`);
  }

  setNotification(id: string, override: boolean | null) {
    return this.transport.request<CronJobNotificationSetting>(`/api/cron-jobs/${id}/notification`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ override }),
    });
  }

  runs(cronJobId: string, options: CronJobRunsOptions = {}) {
    const query = toQuery({ limit: options.limit, cursor: options.cursor });
    return this.transport.request<{ runs: TaskRunRecord[]; pageInfo: CursorPageInfo }>(
      `/api/cron-jobs/${cronJobId}/runs${query}`,
    );
  }
}
