import * as ExpoLinking from "expo-linking";
import * as Notifications from "expo-notifications";
import { useRouter } from "expo-router";
import { useCallback, useEffect } from "react";
import { Platform } from "react-native";
import { getInitialNotificationUrl } from "@/src/platform/notifications";

function routeFromUrl(rawUrl: string) {
  try {
    const parsed = new URL(rawUrl);
    const parts = [parsed.hostname, ...parsed.pathname.split("/")]
      .map((part) => decodeURIComponent(part))
      .filter(Boolean);
    if (parsed.protocol === "https:" && parsed.hostname === "cohub.live") {
      return { parts: parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent), parsed };
    }
    return { parts, parsed };
  } catch {
    return null;
  }
}

export function NativeInteractionBridge() {
  const router = useRouter();

  const openUrl = useCallback((rawUrl: string | null | undefined) => {
    if (!rawUrl) return;
    const result = routeFromUrl(rawUrl);
    if (!result) return;
    const [resource, id] = result.parts;
    if (!id || resource === "callback") return;
    if (resource === "chat") {
      const turn = result.parsed.searchParams.get("turn");
      router.push({
        pathname: "/chat/[sessionId]",
        params: { sessionId: id, ...(turn ? { turn } : {}) },
      });
      return;
    }
    if (resource === "space") {
      router.push({ pathname: "/space/[spaceId]", params: { spaceId: id } });
    }
  }, [router]);

  useEffect(() => {
    if (Platform.OS === "web") return;
    const linkingSubscription = ExpoLinking.addEventListener("url", ({ url }) => openUrl(url));
    const notificationSubscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data as Record<string, unknown> | undefined;
      if (typeof data?.deepLink === "string") {
        openUrl(data.deepLink);
        return;
      }
      if (typeof data?.sessionId === "string") {
        openUrl(`cohub://chat/${encodeURIComponent(data.sessionId)}`);
      }
    });

    void ExpoLinking.getInitialURL().then(openUrl);
    void getInitialNotificationUrl().then(openUrl);
    return () => {
      linkingSubscription.remove();
      notificationSubscription.remove();
    };
  }, [openUrl]);

  return null;
}
