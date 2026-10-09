import { config } from "@/src/config";

/**
 * The Logto native flow returns to the configured redirect URI (for example
 * `cohub://callback?code=…`), which is not an app route. Ignore that URL so Expo
 * Router keeps the root route after sign-in instead of landing on not-found.
 */
export function redirectSystemPath({ path }: { path: string | null; initial: boolean }) {
  if (!path) return path;
  const { redirectUri } = config;
  const isAuthCallback =
    path === redirectUri || path.startsWith(`${redirectUri}?`) || path.startsWith(`${redirectUri}#`);
  return isAuthCallback ? null : path;
}
