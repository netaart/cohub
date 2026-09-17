import {
  createCohubClient,
  type CohubClient,
  type RequestSource,
  type UnauthorizedContext,
} from "@neta-art/cohub";
import { config } from "@/src/config";

export type MobileAuthHandlers = {
  /** Lets the SDK discard 401s raised against an auth session the app has already replaced. */
  getAuthSessionVersion?: () => string | number | null;
  /** Every request retried after a 401 also failed, so the stored credential is unusable. */
  onUnauthorized?: (context: UnauthorizedContext) => Promise<void> | void;
};

export function createMobileClient(
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>,
  installationId: string,
  auth: MobileAuthHandlers = {},
): CohubClient {
  const requestSource: RequestSource = {
    via: "mobile",
    clientId: installationId,
  };

  return createCohubClient({
    baseUrl: config.apiOrigin,
    getAccessToken,
    getAuthSessionVersion: auth.getAuthSessionVersion,
    onUnauthorized: auth.onUnauthorized,
    requestSource,
    websocket: {
      url: config.gatewayOrigin,
      getAccessToken,
    },
  });
}
