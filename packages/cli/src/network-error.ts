const text = (value: unknown) => (typeof value === "string" && value ? value : null);

export const isFetchFailure = (error: unknown): error is Error =>
  error instanceof Error && error.message === "fetch failed";

export function fetchFailureReason(error: unknown): string | null {
  if (!isFetchFailure(error) || typeof error.cause !== "object" || !error.cause) return null;
  const cause = error.cause as Record<string, unknown>;
  const message = text(cause.message);
  const code = text(cause.code);
  const hostname = text(cause.hostname);
  const parts = [
    code && !message?.includes(code) ? code : null,
    hostname && !message?.includes(hostname) ? `host: ${hostname}` : null,
    message,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const reason = fetchFailureReason(error);
  return reason ? `${error.message} (${reason})` : error.message;
}
