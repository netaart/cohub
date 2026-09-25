import "dotenv/config";
import "./tracing.js";
import { configureBillingRuntime } from "@cohub/billing";
import { createLogger } from "@cohub/infra/logging";
import { SPACE_HOOK_WEBHOOK_SECRET_HEADER } from "@cohub/protocol";
import { COHUB_SOURCE_HEADER_NAMES } from "@cohub/protocol/provenance";

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { trace } from "@opentelemetry/api";
import { cors } from "hono/cors";
import { getCookie } from "hono/cookie";
import { httpInstrumentationMiddleware } from "@hono/otel";

import { applyTraceResponseHeaders, getActiveTraceIdentifiers, getOrCreateRequestId, runWithRequestTraceContext, setRequestContextAttributes } from "@cohub/infra/tracing";
import { verifyUserAccessToken } from "@cohub/identity";

import { getTokenFromRequest, type AuthUserProfile, consumeExecutionAuthFromToken, type ExecutionAuthPrincipal } from "./auth.js";
import { describeUserAccessTokenFailure } from "./auth-failure.js";
import { recordAuthTrace } from "./auth-observability.js";
import { verifyPreviewSessionToken, type PreviewSessionPrincipal } from "./preview-sessions.js";
import { verifyAppSessionToken, type AppSessionPrincipal } from "./app-sessions.js";
import { assertRequiredConfig, config } from "./config.js";

import router from "./routes/index.js";
import { resolveRequestSourceTurn } from "./lib/request-source.js";
import type { RequestSource } from "@cohub/protocol/provenance";

const logger = createLogger({ serviceName: "cohub-api" });
// ── Hono app ─────────────────────────────────────────────────────────────────

const app = new Hono<{
  Variables: {
    token: string | null;
    authUser: AuthUserProfile | null;
    executionAuth: ExecutionAuthPrincipal | null;
    previewSession: PreviewSessionPrincipal | null;
    appSession: AppSessionPrincipal | null;
    principal: { type: "user"; user: AuthUserProfile } | { type: "execution"; execution: ExecutionAuthPrincipal } | { type: "preview_session"; previewSession: PreviewSessionPrincipal } | { type: "app_session"; appSession: AppSessionPrincipal } | null;
    requestId: string;
    traceId: string | null;
    /** Request provenance with the Turn a local harness could not name filled in. */
    requestSource: RequestSource | null;
  };
}>();

app.use(
  "*",
  httpInstrumentationMiddleware({
    serviceName: "cohub-api",
    serviceVersion: process.env.IMAGE_TAG ?? "latest",
  }),
);

app.use(async (c, next) => {
  const requestId = getOrCreateRequestId(c.req.header("x-request-id"));
  c.set("requestId", requestId);
  await runWithRequestTraceContext({ requestId }, next);
  const ids = getActiveTraceIdentifiers(requestId);
  c.set("traceId", ids.traceId);
  setRequestContextAttributes(trace.getActiveSpan(), ids);
  applyTraceResponseHeaders(c.res.headers, ids);
});

app.use(
  cors({
    origin: (origin) => origin || "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Git-Token",
      "X-Request-Id",
      SPACE_HOOK_WEBHOOK_SECRET_HEADER,
      // Derived, so a new provenance header cannot be added without being allowed
      // here — a missing one fails every cross-origin browser request.
      ...COHUB_SOURCE_HEADER_NAMES,
      "Traceparent",
      "Tracestate",
      "Baggage",
      "Sentry-Trace",
    ],
    exposeHeaders: ["X-Request-Id", "X-Trace-Id", "X-Span-Id", "Traceparent", "Tracestate", "Baggage", "Sentry-Trace"],
    credentials: true,
  }),
);

const PREVIEW_SESSION_COOKIE = "__preview_session";

const isPreviewHost = (host: string | undefined) => {
  const normalized = host?.split(":")[0]?.toLowerCase();
  return Boolean(
    normalized && config.previewHostnames.some((hostname) => normalized === hostname),
  );
};

