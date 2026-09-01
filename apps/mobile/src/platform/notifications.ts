import { isRunningInExpoGo } from "expo";
import * as Device from "expo-device";
import { Platform } from "react-native";
import { config } from "@/src/config";
import { getInstalledAppVersion } from "@/src/platform/app-updates";

type NotificationsModule = typeof import("expo-notifications");
type NotificationRecord = Record<string, unknown>;

type PushUnavailableReason =
  | "web"
  | "expo-go"
  | "simulator"
  | "permission-denied"
  | "missing-installation"
  | "missing-auth"
  | "native-token-unavailable"
  | "server-unavailable"
  | "module-unavailable";

export type PushRegistrationResult =
  | {
      status: "enabled";
      token: string;
      platform: "ios" | "android";
      message: string;
    }
  | {
      status: "unavailable";
      reason: PushUnavailableReason;
      message: string;
    };

type PushRegistrationOptions = {
  installationId: string | null;
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
};

let notificationsModulePromise: Promise<NotificationsModule | null> | null = null;
let notificationHandlerConfigured = false;

function isRecord(value: unknown): value is NotificationRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notificationDeepLink(response: unknown): string | null {
  if (!isRecord(response) || !isRecord(response.notification)) return null;
  const request = response.notification.request;
  if (!isRecord(request) || !isRecord(request.content)) return null;
  const data = request.content.data;
  if (!isRecord(data)) return null;
  if (typeof data.deepLink === "string" && data.deepLink.trim()) return data.deepLink;
  if (typeof data.sessionId === "string" && data.sessionId.trim()) {
    const turnId = typeof data.turnId === "string" && data.turnId.trim() ? data.turnId.trim() : null;
    const turn = typeof data.turn === "string" && data.turn.trim() ? data.turn.trim() : null;
    const query = turnId ? `?turnId=${encodeURIComponent(turnId)}` : turn ? `?turn=${encodeURIComponent(turn)}` : "";
    return `cohub://chat/${encodeURIComponent(data.sessionId.trim())}${query}`;
  }
  return null;
}

async function loadNotifications(): Promise<NotificationsModule | null> {
  if (Platform.OS === "web" || isRunningInExpoGo()) return null;
  if (notificationsModulePromise) return notificationsModulePromise;

  notificationsModulePromise = import("expo-notifications")
    .then((module) => {
      if (!notificationHandlerConfigured) {
        module.setNotificationHandler({
          handleNotification: async () => ({
            shouldShowBanner: true,
            shouldShowList: true,
            shouldPlaySound: false,
            shouldSetBadge: true,
          }),
        });
        notificationHandlerConfigured = true;
      }
      return module;
    })
    .catch((error) => {
      notificationsModulePromise = null;
      console.warn("[mobile-notifications] native module unavailable", error);
      return null;
    });
  return notificationsModulePromise;
}

function unavailable(reason: PushUnavailableReason, message: string): PushRegistrationResult {
  return { status: "unavailable", reason, message };
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readErrorMessage(response: Response) {
  const body = await response.text().catch(() => "");
  const trimmed = body.replace(/\s+/g, " ").trim();
  return trimmed.slice(0, 240);
}

export async function registerForPushNotifications(options: PushRegistrationOptions): Promise<PushRegistrationResult> {
  if (Platform.OS === "web") return unavailable("web", "Push notifications are not available in the web preview.");
  if (isRunningInExpoGo()) return unavailable("expo-go", "Expo Go cannot issue remote push tokens on Android. Install a formal Cohub build.");
  if (!Device.isDevice) return unavailable("simulator", "Push notifications require a physical device.");
  if (!options.installationId?.trim()) return unavailable("missing-installation", "The device installation identity is not ready. Restart Cohub and try again.");

  const Notifications = await loadNotifications();
  if (!Notifications) return unavailable("module-unavailable", "The native notification module is not available in this build.");

  const current = await Notifications.getPermissionsAsync();
  let status = current.status;
  if (status !== "granted") {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== "granted") return unavailable("permission-denied", "Notification permission is denied. Enable notifications for Cohub in system settings.");

  let token: string;
  try {
    const nativeToken = await Notifications.getDevicePushTokenAsync();
    token = typeof nativeToken.data === "string" ? nativeToken.data.trim() : "";
  } catch (error) {
    console.warn("[mobile-notifications] device token registration failed", error);
    return unavailable(
      "native-token-unavailable",
      Platform.OS === "android"
        ? "Android push needs Firebase configuration in the installed build (google-services.json). Rebuild Cohub after adding it."
        : "APNs could not issue a device token for this build. Check the signing and notification entitlements.",
    );
  }
  if (!token) return unavailable("native-token-unavailable", "The operating system returned an empty push token.");

  let accessToken: string | null;
  try {
    accessToken = await options.getAccessToken();
  } catch (error) {
    console.warn("[mobile-notifications] access token unavailable", error);
    return unavailable("missing-auth", "Your Cohub sign-in token is unavailable. Sign in again and retry.");
  }
  if (!accessToken) return unavailable("missing-auth", "Your Cohub sign-in token is unavailable. Sign in again and retry.");

  try {
    const response = await fetchWithTimeout(`${config.apiOrigin}/api/me/devices`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Cohub-Source-Via": "mobile",
        "X-Cohub-Source-Client": options.installationId,
      },
      body: JSON.stringify({
        installationId: options.installationId,
        platform: Platform.OS === "ios" ? "ios" : "android",
        token,
        appVersion: getInstalledAppVersion(),
      }),
    });
    if (!response.ok) {
      const detail = await readErrorMessage(response);
      if (response.status === 404) return unavailable("server-unavailable", "Cohub API does not have mobile device registration enabled yet.");
      return unavailable("server-unavailable", detail ? `Cohub could not register this device (${response.status}): ${detail}` : `Cohub could not register this device (HTTP ${response.status}).`);
    }
  } catch (error) {
    return unavailable("server-unavailable", error instanceof Error ? `Cohub device registration failed: ${error.message}` : "Cohub device registration failed.");
  }

  return {
    status: "enabled",
    token,
    platform: Platform.OS === "ios" ? "ios" : "android",
    message: "This device is registered for Agent completion notifications.",
  };
}

export async function getInitialNotificationUrl() {
  const Notifications = await loadNotifications();
  if (!Notifications) return null;
  return notificationDeepLink(await Notifications.getLastNotificationResponseAsync());
}

export async function subscribeToNotificationResponses(onDeepLink: (url: string) => void) {
  const Notifications = await loadNotifications();
  if (!Notifications) return () => undefined;
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const url = notificationDeepLink(response);
    if (url) onDeepLink(url);
  });
  return () => subscription.remove();
}
