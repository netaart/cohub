import type { RequestSource } from "@cohub/protocol/provenance";
import { requestSourceToHeaders } from "@cohub/protocol/provenance";
import type { CohubEnvironment } from "./environment.js";
import { resolveApiBaseUrl } from "./environment.js";
import { readRevalidationEntry, revalidationEnabled, writeRevalidationEntry } from "./revalidation-cache.js";
import type { WebsocketClientOptions } from "./websocket.js";
import type { VoiceInputCreateOptions } from "./voice-input.js";
import type { AppRuntimeModeConfig } from "./app-runtime.js";

export type Fetch = typeof globalThis.fetch;

type RequestInitWithFetch = RequestInit & {
  fetch?: Fetch;
  /** When true, 401 responses throw without invoking onUnauthorized (e.g. session bootstrap). */
  skipUnauthorizedHandler?: boolean;
};

const responseBodyForError = async (response: Response) => {
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json")
    ? await response.json().catch(() => null)
    : await response.text().catch(() => response.statusText);
};

const isFailure = (response: Response) => !response.ok && response.status !== 304;

const messageFromErrorBody = (body: unknown, fallback: string) => {
  if (typeof body === "string") return body.trim() || fallback;
  if (body && typeof body === "object") {
    const errorBody = body as { message?: unknown };
    if (typeof errorBody.message === "string" && errorBody.message.trim()) return errorBody.message;
  }
  return fallback;
};

export type RawHttpResponse = {
  response: Response;
  blob(): Promise<Blob>;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
};

export type AccessTokenRequestOptions = {
  forceRefresh?: boolean;
  /** Token used by the request that received 401. */
  rejectedToken?: string | null;
};

export type AuthSessionVersion = string | number | null;

export type HttpTraceContext = {
  requestId: string | null;
  traceId: string | null;
  spanId: string | null;
  traceparent: string | null;
};

export type UnauthorizedContext = {
  /** Compare a known candidate without exposing the rejected bearer token. */
  matchesRejectedToken(candidate: string | null | undefined): boolean;
  /** Auth state observed before the rejected request resolved its token. */
  authSessionVersion?: AuthSessionVersion;
  /** Safe identifiers returned by the final rejected API response. */
  traceContext?: HttpTraceContext;
};

export type CohubClientOptions = {
  env?: CohubEnvironment;
  baseUrl?: string;
  getAccessToken?: (options?: AccessTokenRequestOptions) => Promise<string | null> | string | null;
  getAuthSessionVersion?: () => AuthSessionVersion;
  onUnauthorized?: (context: UnauthorizedContext) => Promise<void> | void;
  setStoredAuthToken?: (token: string) => void;
  clearStoredAuthToken?: () => void;
  fetch?: Fetch;
  websocket?: WebsocketClientOptions;
  voice?: VoiceInputCreateOptions;
  /** App runtime mode configuration (bridge vs broker). */
  app?: AppRuntimeModeConfig;
  /** @deprecated Use `app`. Kept so existing runtimes keep configuring broker mode. */
  work?: AppRuntimeModeConfig;
  /** Optional X-Cohub-Source-* headers (static or per-request getter). */
  requestSource?: RequestSource | null | (() => RequestSource | null | undefined);
};

function errorCodeFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const errorBody = body as { code?: unknown };
  if (typeof errorBody.code === "string" && errorBody.code.trim()) return errorBody.code;
  return null;
}

function cleanTraceHeader(value: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\r\n\t\0]/g, "").trim();
  return cleaned ? cleaned.slice(0, 256) : null;
}

function traceContextFromResponse(response: Response): HttpTraceContext {
  return {
    requestId: cleanTraceHeader(response.headers.get("x-request-id")),
    traceId: cleanTraceHeader(response.headers.get("x-trace-id")),
    spanId: cleanTraceHeader(response.headers.get("x-span-id")),
    traceparent: cleanTraceHeader(response.headers.get("traceparent")),
  };
}

/**
 * Access tokens must be a single HTTP header token.
 * Newlines / control chars (from corrupted storage or clipboard paste) make
 * `Headers#set` throw TypeError — Safari: "The string did not match the expected pattern."
 */
