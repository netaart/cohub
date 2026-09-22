import { resolveCohubEnvironment, type CohubEnvironment } from "@neta-art/cohub";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { withRuntimeSpaceBindingsLock } from "./runtime/space-binding.js";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const CONFIG_DIR = join(homedir(), ".config", "cohub");
const EXPIRY_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_SCOPE = "openid profile email offline_access";
const DEFAULT_RESOURCE = "https://api.talesofai";

export type AuthSource = "execution-token" | "logto" | null;

type AuthConfig = {
  issuer: string;
  clientId: string;
  resource: string;
  scope: string;
};

type DeviceCode = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresAt: number;
  interval: number;
  createdAt: number;
};

type AuthSession = {
  schemaVersion: 1;
  env: CohubEnvironment;
  issuer: string;
  clientId: string;
  resource: string;
  scope: string;
  tokenType: "Bearer";
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  accessTokenExpiresAt: number;
  createdAt: number;
  updatedAt: number;
};

type LogtoTokenResponse = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
};

export class AuthRequiredError extends Error {
  constructor(message = "Not authenticated") {
    super(message);
    this.name = "AuthRequiredError";
  }
}

const currentEnv = () => resolveCohubEnvironment();
const normalizeUrl = (url: string) => url.trim().replace(/\/+$/, "");

const authConfig = (env = currentEnv()): AuthConfig => {
  const prefix = env === "dev" ? "COHUB_DEV" : "COHUB";
  const defaultIssuer = env === "dev" ? "https://dev-auth.neta.art" : "https://auth.neta.art";
  const defaultClientId = env === "dev" ? "u2fnfgvf8f16dnt8si2bv" : "f8d26cdlwx85b0e5l3om2";

  return {
    issuer: normalizeUrl(process.env[`${prefix}_AUTH_ISSUER`] ?? process.env.COHUB_AUTH_ISSUER ?? defaultIssuer),
    clientId: process.env[`${prefix}_AUTH_CLIENT_ID`] ?? process.env.COHUB_AUTH_CLIENT_ID ?? defaultClientId,
    resource: process.env[`${prefix}_AUTH_RESOURCE`] ?? process.env.COHUB_AUTH_RESOURCE ?? DEFAULT_RESOURCE,
    scope: process.env[`${prefix}_AUTH_SCOPE`] ?? process.env.COHUB_AUTH_SCOPE ?? DEFAULT_SCOPE,
  };
};

const sessionPath = (env = currentEnv()) => join(CONFIG_DIR, env === "dev" ? "auth.dev.json" : "auth.json");
const deviceCodePath = (env = currentEnv()) => join(CONFIG_DIR, env === "dev" ? "device-code.dev.json" : "device-code.json");
const legacyTokenPath = (env = currentEnv()) => join(CONFIG_DIR, env === "dev" ? "token.dev" : "token");

const writePrivateJson = (path: string, value: unknown) => {
  mkdirSync(CONFIG_DIR, { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf-8", mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally { rmSync(temporary, { force: true }); }
};

const readJson = <T>(path: string): T | null => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return null;
  }
};

const removeIfExists = (path: string) => {
  if (existsSync(path)) rmSync(path);
};

const tokenEndpoint = (issuer: string) => `${issuer}/oidc/token`;
const deviceEndpoint = (issuer: string) => `${issuer}/oidc/device/auth`;
const revocationEndpoint = (issuer: string) => `${issuer}/oidc/token/revocation`;

const formPost = async (url: string, body: URLSearchParams) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const contentType = response.headers.get("content-type") ?? "";
  const data = contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => null);
  return { response, data };
};

const toNonEmptyString = (value: unknown, field: string) => {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Invalid auth response: missing ${field}`);
  return value;
};

const toPositiveNumber = (value: unknown, field: string) => {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Invalid auth response: invalid ${field}`);
  return number;
};

