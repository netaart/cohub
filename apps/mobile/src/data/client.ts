import {
  createCohubClient,
  type CohubClient,
  type RequestSource,
} from "@neta-art/cohub";
import { config } from "@/src/config";

export function createMobileClient(
  getAccessToken: (options?: { forceRefresh?: boolean }) => Promise<string | null>,
  installationId: string,
): CohubClient {
  const requestSource: RequestSource = {
    via: "mobile",
    clientId: installationId,
  };

  return createCohubClient({
    baseUrl: config.apiOrigin,
    getAccessToken,
    requestSource,
    websocket: {
      url: config.gatewayOrigin,
      getAccessToken,
    },
  });
}
