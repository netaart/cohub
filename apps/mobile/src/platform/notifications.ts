import { isRunningInExpoGo } from "expo";
import * as Device from "expo-device";
import { Platform } from "react-native";

type NotificationsModule = typeof import("expo-notifications");

type NotificationRecord = Record<string, unknown>;

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
    return `cohub://chat/${encodeURIComponent(data.sessionId.trim())}`;
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
      throw error;
    });
  return notificationsModulePromise;
}

export type PushRegistration = {
  token: string;
  platform: "ios" | "android";
};

export async function registerForPushNotifications(): Promise<PushRegistration | null> {
  if (Platform.OS === "web" || !Device.isDevice || isRunningInExpoGo()) return null;
  const Notifications = await loadNotifications();
  if (!Notifications) return null;

  const current = await Notifications.getPermissionsAsync();
  let status = current.status;
  if (status !== "granted") {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== "granted") return null;

  try {
    const token = await Notifications.getDevicePushTokenAsync();
    return {
      token: token.data,
      platform: Platform.OS === "ios" ? "ios" : "android",
    };
  } catch (error) {
    // Android needs a Firebase config file for native device-token registration.
    console.warn("[mobile-notifications] device token registration failed", error);
    return null;
  }
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
