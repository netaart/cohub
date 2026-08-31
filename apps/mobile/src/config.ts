import Constants from "expo-constants";
import * as ExpoLinking from "expo-linking";

type ExpoExtra = {
  apiOrigin?: string;
  gatewayOrigin?: string;
  authEndpoint?: string;
  logtoAppId?: string;
  apiResource?: string;
  environment?: "prod" | "dev";
};

const extra = (Constants.expoConfig?.extra ?? {}) as ExpoExtra;

const readPublic = (value: string | undefined, fallback: string) =>
  value?.trim() || fallback;

const environment =
  (process.env.EXPO_PUBLIC_COHUB_ENV?.trim() as "prod" | "dev" | undefined) ??
  extra.environment ??
  "prod";

const defaults =
  environment === "dev"
    ? {
        apiOrigin: "https://api-dev.cohub.live",
        gatewayOrigin: "wss://gateway-dev.cohub.live/ws",
        authEndpoint: "https://dev-auth.neta.art/",
        logtoAppId: "vpikk7sl9zwvefiptowtn",
      }
    : {
        apiOrigin: "https://api.cohub.live",
        gatewayOrigin: "wss://gateway.cohub.live/ws",
        authEndpoint: "https://auth.neta.art/",
        logtoAppId: "16ai0wao2mud3xqkbzqo0",
      };

export const config = {
  environment,
  updateApiUrl: "https://api.github.com/repos/markbang/cohub-mobile/releases/latest",
  apiOrigin: readPublic(process.env.EXPO_PUBLIC_API_ORIGIN, extra.apiOrigin ?? defaults.apiOrigin),
  gatewayOrigin: readPublic(
    process.env.EXPO_PUBLIC_GATEWAY_ORIGIN,
    extra.gatewayOrigin ?? defaults.gatewayOrigin,
  ),
  authEndpoint: readPublic(
    process.env.EXPO_PUBLIC_AUTH_ENDPOINT,
    extra.authEndpoint ?? defaults.authEndpoint,
  ),
  logtoAppId: readPublic(
    process.env.EXPO_PUBLIC_LOGTO_APP_ID,
    extra.logtoAppId ?? defaults.logtoAppId,
  ),
  apiResource: readPublic(
    process.env.EXPO_PUBLIC_API_RESOURCE,
    extra.apiResource ?? "https://api.talesofai",
  ),
  redirectUri: ExpoLinking.createURL("callback"),
  appScheme: "cohub",
} as const;

export const buildSessionDeepLink = (sessionId: string, turn?: number | null) => {
  const query = turn ? `?turn=${encodeURIComponent(String(turn))}` : "";
  return `cohub://chat/${encodeURIComponent(sessionId)}${query}`;
};

export const buildSpaceDeepLink = (spaceId: string) =>
  `cohub://space/${encodeURIComponent(spaceId)}`;
