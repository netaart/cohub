import type {
  NotificationCategory,
  NotificationConfig,
  NotificationListResponse,
  NotificationPreferences,
  NotificationPreferencesPatch,
  NotificationReadTarget,
  NotificationSummary,
  PushTargetInput,
} from "@cohub/protocol";
import type { HttpTransport } from "../transport.js";

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export class NotificationsApi {
  constructor(private readonly transport: HttpTransport) {}

  list(options: { category?: NotificationCategory | null; cursor?: string | null; limit?: number } = {}) {
    const params = new URLSearchParams();
    if (options.category) params.set("category", options.category);
    if (options.cursor) params.set("cursor", options.cursor);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    const query = params.toString();
    return this.transport.request<NotificationListResponse>(`/api/me/notifications${query ? `?${query}` : ""}`);
  }

  summary() {
    return this.transport.request<NotificationSummary>("/api/me/notifications/summary");
  }

  markRead(target: NotificationReadTarget) {
    return this.transport.request<{ changed: number; summary: NotificationSummary }>("/api/me/notifications/read", json("POST", target));
  }

  preferences() {
    return this.transport.request<NotificationPreferences>("/api/me/notification-preferences");
  }

  updatePreferences(patch: NotificationPreferencesPatch) {
    return this.transport.request<NotificationPreferences>("/api/me/notification-preferences", json("PATCH", patch));
  }

  registerPushTarget(target: PushTargetInput) {
    return this.transport.request<{ ok: true }>("/api/me/push-targets", json("PUT", target));
  }

  unregisterPushTarget(deviceId: string) {
    return this.transport.request<{ ok: true }>(`/api/me/push-targets/${encodeURIComponent(deviceId)}`, { method: "DELETE" });
  }

  setLocale(locale: string) {
    return this.transport.request<{ ok: true }>("/api/me/locale", json("PUT", { locale }));
  }

  config() {
    return this.transport.request<NotificationConfig>("/api/notifications/config");
  }

  unsubscribe(token: string) {
    return this.transport.request<{ ok: true }>("/api/notifications/unsubscribe", json("POST", { token }));
  }
}
