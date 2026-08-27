import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

if (Platform.OS !== "web") {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: true,
    }),
  });
}

export type PushRegistration = {
  token: string;
  platform: "ios" | "android";
};

export async function registerForPushNotifications(): Promise<PushRegistration | null> {
  if (Platform.OS === "web" || !Device.isDevice) return null;

  const current = await Notifications.getPermissionsAsync();
  let status = current.status;
  if (status !== "granted") {
    const requested = await Notifications.requestPermissionsAsync();
    status = requested.status;
  }
  if (status !== "granted") return null;

  const token = await Notifications.getDevicePushTokenAsync();
  return {
    token: token.data,
    platform: Platform.OS === "ios" ? "ios" : "android",
  };
}

export async function getInitialNotificationUrl() {
  const response = await Notifications.getLastNotificationResponseAsync();
  const data = response?.notification.request.content.data;
  return typeof data?.deepLink === "string" ? data.deepLink : null;
}
