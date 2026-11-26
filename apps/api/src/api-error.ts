import { createLogger } from "@cohub/infra/logging";
import { applyTraceResponseHeaders, getActiveTraceIdentifiers, getOrCreateRequestId, setRequestContextAttributes } from "@cohub/infra/tracing";
import { trace } from "@opentelemetry/api";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

const logger = createLogger({ serviceName: "cohub-api" });
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

/** Client errors thrown as HTTPException keep their status; anything else is a logged 500. */
export function handleApiError(error: Error, c: Context) {
  if (error instanceof HTTPException && error.status < 500) return error.getResponse();
  const requestId: string = c.get("requestId") ?? getOrCreateRequestId(c.req.header("x-request-id"));
  const ids = getActiveTraceIdentifiers(requestId);
  setRequestContextAttributes(trace.getActiveSpan(), ids);
  applyTraceResponseHeaders(c.res.headers, ids);
  logger.error(`[API Error] ${c.req.method} ${c.req.path} requestId=${requestId} traceId=${ids.traceId ?? "none"}:`, serializeErrorForLog(error));
  return c.json({ message: "internal server error", requestId, traceId: ids.traceId }, 500);
}
