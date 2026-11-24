import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { normalizeAppPublisherScopes, normalizePermissionScopes, scopeListHasPermission, type Permission } from "@cohub/core/permissions";

/**
 * App session tokens carry identity, publisher scopes, and a TTL — nothing
 * else. Viewer grants live in `app_viewer_grants` (keyed by app + viewer +
 * space) and are resolved from the DB on every request, so consent state never
 * bloats the token and revocation takes effect immediately.
 */
export type AppSessionPayload = {
  typ: "app_session";
  userUuid: string;
  appId: string;
  /** App home space — the only space `appScopes` apply to. */
  spaceId: string;
  /** Publisher-granted scopes for the app home space. */
  appScopes: Permission[];
  /** @deprecated Legacy Work clients read the publisher scopes under this name. */
  workScopes: Permission[];
  /**
   * Scopes consented by the authorize call that minted this token. Display
   * only — the grant rows stay the source of truth.
   * @deprecated Inspect grants via `GET /api/apps/:id/grants` instead.
   */
  viewerScopes: Permission[];
  scopes: Permission[];
  /** @deprecated Legacy single-grant id; grants are resolved server-side now. */
  appViewerGrantId?: string;
  /** Set on storefront tokens; they die with the account's storefront sign-ins. */
  browserEpoch?: string;
  iat: number;
  exp: number;
};

export type AppSessionPrincipal = AppSessionPayload & { type: "app_session" };

const base64url = (input: Buffer | string) => Buffer.from(input).toString("base64url");
const fromBase64urlJson = <T>(value: string): T => JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;

const signWithHmacSha256 = (input: string, secret: string) => createHmac("sha256", secret).update(input).digest();

const signingSecret = () => {
  if (!config.appEncryptionKey) throw new Error("Missing APP_ENCRYPTION_KEY for app session tokens");
  return config.appEncryptionKey;
};

export const APP_SESSION_TTL_SECONDS = 60 * 60;

/** Viewer grants outlive tokens: consent lasts 14 days, tokens 1 hour. */
export const APP_VIEWER_GRANT_TTL_SECONDS = 14 * 24 * 60 * 60;

export function createAppSessionToken(input: {
  userUuid: string;
  appId: string;
  spaceId: string;
  appScopes: Permission[];
  /** Display-only snapshot of the scopes consented by this mint's authorize call. */
  viewerScopes?: Permission[];
  ttlSeconds?: number;
  browserEpoch?: string;
  /** Injectable for tests; production uses the configured APP_ENCRYPTION_KEY. */
  secret?: string;
}) {
  const now = Math.floor(Date.now() / 1000);
  const appScopes = normalizeAppPublisherScopes(input.appScopes);
  const viewerScopes = normalizePermissionScopes(input.viewerScopes ?? []);
  const payload: AppSessionPayload = {
    typ: "app_session",
    userUuid: input.userUuid,
    appId: input.appId,
    spaceId: input.spaceId,
    appScopes,
    // Keep the old claim name for published Work clients that inspect JWTs.
    workScopes: appScopes,
    viewerScopes,
    scopes: normalizePermissionScopes([...appScopes, ...viewerScopes]),
    ...(input.browserEpoch === undefined ? {} : { browserEpoch: input.browserEpoch }),
    iat: now,
    exp: now + (input.ttlSeconds ?? APP_SESSION_TTL_SECONDS),
  };
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = base64url(signWithHmacSha256(signingInput, input.secret ?? signingSecret()));
  return `${signingInput}.${signature}`;
}

export function verifyAppSessionToken(token: string, secret?: string): AppSessionPrincipal | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const signingInput = `${headerPart}.${payloadPart}`;
  const expected = signWithHmacSha256(signingInput, secret ?? signingSecret());
  const actual = Buffer.from(signaturePart, "base64url");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  let payload: AppSessionPayload;
  try {
    payload = fromBase64urlJson<AppSessionPayload>(payloadPart);
  } catch {
    return null;
  }
  if (payload.typ !== "app_session") return null;
  if (!payload.userUuid || !payload.appId || !payload.spaceId) return null;
  if (!Array.isArray(payload.scopes) || !Array.isArray(payload.appScopes) || !Array.isArray(payload.viewerScopes)) return null;
  if (payload.exp * 1000 <= Date.now()) return null;
  const appScopes = normalizeAppPublisherScopes(payload.appScopes);
  const viewerScopes = normalizePermissionScopes(payload.viewerScopes);
  return {
    ...payload,
    scopes: normalizePermissionScopes([...appScopes, ...viewerScopes]),
    appScopes,
    workScopes: appScopes,
    viewerScopes,
    type: "app_session",
  };
}

export const hasAppSessionPermission = (principal: AppSessionPrincipal, permission: Permission, spaceId: string) => {
  if (principal.spaceId !== spaceId) return false;
  return scopeListHasPermission(normalizePermissionScopes(principal.scopes), permission);
};
