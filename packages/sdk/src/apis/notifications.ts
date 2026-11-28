import type { NotificationConfig, NotificationPreferences, NotificationPreferencesPatch, PushTargetInput } from "@cohub/protocol";
import type { HttpTransport } from "../transport.js";

const json = (method: string, body: unknown) => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export class NotificationsApi {
  constructor(private readonly transport: HttpTransport) {}

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
