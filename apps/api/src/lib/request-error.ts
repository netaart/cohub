import type { Context } from "hono";
import type * as z from "zod";

export type RequestErrorStatus = 400 | 401 | 402 | 403 | 404 | 413 | 500 | 502 | 503;

export class RequestError extends Error {
  readonly status: RequestErrorStatus;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: RequestErrorStatus, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "RequestError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function requestErrorResponse(
  c: Context,
  status: RequestErrorStatus,
  code: string,
  message: string,
  details?: unknown,
) {
  return c.json({ error: { code, message, ...(details === undefined ? {} : { details }) }, message }, status);
}

export const requestErrorFrom = (c: Context, error: RequestError) =>
  requestErrorResponse(c, error.status, error.code, error.message, error.details);

export type ZodIssueDetail = {
  path: string;
  message: string;
  code: string;
};

export function zodIssueDetails(error: z.ZodError): ZodIssueDetail[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
    code: issue.code,
  }));
}

export function formatZodIssues(details: ZodIssueDetail[], limit = 3): string {
  if (details.length === 0) return "Invalid request.";
  const items = details.map((detail) => (detail.path ? `${detail.path}: ${detail.message}` : detail.message));
  const more = items.length > limit ? ` (+${items.length - limit} more)` : "";
  return `${items.slice(0, limit).join("; ")}${more}`;
}