const authErrorCode = (data: unknown) => {
  if (typeof data !== "object" || data === null) return null;
  const error = (data as Record<string, unknown>).error;
  return typeof error === "string" ? error : null;
};

const isUnrecoverableRefreshError = (data: unknown) => {
  const code = authErrorCode(data);
  return code === "invalid_grant" || code === "invalid_token";
};

const toSession = (token: LogtoTokenResponse, config: AuthConfig, env: CohubEnvironment, previous?: AuthSession): AuthSession => {
  const accessToken = toNonEmptyString(token.access_token, "access_token");
  const expiresIn = toPositiveNumber(token.expires_in, "expires_in");
  if (token.token_type !== "Bearer") throw new Error(`Unsupported token type: ${token.token_type}`);
  if (token.refresh_token !== undefined && !token.refresh_token.trim()) throw new Error("Invalid auth response: invalid refresh_token");
  if (!token.refresh_token && !previous?.refreshToken) throw new Error("Logto did not return a refresh token");
  const now = Date.now();
  return {
    schemaVersion: 1,
    env,
    issuer: config.issuer,
    clientId: config.clientId,
    resource: config.resource,
    scope: token.scope ?? config.scope,
    tokenType: "Bearer",
    accessToken,
    refreshToken: token.refresh_token ?? previous?.refreshToken ?? "",
    idToken: token.id_token ?? previous?.idToken,
    accessTokenExpiresAt: now + expiresIn * 1000,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
};

export const readAuthSession = () => readJson<AuthSession>(sessionPath());

const clearDeviceCode = () => {
  removeIfExists(deviceCodePath());
};

export const clearAuthSession = () => {
  removeIfExists(sessionPath());
  clearDeviceCode();
  removeIfExists(legacyTokenPath());
};

export const authSource = (): AuthSource => {
  if (process.env.COHUB_EXECUTION_TOKEN?.trim()) return "execution-token";
  if (readAuthSession()) return "logto";
  return null;
};

export async function resolveAccessToken(options?: { forceRefresh?: boolean }): Promise<string | null> {
  const executionToken = process.env.COHUB_EXECUTION_TOKEN?.trim();
  if (executionToken) return executionToken;

  const session = readAuthSession();
  if (!session) throw new AuthRequiredError();
  if (!options?.forceRefresh && session.accessTokenExpiresAt - Date.now() > EXPIRY_SKEW_MS) return session.accessToken;
  return refreshAccessToken(session);
}

export async function requireAccessToken(): Promise<string> {
  const token = await resolveAccessToken();
  if (!token) throw new AuthRequiredError();
  return token;
}

let refreshInFlight: Promise<string | null> | null = null;

export function refreshAccessToken(session = readAuthSession()): Promise<string | null> {
  if (!session?.refreshToken) return Promise.reject(new AuthRequiredError());
  if (refreshInFlight) return refreshInFlight;
  const path = sessionPath(session.env);
  refreshInFlight = withRuntimeSpaceBindingsLock(async () => {
    const current = readJson<AuthSession>(path);
    if (!current) throw new AuthRequiredError();
    // Another process may already have rotated this refresh token.
    if (current.refreshToken !== session.refreshToken || current.updatedAt !== session.updatedAt) return current.accessToken;
    return performRefresh(current);
  }, { path, lockPath: `${path}.refresh.lock` }).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function performRefresh(session: AuthSession): Promise<string | null> {
  const config = authConfig(session.env);
  const { response, data } = await formPost(tokenEndpoint(session.issuer), new URLSearchParams({
    client_id: session.clientId,
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    scope: session.scope,
    resource: session.resource,
  }));

  if (!response.ok) {
    if (isUnrecoverableRefreshError(data)) {
      if (readJson<AuthSession>(sessionPath(session.env))?.refreshToken === session.refreshToken) clearAuthSession();
      return null;
    }
    throw new Error(formatAuthError(data, response.status));
  }

  const next = toSession(data as LogtoTokenResponse, config, session.env, session);
  // Never overwrite a login/logout that completed while the request was in flight.
  const current = readJson<AuthSession>(sessionPath(session.env));
  if (!current) throw new AuthRequiredError();
  if (current.refreshToken !== session.refreshToken) return current.accessToken;
  writePrivateJson(sessionPath(session.env), next);
  return next.accessToken;
}

export async function requestDeviceCode(): Promise<DeviceCode> {
  const env = currentEnv();
  const config = authConfig(env);
  const { response, data } = await formPost(deviceEndpoint(config.issuer), new URLSearchParams({
    client_id: config.clientId,
    scope: config.scope,
    resource: config.resource,
  }));
  if (!response.ok || typeof data !== "object" || data === null) {
    throw new Error(typeof data === "string" ? data : `Failed to request device code: HTTP ${response.status}`);
  }
  const body = data as Record<string, unknown>;
  const now = Date.now();
  const expiresIn = toPositiveNumber(body.expires_in, "expires_in");
  const interval = body.interval === undefined ? 5 : toPositiveNumber(body.interval, "interval");
  const verificationUri = toNonEmptyString(body.verification_uri, "verification_uri");
  const deviceCode: DeviceCode = {
    deviceCode: toNonEmptyString(body.device_code, "device_code"),
    userCode: toNonEmptyString(body.user_code, "user_code"),
    verificationUri,
    verificationUriComplete: body.verification_uri_complete === undefined
      ? verificationUri
      : toNonEmptyString(body.verification_uri_complete, "verification_uri_complete"),
    expiresAt: now + expiresIn * 1000,
    interval,
    createdAt: now,
  };
  writePrivateJson(deviceCodePath(env), deviceCode);
  return deviceCode;
}

export async function verifyDeviceCode(): Promise<AuthSession> {
  const env = currentEnv();
  const config = authConfig(env);
  const deviceCode = readJson<DeviceCode>(deviceCodePath(env));
  if (!deviceCode) throw new Error("Device code not found. Run `cohub auth login --request-code` first.");
  if (deviceCode.expiresAt <= Date.now()) throw new Error("Device code expired. Run `cohub auth login` again.");

  const { response, data } = await formPost(tokenEndpoint(config.issuer), new URLSearchParams({
    client_id: config.clientId,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: deviceCode.deviceCode,
    resource: config.resource,
  }));
  if (!response.ok) throw new Error(formatAuthError(data, response.status));

  const session = toSession(data as LogtoTokenResponse, config, env);
  writePrivateJson(sessionPath(env), session);
  removeIfExists(deviceCodePath(env));
  return session;
}

export async function loginWithDeviceFlow(onCode: (code: DeviceCode) => void, onPoll?: () => void): Promise<AuthSession> {
  const code = await requestDeviceCode();
  onCode(code);
  while (Date.now() < code.expiresAt) {
    await delay(code.interval * 1000);
    onPoll?.();
    try {
      return await verifyDeviceCode();
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      if (message.includes("authorization_pending")) continue;
      if (message.includes("slow_down")) {
        await delay(code.interval * 1000);
        continue;
      }
      throw e;
    }
  }
  throw new Error("Login timed out. Run `cohub auth login` again.");
}

export async function revokeAndClearAuthSession(): Promise<void> {
  const session = readAuthSession();
  if (session?.refreshToken) {
    await formPost(revocationEndpoint(session.issuer), new URLSearchParams({
      client_id: session.clientId,
      token: session.refreshToken,
      token_type_hint: "refresh_token",
    })).catch(() => null);
  }
  clearAuthSession();
}

function formatAuthError(data: unknown, status: number): string {
  if (typeof data === "object" && data !== null) {
    const record = data as Record<string, unknown>;
    const code = String(record.error ?? "");
    const description = String(record.error_description ?? "");
    return [code, description].filter(Boolean).join(": ") || `Authentication failed: HTTP ${status}`;
  }
  return typeof data === "string" && data ? data : `Authentication failed: HTTP ${status}`;
}
