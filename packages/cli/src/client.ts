import { CohubClient, CohubHttpClient, readRequestSourceFromEnv, type CohubClientOptions } from "@neta-art/cohub";
import { clearAuthSession, readAuthSession, resolveAccessToken } from "./auth.js";

const clientOptions = () => ({
  getAccessToken: resolveAccessToken,
  onUnauthorized: (context: Parameters<NonNullable<CohubClientOptions["onUnauthorized"]>>[0]) => {
    if (!process.env.COHUB_EXECUTION_TOKEN?.trim() && context.matchesRejectedToken(readAuthSession()?.accessToken ?? null)) clearAuthSession();
  },
  requestSource: () =>
    readRequestSourceFromEnv(process.env as Record<string, string | undefined>, { via: "cli" }) ?? {
      via: "cli" as const,
    },
});

export function createClient(): CohubHttpClient {
  return new CohubHttpClient(clientOptions());
}

export function createClientWithAccessToken(token: string): CohubHttpClient {
  return new CohubHttpClient({ ...clientOptions(), getAccessToken: () => token });
}

export function createRealtimeClient(): CohubClient {
  return new CohubClient(clientOptions());
}