export function sanitizeAccessToken(token: string | null | undefined): string | null {
  if (typeof token !== "string") return null;
  // Strip CR/LF/TAB/NUL and surrounding whitespace; keep the rest of the JWT/opaque token.
  const cleaned = token.replace(/[\r\n\t\0]/g, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Join API base + path without double slashes; prefer URL when base is absolute. */
export function joinApiUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  if (!base) return normalizedPath;
  if (/^https?:\/\//i.test(base)) {
    try {
      return new URL(normalizedPath, `${base}/`).href;
    } catch {
      // Fall through to string join for non-standard bases.
    }
  }
  return `${base}${normalizedPath}`;
}

function isBrowserRequestConstructionError(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const message = error.message || "";
  return (
    message === "The string did not match the expected pattern." ||
    /invalid header value|Failed to construct|is an invalid header/i.test(message)
  );
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;
  readonly code: string | null;
  /** The configured unauthorized callback already handled this 401. */
  readonly unauthorizedHandled: boolean;
  /** Auth state observed before the rejected request resolved its token. */
  readonly authSessionVersion?: AuthSessionVersion;
  /** Safe identifiers returned by the rejected API response. */
  readonly traceContext?: HttpTraceContext;

  constructor(
    message: string,
    status: number,
    body: unknown,
    options?: {
      unauthorizedHandled?: boolean;
      authSessionVersion?: AuthSessionVersion;
      traceContext?: HttpTraceContext;
    },
  ) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.code = errorCodeFromBody(body);
    this.unauthorizedHandled = Boolean(options?.unauthorizedHandled);
    this.authSessionVersion = options?.authSessionVersion;
    this.traceContext = options?.traceContext;
  }
}

const rejectedTokenByError = new WeakMap<HttpError, string | null>();

/**
 * Compare a known candidate with the credential rejected by a transport 401.
 * Returns undefined for HttpErrors that were not created by HttpTransport.
 */
export function matchesUnauthorizedErrorToken(
  error: unknown,
  candidate: string | null | undefined,
): boolean | undefined {
  if (!(error instanceof HttpError) || !rejectedTokenByError.has(error)) {
    return undefined;
  }
  return rejectedTokenByError.get(error) === sanitizeAccessToken(candidate);
}

export class HttpTransport {
  private readonly baseUrl: string;
  private readonly fetcher: Fetch;
  private readonly getAccessToken?: (options?: AccessTokenRequestOptions) => Promise<string | null> | string | null;
  private readonly getAuthSessionVersion?: () => AuthSessionVersion;
  private readonly onUnauthorized?: (context: UnauthorizedContext) => Promise<void> | void;
  private readonly requestSource?: RequestSource | null | (() => RequestSource | null | undefined);
  private refreshInFlight: {
    rejectedToken: string | null;
    promise: Promise<string | null>;
  } | null = null;

  constructor(options: CohubClientOptions = {}) {
    this.baseUrl = resolveApiBaseUrl(options);
    this.fetcher = options.fetch ?? fetch;
    this.getAccessToken = options.getAccessToken;
    this.getAuthSessionVersion = options.getAuthSessionVersion;
    this.onUnauthorized = options.onUnauthorized;
    this.requestSource = options.requestSource;
  }

  private resolveRequestSource(): RequestSource | null {
    if (!this.requestSource) return null;
    if (typeof this.requestSource === "function") {
      return this.requestSource() ?? null;
    }
    return this.requestSource;
  }

  private applyRequestSourceHeaders(headers: Headers): void {
    const sourceHeaders = requestSourceToHeaders(this.resolveRequestSource());
    for (const [name, value] of Object.entries(sourceHeaders)) {
      // Explicit per-request headers win over the client-level defaults.
      if (!headers.has(name)) headers.set(name, value);
    }
  }

  private readAuthSessionVersion(): AuthSessionVersion | undefined {
    try {
      return this.getAuthSessionVersion?.();
    } catch {
      // Versioning is an optional cleanup guard and must not block requests.
      return undefined;
    }
  }

  private async withAuthorization(
    init?: RequestInitWithFetch,
    tokenOverride?: string | null,
  ): Promise<{
    requestInit: RequestInit;
    token: string | null;
    authSessionVersion?: AuthSessionVersion;
  }> {
    const { fetch: _fetch, skipUnauthorizedHandler: _skip, ...requestInit } = init ?? {};
    const headers = new Headers(requestInit.headers);
    let authSessionVersion = this.readAuthSessionVersion();
    const rawToken =
      tokenOverride !== undefined
        ? tokenOverride
        : this.getAccessToken
          ? await this.getAccessToken()
          : null;
    const token = sanitizeAccessToken(rawToken);
    if (token) {
      // A token lookup may refresh the session itself. Bind a non-null bearer
      // to the resulting version; retain the starting version for null so an
      // unrelated callback cannot make an old unauthenticated request current.
      const resolvedVersion = this.readAuthSessionVersion();
      if (resolvedVersion !== undefined) authSessionVersion = resolvedVersion;
    }

    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    } else {
      headers.delete("Authorization");
    }

    this.applyRequestSourceHeaders(headers);

