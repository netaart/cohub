import { APP_BROWSER_SESSION_HINT, APP_BROWSER_SESSION_PATH, appReturnPath } from "@cohub/protocol";

function endpoint(appId: string, action: string) {
  return `${APP_BROWSER_SESSION_PATH}/${action}?app=${encodeURIComponent(appId)}`;
}

export function browserSessionHint() {
  if (typeof document === "undefined") return null;
  try {
    const prefix = APP_BROWSER_SESSION_HINT + "=";
    return document.cookie?.split(";").map((pair) => pair.trim()).find((pair) => pair.startsWith(prefix))?.slice(prefix.length) ?? null;
  } catch {
    return null;
  }
}

export async function startAppBrowserSignIn(appId: string, brokerOrigin: string, returnTo?: string) {
  const origin = window.location.origin;
  const path = appReturnPath(returnTo ?? window.location.href, origin);
  if (!path) throw new Error("Sign-in must return to a page on this App's origin.");
  const response = await fetch(endpoint(appId, "start"), { method: "POST", credentials: "same-origin", redirect: "error" });
  if (!response.ok) throw new Error("Full-page sign-in is unavailable on this App origin.");
  const { challenge } = await response.json() as { challenge?: string };
  if (!challenge || !/^[\w-]{43}$/.test(challenge)) throw new Error("Invalid App sign-in challenge.");
  const url = new URL("/app-auth", brokerOrigin);
  url.search = new URLSearchParams({ app: appId, origin, mode: "redirect", challenge, returnTo: path }).toString();
  window.location.assign(url.href);
}

export async function restoreAppBrowserSession(appId: string) {
  const response = await fetch(endpoint(appId, "token"), { method: "POST", credentials: "same-origin", cache: "no-store", redirect: "error" });
  if (response.status === 204) return null;
  if (!response.ok) throw new Error("Unable to restore the App session.");
  const result = await response.json() as { token: string; viewer: { userUuid: string } };
  if (!result.token || !result.viewer?.userUuid) throw new Error("Invalid App session.");
  return result;
}

export async function endAppBrowserSession(appId: string) {
  const response = await fetch(endpoint(appId, "logout"), { method: "POST", credentials: "same-origin", redirect: "error" });
  if (!response.ok) throw new Error("Unable to sign out of this App.");
}