app.use(async (c, next) => {
  const onPreviewHost = isPreviewHost(c.req.header("host"));
  const previewQueryToken =
    onPreviewHost && c.req.path.startsWith("/s/")
      ? c.req.query("token")?.trim() || null
      : null;
  const token =
    getTokenFromRequest(c) ??
    previewQueryToken ??
    (onPreviewHost ? getCookie(c, PREVIEW_SESSION_COOKIE) ?? null : null);
  c.set("token", token);
  c.set("authUser", null);
  c.set("executionAuth", null);
  c.set("previewSession", null);
  c.set("appSession", null);
  c.set("principal", null);

  if (token) {
    const executionAuth = await consumeExecutionAuthFromToken(token).catch((error) => {
      logger.warn("[API] Failed to verify execution token:", error);
      return null;
    });
    if (executionAuth) {
      c.set("executionAuth", executionAuth);
      c.set("principal", { type: "execution", execution: executionAuth });
      recordAuthTrace(trace.getActiveSpan(), {
        credentialPresent: true,
        principalType: "execution",
        outcome: "authenticated",
      });
      await next();
      return;
    }

    if (onPreviewHost) {
      const previewSession = verifyPreviewSessionToken(token);
      if (previewSession) {
        c.set("previewSession", previewSession);
        c.set("principal", { type: "preview_session", previewSession });
        recordAuthTrace(trace.getActiveSpan(), {
          credentialPresent: true,
          principalType: "preview_session",
          outcome: "authenticated",
        });
        await next();
        return;
      }
    }

    const appSession = verifyAppSessionToken(token);
    if (appSession) {
      c.set("appSession", appSession);
      c.set("principal", { type: "app_session", appSession });
      recordAuthTrace(trace.getActiveSpan(), {
        credentialPresent: true,
        principalType: "app_session",
        outcome: "authenticated",
      });
      await next();
      return;
    }

    try {
      const authUser = await verifyUserAccessToken({ token, logtoEndpoint: config.logtoEndpoint });
      c.set("authUser", authUser);
      c.set("principal", { type: "user", user: authUser });
    } catch (error) {
      const failure = describeUserAccessTokenFailure(error);
      const authFailureMeta = {
        auth_failure_reason: failure.reason,
        ...(failure.claim ? { auth_failure_claim: failure.claim } : {}),
        http_method: c.req.method,
      };

      if (failure.reason === "jwt_expired") {
        logger.debug("User access token verification failed", authFailureMeta);
      } else if (
        failure.reason === "jwks_timeout" ||
        failure.reason === "jwks_unavailable" ||
        failure.reason === "jwks_invalid" ||
        failure.reason === "jwt_signing_key_not_found" ||
        failure.reason === "jwt_signing_key_ambiguous"
      ) {
        logger.warn("User access token verification failed", authFailureMeta);
      } else {
        logger.info("User access token verification failed", authFailureMeta);
      }
      recordAuthTrace(trace.getActiveSpan(), {
        credentialPresent: true,
        principalType: "anonymous",
        outcome: "rejected",
        failureCategory: "invalid_user_token",
      });
      return c.json({ message: "unauthorized" }, 401);
    }

    recordAuthTrace(trace.getActiveSpan(), {
      credentialPresent: true,
      principalType: "user",
      outcome: "authenticated",
    });
  } else {
    recordAuthTrace(trace.getActiveSpan(), {
      credentialPresent: false,
      principalType: "anonymous",
      outcome: "anonymous",
    });
  }

  await next();
});

app.use(resolveRequestSourceTurn);

app.route("/", router);

const ERROR_LOG_FIELDS = ["code", "detail", "hint", "position", "constraint", "table", "column", "schema"] as const;

const serializeErrorForLog = (error: unknown): unknown => {
  if (error instanceof Error) {
    const record = error as Error & Record<string, unknown>;
    const fields = Object.fromEntries(ERROR_LOG_FIELDS.flatMap((key) => {
      const value = record[key];
      return value === undefined ? [] : [[key, value]];
    }));
    return {
      message: error.message,
      stack: error.stack,
      name: error.name,
      ...fields,
      cause: serializeErrorForLog(error.cause),
    };
  }
  if (error === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(error));
  } catch {
    return String(error);
  }
};

app.notFound((c) => c.json({ message: "not found" }, 404));

app.onError((error, c) => {
  const requestId = c.get("requestId") ?? getOrCreateRequestId(c.req.header("x-request-id"));
  const ids = getActiveTraceIdentifiers(requestId);
  setRequestContextAttributes(trace.getActiveSpan(), ids);
  applyTraceResponseHeaders(c.res.headers, ids);

  const path = c.req.path;
  const method = c.req.method;
  logger.error(`[API Error] ${method} ${path} requestId=${requestId} traceId=${ids.traceId ?? "none"}:`, serializeErrorForLog(error));
  return c.json({ message: "internal server error", requestId, traceId: ids.traceId }, 500);
});

// ── Start server ─────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 8787);
assertRequiredConfig();
configureBillingRuntime({
  config,
  redis: (await import("./redis.js")).redisCommandClient,
});
const server = serve({
  fetch: app.fetch,
  port,
  serverOptions: {
    requestTimeout: 0,
    keepAliveTimeout: 75_000,
  },
});
server.setTimeout(0);
logger.info(`@cohub/api listening on :${port}`);