    return {
      requestInit: {
        ...requestInit,
        headers,
      },
      token,
      authSessionVersion,
    };
  }

  private async refreshAccessToken(rejectedToken: string | null): Promise<string | null> {
    if (!this.getAccessToken) return null;
    const inFlight = this.refreshInFlight;
    if (inFlight) {
      const resolved = await inFlight.promise;
      if (inFlight.rejectedToken === rejectedToken) return resolved;
      // A different credential was rejected while this refresh was running.
      // Re-evaluate it against the provider's current state instead of retrying
      // the request with a token resolved for another rejection.
      return this.refreshAccessToken(rejectedToken);
    }

    const getAccessToken = this.getAccessToken;
    const task = (async () => {
      try {
        const currentToken = sanitizeAccessToken(await getAccessToken());
        if (currentToken && currentToken !== rejectedToken) {
          return currentToken;
        }
      } catch {
        // Continue to the explicit refresh path.
      }

      try {
        return sanitizeAccessToken(
          await getAccessToken({ forceRefresh: true, rejectedToken }),
        );
      } catch {
        return null;
      }
    })();


    const entry = { rejectedToken, promise: task };
    this.refreshInFlight = entry;
    try {
      return await task;
    } finally {
      if (this.refreshInFlight === entry) this.refreshInFlight = null;
    }
  }

  private async send(path: string, init?: RequestInitWithFetch) {
    const fetcher = init?.fetch ?? this.fetcher;
    const url = joinApiUrl(this.baseUrl, path);
    const skipUnauthorizedHandler = Boolean(init?.skipUnauthorizedHandler);

    let response: Response;
    let rejectedToken: string | null = null;
    let rejectedAuthSessionVersion: AuthSessionVersion | undefined;
    try {
      const authorized = await this.withAuthorization(init);
      rejectedToken = authorized.token;
      rejectedAuthSessionVersion = authorized.authSessionVersion;
      response = await fetcher(url, authorized.requestInit);
    } catch (error) {
      if (isBrowserRequestConstructionError(error)) {
        throw new Error(
          "Could not send request. Your session may be invalid — try refreshing or signing in again.",
          { cause: error },
        );
      }
      throw error;
    }

    if (response.status === 401 && this.getAccessToken) {
      const refreshedToken = await this.refreshAccessToken(rejectedToken);
      if (refreshedToken) {
        let retryResponse: Response;
        try {
          const authorizedRetry = await this.withAuthorization(init, refreshedToken);
          rejectedToken = authorizedRetry.token;
          rejectedAuthSessionVersion = authorizedRetry.authSessionVersion;
          retryResponse = await fetcher(url, authorizedRetry.requestInit);
        } catch (error) {
          if (isBrowserRequestConstructionError(error)) {
            throw new Error(
              "Could not send request. Your session may be invalid — try refreshing or signing in again.",
              { cause: error },
            );
          }
          throw error;
        }
        if (retryResponse.status !== 401) {
          if (isFailure(retryResponse)) {
            const body = await responseBodyForError(retryResponse);
            throw new HttpError(
              messageFromErrorBody(body, retryResponse.statusText),
              retryResponse.status,
              body,
            );
          }
          return retryResponse;
        }
        response = retryResponse;
      }
    }

    if (response.status === 401) {
      const traceContext = traceContextFromResponse(response);
      let unauthorizedHandled = false;
      if (!skipUnauthorizedHandler && this.onUnauthorized) {
        await this.onUnauthorized({
          matchesRejectedToken: (candidate) =>
            sanitizeAccessToken(candidate) === rejectedToken,
          authSessionVersion: rejectedAuthSessionVersion,
          traceContext,
        });
        unauthorizedHandled = true;
      }
      const error = new HttpError("unauthorized", 401, null, {
        unauthorizedHandled,
        authSessionVersion: rejectedAuthSessionVersion,
        traceContext,
      });
      rejectedTokenByError.set(error, rejectedToken);
      throw error;
    }

    if (isFailure(response)) {
      const body = await responseBodyForError(response);
      throw new HttpError(
        messageFromErrorBody(body, response.statusText),
        response.status,
        body,
      );
    }

    return response;
  }

  async request<T>(path: string, init?: RequestInitWithFetch) {
    const response = await this.send(path, init);

    if (response.status === 204) {
      return null as T;
    }

    return response.json() as Promise<T>;
  }

  async requestRevalidated<T>(path: string, init?: RequestInitWithFetch): Promise<T> {
    if (!revalidationEnabled) return this.request<T>(path, init);
    const key = joinApiUrl(this.baseUrl, path);
    const cached = readRevalidationEntry(key);
    const headers = new Headers(init?.headers);
    if (cached) headers.set("If-None-Match", cached.etag);
    const response = await this.send(path, { ...init, headers });
    if (response.status === 304 && cached) return JSON.parse(cached.body) as T;
    const body = await response.text();
    writeRevalidationEntry(key, response.headers.get("etag"), body);
    return JSON.parse(body) as T;
  }

  async raw(path: string, init?: RequestInitWithFetch): Promise<RawHttpResponse> {
    const response = await this.send(path, init);
    return {
      response,
      blob: () => response.blob(),
      arrayBuffer: () => response.arrayBuffer(),
      text: () => response.text(),
      json: () => response.json(),
    };
  }

  async blob(path: string, init?: RequestInitWithFetch) {
    const raw = await this.raw(path, init);
    return raw.blob();
  }
}
